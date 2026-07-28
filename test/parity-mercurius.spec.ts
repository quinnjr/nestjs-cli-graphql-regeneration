import 'reflect-metadata';
import { readFileSync, rmSync, existsSync } from 'fs';
import { buildSdl } from '../src/emitter/build';
import { MercuriusAppModule, MERCURIUS_SCHEMA_FILE } from './fixtures/mercurius/app.module';
import { AppModule } from './fixtures/basic/app.module';

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

  /**
   * This used to be titled "proving driver independence", which it could not
   * do: `buildSdl` never boots a driver, so the driver is not an input to
   * either side of the comparison — the assertion was true by construction.
   * Genuine driver independence is proved by the test above, which compares
   * against a real Mercurius-on-Fastify boot.
   *
   * What repeated `buildSdl` calls in one process *do* risk is cross-talk.
   * `@nestjs/graphql` keeps its type metadata in module-global singletons
   * (`TypeMetadataStorage`, `LazyMetadataStorage`), and every `buildSdl` call
   * runs `LazyMetadataStorage.load` and `TypeMetadataStorage.compile` against
   * that same shared state. Two builds over different module graphs can
   * therefore leak into one another — the second picking up types registered
   * by the first, or a re-compile mutating what the first already read.
   */
  it('is unaffected by an intervening build over a different module graph', async () => {

    // Interleaved deliberately: Apollo, then a build over a *different* module
    // graph, then Apollo again. Building Apollo twice back to back would not
    // catch leakage, because there would be nothing in between to leak.
    const apolloSdl = await buildSdl(AppModule, { sortSchema: true });
    const mercuriusSdl = await buildSdl(MercuriusAppModule, { sortSchema: true });
    const apolloSdlAgain = await buildSdl(AppModule, { sortSchema: true });

    // The load-bearing assertion: the Mercurius build in between must leave no
    // trace on the metadata storages the Apollo build reads.
    expect(apolloSdlAgain).toBe(apolloSdl);

    // And the two fixtures declare the same resolver, so their SDL agrees
    // regardless of which module graph produced it.
    expect(mercuriusSdl).toBe(apolloSdl);
  });
});
