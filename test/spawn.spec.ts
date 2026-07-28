import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  renameSync,
} from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { spawnEmitter } from '../src/emitter/spawn';
import { resolveDistFile } from '../src/config/dist-layout';
import { APP_MODULE_BASENAME } from '../src/config/resolve';

// dist/emitter/child.js is the real compiled entry spawn.ts locates at
// runtime (see spawn.ts's resolveChildEntry). A couple of tests below
// temporarily rename or overwrite it in place to exercise failure paths that
// can't otherwise be triggered through the public EmitRequest surface. Safe
// because Jest runs the `it` blocks in this file sequentially, and no other
// spec file calls spawnEmitter / depends on this file mid-run.
const REAL_CHILD_JS = path.join(__dirname, '..', 'dist', 'emitter', 'child.js');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GRAPHQL_CONFIG_JS =
  `module.exports.schemas = { default: { autoSchemaFile: 'src/schema.gql', sortSchema: true } };`;

describe('spawnEmitter', () => {
  it('returns SDL from a child process', async () => {
    const dir = tempDir('gqlspawn-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const result = await spawnEmitter({
      projectRoot: process.cwd(),
      distRoot,
      appModulePath: path.join(distRoot, 'basic', 'app.module.js'),
      schemaName: 'default',
    });

    expect(result.ok).toBe(true);
    expect(result.sdl).toContain('type Recipe');
    expect(result.outFile).toBe('src/schema.gql');
  });

  it('is not confused by user code logging to stdout before the payload', async () => {
    // The failure this protects against is silent and total: the emitter
    // shares stdout with `require(appModulePath)` and the whole preview boot,
    // so one config banner, dotenv debug line or ORM deprecation notice at
    // require time used to turn a correct schema into
    // "Emitter produced no usable output."
    const dir = tempDir('gqlspawn-noisy-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    // A module that chatters on stdout at require time, then re-exports the
    // real app module — the exact shape of a noisy dependency.
    const noisyModulePath = path.join(distRoot, 'noisy-app.module.js');
    writeFileSync(
      noisyModulePath,
      `console.log('[db] connected to postgres://localhost:5432');\n` +
        `console.log(JSON.stringify({ ok: true, sdl: 'IMPOSTOR', outFile: 'nope.gql' }));\n` +
        `process.stdout.write('trailing chatter with no newline');\n` +
        `module.exports = require('./basic/app.module');\n`,
    );

    const result = await spawnEmitter({
      projectRoot: process.cwd(),
      distRoot,
      appModulePath: noisyModulePath,
      schemaName: 'default',
    });

    expect(result.ok).toBe(true);
    expect(result.sdl).toContain('type Recipe');
    // Specifically: a well-formed impostor payload on stdout must not be able
    // to impersonate the real one.
    expect(result.sdl).not.toContain('IMPOSTOR');
    expect(result.outFile).toBe('src/schema.gql');
  });

  it('composes the nested dist/src/ layout: config and app module both under src/', async () => {
    const dir = tempDir('gqlspawn-nested-');
    const distRoot = path.join(dir, 'dist');
    const nested = path.join(distRoot, 'src');
    mkdirSync(nested, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), nested, { recursive: true });
    // Candidate #2 for the config...
    writeFileSync(path.join(nested, 'graphql.config.js'), GRAPHQL_CONFIG_JS);
    // ...and candidate #2 for the app module, resolved through the same helper
    // regenerate/index.ts uses, so this proves the two halves agree.
    writeFileSync(
      path.join(nested, 'app.module.js'),
      `module.exports = require('./basic/app.module');\n`,
    );

    const result = await spawnEmitter({
      projectRoot: process.cwd(),
      distRoot,
      appModulePath: resolveDistFile(distRoot, APP_MODULE_BASENAME),
      schemaName: 'default',
    });

    expect(result.sdl).toContain('type Recipe');
  });

  it('surfaces the child error message on failure', async () => {
    await expect(
      spawnEmitter({
        projectRoot: process.cwd(),
        distRoot: '/nonexistent',
        appModulePath: '/nonexistent/app.module.js',
        schemaName: 'default',
      }),
    ).rejects.toThrow(/graphql\.config\.js|Cannot find module/);
  });

  it('rejects rather than crashing the parent when the child fails to spawn', async () => {
    // A nonexistent cwd makes the underlying spawn() call itself fail: Node
    // emits 'error' on the ChildProcess before it ever starts. Confirmed by
    // hand that, without an 'error' listener, this is an *unhandled* 'error'
    // event — which throws and takes down the process emitting it (here,
    // the test process itself) rather than merely failing this one test.
    const projectRoot = path.join(tmpdir(), `gqlspawn-unspawnable-${Date.now()}`);

    await expect(
      spawnEmitter({
        projectRoot,
        distRoot: path.join(projectRoot, 'dist'),
        appModulePath: path.join(projectRoot, 'dist', 'app.module.js'),
        schemaName: 'default',
      }),
    ).rejects.toThrow(/spawn|ENOENT/i);
  });

  it('does not truncate a large error payload from the child', async () => {
    // Regression test: process.exit() right after process.stdout.write() does
    // not wait for the (asynchronous, piped) write to flush, so a large
    // err.stack — plausible for a deep Nest DI failure — could be cut off.
    // Confirmed by hand that a 5,000,000-char payload written this way and
    // immediately followed by process.exit(1) reliably truncates around
    // ~146KB over a real OS pipe; child.ts now uses process.exitCode instead
    // and lets the process end naturally once the write drains.
    const dir = tempDir('gqlspawn-large-error-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const bigMessage = 'X'.repeat(5_000_000);
    const bigModulePath = path.join(distRoot, 'large-error.js');
    writeFileSync(bigModulePath, `throw new Error(${JSON.stringify(bigMessage)});`);

    let caught: Error | undefined;
    try {
      await spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: bigModulePath,
        schemaName: 'default',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toBe(bigMessage);
  });

  it('attaches the child\'s stack to the rejected error', async () => {
    // EmitFailure has carried `stack` since the protocol was written and the
    // child has always populated it, but the parent used to drop it on the
    // floor -- discarding the only stack that describes what actually failed
    // inside the child's preview boot. The large-payload test above exists
    // precisely to keep a deep Nest DI stack intact in transit; that is
    // pointless if it is then thrown away on arrival.
    const dir = tempDir('gqlspawn-stack-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const throwingModulePath = path.join(distRoot, 'thrower.js');
    writeFileSync(
      throwingModulePath,
      `function deepFrameForTheStack() { throw new Error('boom from the child'); }\n` +
        `deepFrameForTheStack();\n`,
    );

    let caught: Error | undefined;
    try {
      await spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: throwingModulePath,
        schemaName: 'default',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toBe('boom from the child');
    expect(caught!.stack).toContain('deepFrameForTheStack');
    expect(caught!.stack).toContain('thrower.js');
  });

  it('surfaces a clear error when the child dies without producing usable output', async () => {
    // Exercises the branch that exists precisely for cases like
    // @nestjs/common's loadPackage calling process.exit(1) directly: some
    // code reachable from the required app module exits before ever writing
    // JSON to stdout. A raw process.exit() at require-time reproduces that
    // shape without needing real Nest internals.
    const dir = tempDir('gqlspawn-no-output-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const explodingModulePath = path.join(distRoot, 'exit-before-output.js');
    writeFileSync(explodingModulePath, `process.exit(1);\n`);

    await expect(
      spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: explodingModulePath,
        schemaName: 'default',
      }),
    ).rejects.toThrow(/produced no usable output/i);
  });

  it('resolves a module that is reachable only via NODE_PATH', async () => {
    // Proves the NODE_PATH fallback mechanism itself works, independent of
    // its (unproven) precedence relative to the ordinary ancestor walk: the
    // marker package below lives only under a fake project root's
    // node_modules, and the "app module" that requires it lives in a wholly
    // unrelated directory tree, so the ordinary node_modules ancestor walk
    // from the app module's own location can never reach it. The only way
    // this resolves is via NODE_PATH, which spawnEmitter sets to
    // <projectRoot>/node_modules.
    const projectRoot = tempDir('gqlspawn-nodepath-project-');
    const markerDir = path.join(projectRoot, 'node_modules', 'only-via-nodepath-marker');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      path.join(markerDir, 'package.json'),
      JSON.stringify({ name: 'only-via-nodepath-marker', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(path.join(markerDir, 'index.js'), `module.exports = 'FOUND_VIA_NODE_PATH';`);
    // spawnEmitter always preloads `-r reflect-metadata`, resolved the same
    // way as any other bare specifier (via NODE_PATH, since projectRoot here
    // has no ordinary ancestor chain to our repo). Give this fake project its
    // own copy so that preload doesn't fail before the probe module even runs.
    cpSync(
      path.join(__dirname, '..', 'node_modules', 'reflect-metadata'),
      path.join(projectRoot, 'node_modules', 'reflect-metadata'),
      { recursive: true },
    );

    const otherDir = tempDir('gqlspawn-unrelated-');
    const distRoot = path.join(otherDir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const probeModulePath = path.join(distRoot, 'nodepath-probe.js');
    writeFileSync(
      probeModulePath,
      `throw new Error('MARKER:' + require('only-via-nodepath-marker'));`,
    );

    await expect(
      spawnEmitter({
        projectRoot,
        distRoot,
        appModulePath: probeModulePath,
        schemaName: 'default',
      }),
    ).rejects.toThrow('MARKER:FOUND_VIA_NODE_PATH');
  });

  it('rejects rather than throws when the compiled child entry is missing', async () => {
    const movedAside = `${REAL_CHILD_JS}.moved-for-test`;
    renameSync(REAL_CHILD_JS, movedAside);
    try {
      await expect(
        spawnEmitter({
          projectRoot: process.cwd(),
          distRoot: '/nonexistent',
          appModulePath: '/nonexistent/app.module.js',
          schemaName: 'default',
        }),
      ).rejects.toThrow(/Could not find the compiled emitter child entry/);
    } finally {
      renameSync(movedAside, REAL_CHILD_JS);
    }
  });

  it('surfaces a clear error for parseable-but-wrong-shaped child output', async () => {
    const backup = readFileSync(REAL_CHILD_JS, 'utf8');
    // Writes to the dedicated payload descriptor, not stdout: the result
    // payload moved off stdout so a `console.log` in user code can no longer
    // corrupt it (see src/emitter/protocol.ts). A stub emulating the child
    // has to emulate the protocol it actually speaks — on stdout this blob
    // would now be indistinguishable from ordinary user output, which is
    // precisely the property the move buys.
    writeFileSync(
      REAL_CHILD_JS,
      `require('fs').writeSync(3, JSON.stringify({ unexpected: 'shape' }));\n`,
    );
    try {
      let caught: Error | undefined;
      try {
        await spawnEmitter({
          projectRoot: process.cwd(),
          distRoot: '/nonexistent',
          appModulePath: '/nonexistent/app.module.js',
          schemaName: 'default',
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).not.toBe('undefined');
      expect(caught!.message).toMatch(/unexpected output/i);
    } finally {
      writeFileSync(REAL_CHILD_JS, backup);
    }
  });
});
