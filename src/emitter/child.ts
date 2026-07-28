import { existsSync, writeSync } from 'fs';
import * as path from 'path';
import { buildSdl, buildSdlOptionsFrom } from './build';
import { resolveConfig, resolveOutFile } from '../config/resolve';
import { EmitFailure, EmitRequest, EmitSuccess, PAYLOAD_FD } from './protocol';

function loadDotEnv(projectRoot: string): void {
  const envPath = path.join(projectRoot, '.env');
  if (!existsSync(envPath)) return;
  try {
    const dotenvPath = require.resolve('dotenv', { paths: [projectRoot] });
    require(dotenvPath).config({ path: envPath });
  } catch {
    // dotenv is not installed in the target project; proceed without it.
  }
}

/**
 * NODE_PATH (set by spawn.ts to <projectRoot>/node_modules) is consulted by
 * Node's module resolver only as a last resort, *after* the ordinary
 * node_modules ancestor walk from the requiring file's own location. That
 * walk always wins when it succeeds, so NODE_PATH is fallback resolution,
 * not override precedence: it cannot rescue a case where the ordinary walk
 * finds a *different* @nestjs/core before ever reaching NODE_PATH (e.g. a
 * globally-installed copy of this CLI whose own ancestor chain happens to
 * resolve a bundled/hoisted @nestjs/core ahead of the user's project copy).
 *
 * We can't change precedence after the fact without a real architectural
 * fix, but we can make a silent divergence visible — same philosophy as
 * ../emitter/preview.ts's suppression warning. Compare the ambient
 * resolution (what this process will actually use) against a resolution
 * explicitly scoped to start at the target project, and warn on stderr if
 * they disagree.
 */
function warnIfVersionIsolationDiverges(projectRoot: string): void {
  const resolve = (opts?: { paths: string[] }): string | undefined => {
    try {
      return opts ? require.resolve('@nestjs/core', opts) : require.resolve('@nestjs/core');
    } catch {
      return undefined;
    }
  };

  const ambient = resolve();
  const scoped = resolve({ paths: [projectRoot] });

  if (ambient !== scoped) {
    process.stderr.write(
      `[nest-graphql] warning: @nestjs/core resolves to different locations depending ` +
        `on how it's looked up. This process will actually use the ambient resolution: ` +
        `${ambient ?? '<not found>'}. Resolution scoped to the target project ` +
        `(${projectRoot}) finds: ${scoped ?? '<not found>'}. If these differ, the schema ` +
        `may be built against the wrong @nestjs/core version — install this tool locally ` +
        `in the target project rather than globally to avoid this.\n`,
    );
  }
}

/**
 * Write the result payload to the dedicated payload descriptor (see
 * ../emitter/protocol.ts) rather than stdout.
 *
 * `writeSync` in a loop, not a stream: the descriptor is a plain inherited
 * pipe, and this has to complete before the process ends. The previous
 * stdout-based implementation had to lean on `process.exitCode` (rather than
 * `process.exit()`) so an asynchronous multi-megabyte write could drain — a
 * synchronous write removes that hazard entirely instead of managing it.
 * Partial writes are looped over because `write(2)` may return short.
 *
 * That property is what lets the exit handlers below call `process.exit()`
 * outright: when this function returns, every byte has been handed to the
 * kernel (`fs.writeSync` is a direct `write(2)`, and the loop only ends once
 * `offset === buf.length`), and bytes already in a pipe stay readable by the
 * parent after the writer exits. Nothing is left pending to be lost.
 */
function writePayload(payload: EmitSuccess | EmitFailure): void {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(PAYLOAD_FD, buf, offset, buf.length - offset);
    } catch (err) {
      // The descriptor is blocking when spawned by ../emitter/spawn.ts, but
      // do not assume it: retry rather than lose the payload.
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw err;
    }
  }
}

async function main(): Promise<void> {
  const req: EmitRequest = JSON.parse(process.argv[2]);

  loadDotEnv(req.projectRoot);
  warnIfVersionIsolationDiverges(req.projectRoot);

  const config = resolveConfig(req.distRoot, req.schemaName);

  // Resolve the output path *before* the (far slower, far more failure-prone)
  // preview boot: a config that names no output file can never produce a
  // useful result, so say so immediately instead of after a full build.
  const outFile = resolveOutFile(config.autoSchemaFile, req.schemaName);

  const mod = require(req.appModulePath);
  const AppModule = mod.AppModule ?? mod.default;
  if (!AppModule) {
    throw new Error(`${req.appModulePath} does not export AppModule.`);
  }

  const sdl = await buildSdl(AppModule, buildSdlOptionsFrom(config));

  writePayload({ ok: true, sdl, outFile });
}

main().then(
  () => {
    // Exit explicitly rather than waiting for the event loop to empty. The
    // payload write above is a *completed* synchronous write (see
    // writePayload), so there is nothing pending to flush — while anything
    // the user's app module started at import time (a `setInterval`, an
    // eagerly-connected DB client, a file watcher) keeps this process alive
    // indefinitely. That costs more than a slow exit: ../emitter/spawn.ts
    // settles its promise on 'close', so a child that never exits is a
    // `nest g` that hangs forever with no output at all.
    process.exit(0);
  },
  (err: unknown) => {
    // Deliberately typed `unknown`, not `Error`: `require(req.appModulePath)`
    // above runs arbitrary user code at module scope, where `throw 'string'`,
    // `throw { code }` and `throw null` are all reachable. An un-normalized
    // non-Error is not merely untidy — `err.message` is `undefined`,
    // `JSON.stringify` *drops* undefined keys, so the payload degrades to
    // `{"ok":false}`, spawn.ts's `isEmitResult` rejects it as malformed, and
    // the user is shown a generic "unexpected output" that reads like a bug
    // in this package rather than the throw in theirs. `null`/`undefined`
    // additionally used to make the stderr fallback below throw again.
    const normalized =
      err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err));
    try {
      writePayload({ ok: false, message: normalized.message, stack: normalized.stack });
    } catch {
      // The payload descriptor is unavailable (e.g. this entry was run by hand
      // rather than by ../emitter/spawn.ts). Losing the diagnostic entirely is
      // strictly worse than printing it. `writeSync` rather than
      // `process.stderr.write` because `process.exit()` follows immediately:
      // stderr writes are asynchronous when it is a pipe on some platforms,
      // and an exit does not wait for them.
      try {
        writeSync(2, `[nest-graphql] emitter failed: ${normalized.stack ?? normalized.message}\n`);
      } catch {
        // Neither the payload descriptor nor stderr is writable. There is no
        // channel left to report on; still exit non-zero rather than turning
        // this into an unhandled rejection.
      }
    }
    process.exit(1);
  },
);
