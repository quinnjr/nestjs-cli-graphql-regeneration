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

async function main(): Promise<void> {
  const req: EmitRequest = JSON.parse(process.argv[2]);

  loadDotEnv(req.projectRoot);

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
  process.stdout.write(
    JSON.stringify({ ok: false, message: err.message, stack: err.stack }),
  );
  process.exit(1);
});
