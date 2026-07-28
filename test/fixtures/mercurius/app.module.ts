import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver, MercuriusDriverConfig } from '@nestjs/mercurius';
import { join } from 'path';
import { RecipesResolver } from '../basic/recipes.resolver';
import { HelloResolver } from '../basic/hello.resolver';

export const MERCURIUS_SCHEMA_FILE = join(__dirname, 'boot-schema.gql');

@Module({
  imports: [
    GraphQLModule.forRoot<MercuriusDriverConfig>({
      driver: MercuriusDriver,
      autoSchemaFile: MERCURIUS_SCHEMA_FILE,
      sortSchema: true,
      // mercurius's default response cache lazily does
      // `await import('quick-lru')` — quick-lru ships ESM-only, and Jest's
      // default CJS VM sandbox has no `--experimental-vm-modules` dynamic
      // import hook, so that await throws
      // "A dynamic import callback was invoked without --experimental-vm-modules".
      // This is a Jest/ESM interop artifact of booting the real driver in-test,
      // unrelated to schema shape and unrelated to this package's driver
      // agnosticism (buildSdl() never boots the driver at all — see
      // src/emitter/preview.ts). Disabling the cache sidesteps the dynamic
      // import entirely without touching test runner config.
      cache: false,
    }),
  ],
  // Kept in lockstep with test/fixtures/basic/app.module.ts's provider list:
  // test/parity-mercurius.spec.ts compares this module's SDL directly against
  // the Apollo fixture's, so the two must declare the same resolvers.
  providers: [RecipesResolver, HelloResolver],
})
export class MercuriusAppModule {}
