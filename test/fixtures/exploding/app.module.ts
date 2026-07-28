import { Injectable, Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { RecipesResolver } from '../basic/recipes.resolver';

@Injectable()
export class ExplodingService {
  constructor() {
    throw new Error('provider was instantiated — preview mode failed');
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(__dirname, 'never-written.gql'),
      sortSchema: true,
    }),
  ],
  providers: [RecipesResolver, ExplodingService],
})
export class ExplodingAppModule {}
