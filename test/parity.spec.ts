import 'reflect-metadata';
import { readFileSync, rmSync, existsSync } from 'fs';
import { buildSdl } from '../src/emitter/build';
import { AppModule, AUTO_SCHEMA_FILE } from './fixtures/basic/app.module';
import { ExplodingAppModule } from './fixtures/exploding/app.module';

describe('byte parity with the boot path', () => {
  afterAll(() => {
    if (existsSync(AUTO_SCHEMA_FILE)) rmSync(AUTO_SCHEMA_FILE);
  });

  it('produces output identical to autoSchemaFile', async () => {
    // Ground truth: a real boot, which writes AUTO_SCHEMA_FILE during init.
    const { NestFactory } = require('@nestjs/core');
    const app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    const bootSdl = readFileSync(AUTO_SCHEMA_FILE, 'utf8');
    await app.close();

    const ourSdl = await buildSdl(AppModule, { sortSchema: true });

    expect(ourSdl).toBe(bootSdl);
  });

  it('never instantiates providers', async () => {
    await expect(
      buildSdl(ExplodingAppModule, { sortSchema: true }),
    ).resolves.toContain('type Recipe');
  });

  it('negative control: the exploding fixture really does fail a normal boot', async () => {
    const { NestFactory } = require('@nestjs/core');
    await expect(
      NestFactory.create(ExplodingAppModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/provider was instantiated/);
  });
});
