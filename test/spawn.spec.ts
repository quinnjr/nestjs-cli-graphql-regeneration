import { mkdtempSync, writeFileSync, cpSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { spawnEmitter } from '../src/emitter/spawn';

describe('spawnEmitter', () => {
  it('returns SDL from a child process', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gqlspawn-'));
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), distRoot, { recursive: true });
    writeFileSync(
      path.join(distRoot, 'graphql.config.js'),
      `module.exports.schemas = { default: { autoSchemaFile: 'src/schema.gql', sortSchema: true } };`,
    );

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
});
