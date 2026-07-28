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

main().catch((err: Error) => {
  try {
    writePayload({ ok: false, message: err.message, stack: err.stack });
  } catch {
    // The payload descriptor is unavailable (e.g. this entry was run by hand
    // rather than by ../emitter/spawn.ts). Losing the diagnostic entirely is
    // strictly worse than printing it.
    process.stderr.write(`[nest-graphql] emitter failed: ${err.stack ?? err.message}\n`);
  }
  process.exitCode = 1;
});
