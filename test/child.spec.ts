import { spawn } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { PAYLOAD_FD } from '../src/emitter/protocol';

/**
 * Direct tests of the emitter child entry's *exit* behaviour — the two things
 * that decide whether a user sees anything at all when something goes wrong,
 * given that `nest g` always exits 0 even when a schematic throws:
 *
 *  - a non-`Error` throw from the user's app module must still produce a
 *    payload the parent accepts, and
 *  - the child must exit even when the app module leaves the event loop busy.
 *
 * These spawn the child directly rather than through `spawnEmitter` — and
 * against a *snapshot* of `dist`, not the live one — because
 * `test/spawn.spec.ts` temporarily renames and overwrites the real
 * `dist/emitter/child.js` in place, and Jest runs spec files in parallel
 * workers.
 */

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE_APP_MODULE = path.join(__dirname, 'fixtures-dist', 'basic', 'app.module.js');
const GRAPHQL_CONFIG_JS =
  `module.exports.schemas = { default: { autoSchemaFile: 'src/schema.gql', sortSchema: true } };`;

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let childEntry: string;

beforeAll(() => {
  // Copy the whole compiled tree, since child.js requires its siblings
  // relatively. `spawn.spec.ts`'s in-place mutations of the real child.js are
  // transient and always restored in a `finally`, so a content check plus a
  // retry makes this snapshot deterministic rather than merely likely.
  const dest = path.join(tempDir('gqlchild-dist-'), 'dist');
  const source = path.join(REPO_ROOT, 'dist');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      rmSync(dest, { recursive: true, force: true });
      cpSync(source, dest, { recursive: true });
      const copied = readFileSync(path.join(dest, 'emitter', 'child.js'), 'utf8');
      // Markers only the real child carries; a renamed-away or stubbed-out
      // child.js fails one of them.
      if (copied.includes('writePayload') && copied.includes('buildSdl')) {
        childEntry = path.join(dest, 'emitter', 'child.js');
        return;
      }
    } catch {
      // Mid-rename: fall through and retry.
    }
    sleepSync(20);
  }
  throw new Error(
    `Could not snapshot a pristine ${path.join(source, 'emitter', 'child.js')}. ` +
      `Run "pnpm build" first.`,
  );
});

interface ChildRun {
  payload: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function runChild(
  req: { projectRoot: string; distRoot: string; appModulePath: string; schemaName: string },
  timeoutMs = 30_000,
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-r', 'reflect-metadata', childEntry, JSON.stringify(req)],
      {
        cwd: REPO_ROOT,
        // Same shape ../src/emitter/spawn.ts uses: payload on its own
        // descriptor, stderr piped, stdout discarded.
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_PATH: path.join(REPO_ROOT, 'node_modules') },
      },
    );

    let payload = '';
    let stderr = '';
    let timedOut = false;

    (child.stdio[PAYLOAD_FD] as NodeJS.ReadableStream).on('data', (d) => (payload += d.toString()));
    child.stderr!.on('data', (d) => (stderr += d.toString()));

    // A child that never exits is exactly the regression under test, so bound
    // the wait rather than letting Jest's own timeout swallow the diagnosis.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ payload, stderr, code, signal, timedOut });
    });
  });
}

/** A dist root with a valid config and an app module written from `source`. */
function scaffold(prefix: string, source: string): { distRoot: string; appModulePath: string } {
  const distRoot = path.join(tempDir(prefix), 'dist');
  mkdirSync(distRoot, { recursive: true });
  writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);
  const appModulePath = path.join(distRoot, 'app.module.js');
  writeFileSync(appModulePath, source);
  return { distRoot, appModulePath };
}

/**
 * The parent's own acceptance test (`isEmitResult` in
 * ../src/emitter/spawn.ts): a payload that does not satisfy this is rejected
 * as "unexpected output" no matter what it contains.
 */
function parseAsParentWould(payload: string): Record<string, unknown> {
  const parsed = JSON.parse(payload.trim()) as Record<string, unknown>;
  expect(typeof parsed).toBe('object');
  if (parsed.ok === false) expect(typeof parsed.message).toBe('string');
  return parsed;
}

describe('emitter child: non-Error throws from the app module', () => {
  it('keeps the message of a thrown string', async () => {
    // `require(appModulePath)` runs the user's module scope unguarded, so
    // `throw 'a string'` is reachable. Reading `.message` off it yields
    // undefined, JSON.stringify drops undefined keys, and the payload
    // collapses to {"ok":false} — which the parent rejects as malformed, so
    // the user is shown a generic failure that looks like a bug in this
    // package instead of their own throw.
    const { distRoot, appModulePath } = scaffold(
      'gqlchild-string-throw-',
      `throw 'app module refused to load: DATABASE_URL is unset';\n`,
    );

    const run = await runChild({
      projectRoot: REPO_ROOT,
      distRoot,
      appModulePath,
      schemaName: 'default',
    });

    expect(run.timedOut).toBe(false);
    const parsed = parseAsParentWould(run.payload);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toBe('app module refused to load: DATABASE_URL is unset');
    expect(run.code).toBe(1);
  });

  it('still produces a usable payload when the app module throws null', async () => {
    // `throw null` additionally used to make the stderr fallback re-throw the
    // same value while handling it.
    const { distRoot, appModulePath } = scaffold(
      'gqlchild-null-throw-',
      `throw null;\n`,
    );

    const run = await runChild({
      projectRoot: REPO_ROOT,
      distRoot,
      appModulePath,
      schemaName: 'default',
    });

    expect(run.timedOut).toBe(false);
    const parsed = parseAsParentWould(run.payload);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toBe('null');
    expect(run.code).toBe(1);
    // No secondary crash while reporting the first one.
    expect(run.signal).toBeNull();
    expect(run.stderr).not.toMatch(/TypeError/);
  });
});

describe('emitter child: exit', () => {
  it('exits after a successful emit even if the app module holds the event loop open', async () => {
    // Anything the app module opens at import time — a setInterval, an eager
    // DB client, a file watcher — keeps the process alive after main()
    // resolves. The parent settles on 'close', so a child that lingers is a
    // `nest g` that hangs forever with no output at all.
    const { distRoot, appModulePath } = scaffold(
      'gqlchild-busy-loop-',
      `setInterval(() => {}, 1000);\n` +
        `module.exports = require(${JSON.stringify(FIXTURE_APP_MODULE)});\n`,
    );

    const run = await runChild(
      { projectRoot: REPO_ROOT, distRoot, appModulePath, schemaName: 'default' },
      30_000,
    );

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    // The payload is complete, not truncated by the exit.
    const parsed = parseAsParentWould(run.payload);
    expect(parsed.ok).toBe(true);
    expect(parsed.sdl).toContain('type Recipe');
    expect(parsed.outFile).toBe('src/schema.gql');
  });

  it('exits after a failed emit even if the app module holds the event loop open', async () => {
    const { distRoot, appModulePath } = scaffold(
      'gqlchild-busy-loop-fail-',
      `setInterval(() => {}, 1000);\n` +
        `throw new Error('boom after starting a timer');\n`,
    );

    const run = await runChild(
      { projectRoot: REPO_ROOT, distRoot, appModulePath, schemaName: 'default' },
      30_000,
    );

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(1);
    const parsed = parseAsParentWould(run.payload);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toBe('boom after starting a timer');
    expect(String(parsed.stack)).toContain('app.module.js');
  });
});
