import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { RecipesResolver } from './recipes.resolver';

export const AUTO_SCHEMA_FILE = join(__dirname, 'boot-schema.gql');

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: AUTO_SCHEMA_FILE,
      sortSchema: true,
    }),
  ],
  providers: [RecipesResolver],
})
export class AppModule {}
