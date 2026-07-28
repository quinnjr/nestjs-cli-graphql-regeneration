import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { RecipesResolver } from './recipes.resolver';
import { HelloResolver } from './hello.resolver';

export const AUTO_SCHEMA_FILE = join(__dirname, 'boot-schema.gql');

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: AUTO_SCHEMA_FILE,
      sortSchema: true,
    }),
  ],
  // HelloResolver carries a bare @Resolver() — see its own file for why that
  // matters here: it is the byte-parity guard for src/emitter/harvest.ts's
  // Reflect.hasMetadata fix.
  providers: [RecipesResolver, HelloResolver],
})
export class AppModule {}
