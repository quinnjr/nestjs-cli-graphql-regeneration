import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { EmitRequest, EmitSuccess, EmitFailure } from './protocol';

export { EmitRequest, EmitSuccess, EmitFailure };

// The child always loads compiled JavaScript, so child.js must exist as a real
// file on disk. Post-build, this module runs as dist/emitter/spawn.js with
// dist/emitter/child.js right beside it. Under ts-jest, though, this module
// runs straight from src/emitter/spawn.ts — __dirname is src/emitter, where
// child.ts has no .js sibling — so also try the compiled output one level up.
// Mirrors the dual-candidate-path pattern in ../config/resolve.ts.
function resolveChildEntry(): string {
  const candidates = [
    path.join(__dirname, 'child.js'),
    path.join(__dirname, '..', '..', 'dist', 'emitter', 'child.js'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `Could not find the compiled emitter child entry. Looked in:\n` +
        candidates.map((c) => `  - ${c}`).join('\n') +
        `\nRun "pnpm build" first.`,
    );
  }
  return found;
}

// Guards against a parseable-but-wrong-shaped blob silently producing
// `reject(new Error(undefined))` — i.e. a rejection whose message is the
// literal string "undefined".
function isEmitResult(x: unknown): x is EmitSuccess | EmitFailure {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (r.ok === true) return typeof r.sdl === 'string' && typeof r.outFile === 'string';
  if (r.ok === false) return typeof r.message === 'string';
  return false;
}

export function spawnEmitter(req: EmitRequest): Promise<EmitSuccess> {
  // Resolving the child entry can throw (see resolveChildEntry above). Doing
  // that inside the executor — rather than before `return new Promise(...)` —
  // matters: a synchronous throw from a Promise executor is automatically
  // turned into a rejection by the Promise constructor itself, so callers
  // chaining `.catch()` off spawnEmitter() always see a rejection, never an
  // exception, honoring the documented `Promise<EmitSuccess>` contract.
  return new Promise((resolve, reject) => {
    const childEntry = resolveChildEntry();

    const child = spawn(
      process.execPath,
      ['-r', 'reflect-metadata', childEntry, JSON.stringify(req)],
      {
        cwd: req.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_PATH: path.join(req.projectRoot, 'node_modules'),
        },
      },
    );

    // If the child never launches at all (EACCES, ENOENT on cwd, resource
    // exhaustion, ...), Node emits 'error' on the ChildProcess. Without a
    // listener, an unhandled 'error' event throws and crashes *this*
    // process — exactly the blast-containment failure this task exists to
    // prevent. 'error' is also not guaranteed to be followed by 'close', so
    // the JSON-parse fallback below cannot be relied on to catch this case.
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn emitter child process: ${err.message}`));
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`Emitter produced no usable output.\n${stderr || stdout}`));
        return;
      }
      if (!isEmitResult(parsed)) {
        reject(
          new Error(`Emitter produced unexpected output: ${stdout.trim()}\n${stderr}`),
        );
        return;
      }
      if (parsed.ok) resolve(parsed);
      else reject(new Error(parsed.message));
    });
  });
}
