import { existsSync } from 'fs';
import * as path from 'path';
import { buildSdl } from './build';
import { resolveConfig } from '../config/resolve';
import { EmitRequest } from './protocol';

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

async function main(): Promise<void> {
  const req: EmitRequest = JSON.parse(process.argv[2]);

  loadDotEnv(req.projectRoot);
  warnIfVersionIsolationDiverges(req.projectRoot);

  const config = resolveConfig(req.distRoot, req.schemaName);
  const mod = require(req.appModulePath);
  const AppModule = mod.AppModule ?? mod.default;
  if (!AppModule) {
    throw new Error(`${req.appModulePath} does not export AppModule.`);
  }

  const sdl = await buildSdl(AppModule, {
    sortSchema: config.sortSchema,
    addNewlineAtEnd: config.addNewlineAtEnd,
    transformSchema: config.transformSchema,
    buildSchemaOptions: config.buildSchemaOptions,
    include: config.include,
  });

  process.stdout.write(
    JSON.stringify({ ok: true, sdl, outFile: config.autoSchemaFile }),
  );
}

main().catch((err: Error) => {
  // Node's stdout is asynchronous when piped (which is how spawn.ts connects
  // it). process.exit() does not wait for pending writes to flush, so calling
  // it immediately after this write can truncate a large payload — very
  // plausible for a deep Nest DI failure's err.stack. Setting exitCode and
  // letting the process end on its own lets the write flush first.
  process.stdout.write(
    JSON.stringify({ ok: false, message: err.message, stack: err.stack }),
  );
  process.exitCode = 1;
});
