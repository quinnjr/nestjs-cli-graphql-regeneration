import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { EmitRequest, EmitSuccess, EmitFailure, PAYLOAD_FD } from './protocol';

// The child always loads compiled JavaScript, so child.js must exist as a real
// file on disk. Post-build, this module runs as dist/emitter/spawn.js with
// dist/emitter/child.js right beside it. Under ts-jest, though, this module
// runs straight from src/emitter/spawn.ts — __dirname is src/emitter, where
// child.ts has no .js sibling — so also try the compiled output one level up.
// Mirrors the try-each-candidate-path pattern in ../config/dist-layout.ts
// (findDistFile/resolveDistFile) — a different dual-candidate list (this
// module's own source-vs-compiled location, not that module's flat-vs-nested
// dist/ layout), but the same "probe existsSync over an ordered list" shape.
//
// `NEST_GRAPHQL_CHILD_ENTRY` overrides both candidates. It exists so tests can
// exercise the missing-entry and malformed-payload branches against a throwaway
// file of their own, instead of renaming or overwriting the shared, real
// dist/emitter/child.js in place: those tests restored it in a `finally`, but a
// timeout, an abort or a crash between the two halves left dist/ corrupted, and
// a later bare `jest` would then run silently against the stub.
function resolveChildEntry(explicit = process.env.NEST_GRAPHQL_CHILD_ENTRY): string {
  const candidates = explicit
    ? [explicit]
    : [
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

// How the child ended, in a form fit to appear inside an error message.
//
// Without this, the two "the payload was unusable" rejections below described
// only the *absence* of output, never the cause: an OOM kill (SIGKILL from the
// kernel, no stderr, no payload) and a child that merely wrote nothing produced
// byte-identical errors. The exit code or signal is the only signal that
// distinguishes them, and Node hands it to the 'close' listener for free.
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `killed by signal ${signal}`;
  if (code !== null) return `exited with code ${code}`;
  return 'exit status unknown';
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
        // stdin ignored; stdout *inherited*; stderr piped; payload on its own
        // descriptor. Inheriting stdout is the point of the dedicated
        // descriptor (see ./protocol.ts): the child shares stdout with the
        // user's app module and preview boot, so anything it logs now reaches
        // the terminal instead of corrupting — and being swallowed by — the
        // result payload.
        stdio: ['ignore', 'inherit', 'pipe', 'pipe'],
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

    let payload = '';
    let stderr = '';

    // setEncoding, *not* `chunk.toString()` per chunk. A pipe hands over
    // arbitrary byte boundaries, so a multi-byte UTF-8 sequence routinely
    // straddles two chunks; decoding each chunk independently turns the split
    // sequence into U+FFFD replacement characters. That corruption is silent —
    // the JSON still parses, so the mangled SDL reaches the written schema
    // file. Measured: 8 replacement characters in a 200 KB non-ASCII payload.
    // setEncoding installs a StringDecoder that holds the incomplete tail bytes
    // back until the next chunk completes them.
    const payloadStream = child.stdio[PAYLOAD_FD] as NodeJS.ReadableStream | undefined;
    if (payloadStream) {
      payloadStream.setEncoding('utf8');
      payloadStream.on('data', (d) => (payload += d));
    }

    const stderrStream = child.stderr;
    if (stderrStream) {
      stderrStream.setEncoding('utf8');
      stderrStream.on('data', (d) => (stderr += d));
    }

    // 'close' (not 'exit') fires only once every piped stdio stream has also
    // closed, so the payload is complete by the time this runs.
    child.on('close', (code, signal) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.trim());
      } catch {
        reject(
          new Error(
            `Emitter produced no usable output (${describeExit(code, signal)}).\n${stderr}`,
          ),
        );
        return;
      }
      if (!isEmitResult(parsed)) {
        reject(
          new Error(
            `Emitter produced unexpected output (${describeExit(code, signal)}): ` +
              `${payload.trim()}\n${stderr}`,
          ),
        );
        return;
      }
      if (parsed.ok) {
        resolve(parsed);
        return;
      }
      // The child reports its stack; keep it. A stack synthesised here points
      // at this `close` handler, which says nothing about what went wrong
      // inside the child's preview boot.
      const error = new Error(parsed.message);
      if (parsed.stack) error.stack = parsed.stack;
      reject(error);
    });
  });
}
