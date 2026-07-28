import 'reflect-metadata';
import { readFileSync, rmSync, existsSync } from 'fs';
import { buildSdl } from '../src/emitter/build';
import { MercuriusAppModule, MERCURIUS_SCHEMA_FILE } from './fixtures/mercurius/app.module';

describe('byte parity — Mercurius driver on Fastify', () => {
  afterAll(() => {
    if (existsSync(MERCURIUS_SCHEMA_FILE)) rmSync(MERCURIUS_SCHEMA_FILE);
  });

  it('produces output identical to a real Mercurius boot', async () => {
    const { NestFactory } = require('@nestjs/core');
    const { FastifyAdapter } = require('@nestjs/platform-fastify');

    const app = await NestFactory.create(
      MercuriusAppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    const bootSdl = readFileSync(MERCURIUS_SCHEMA_FILE, 'utf8');
    await app.close();

    const ourSdl = await buildSdl(MercuriusAppModule, { sortSchema: true });

    expect(ourSdl).toBe(bootSdl);
  });

  it('matches the Apollo fixture byte for byte, proving driver independence', async () => {
    const { AppModule } = require('./fixtures/basic/app.module');

    const apolloSdl = await buildSdl(AppModule, { sortSchema: true });
    const mercuriusSdl = await buildSdl(MercuriusAppModule, { sortSchema: true });

    // Same resolver, same options — the driver must not influence the SDL.
    expect(mercuriusSdl).toBe(apolloSdl);
  });
});
