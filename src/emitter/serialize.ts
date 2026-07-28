import { GraphQLSchema, lexicographicSortSchema, printSchema } from 'graphql';
import { GRAPHQL_SDL_FILE_HEADER, GRAPHQL_SDL_FILE_END } from '@nestjs/graphql/dist/graphql.constants';

export interface SerializeOptions {
  sortSchema?: boolean;
  addNewlineAtEnd?: boolean;
  transformSchema?: (schema: GraphQLSchema) => GraphQLSchema | Promise<GraphQLSchema>;
}

export async function serialize(
  schema: GraphQLSchema,
  opts: SerializeOptions,
): Promise<string> {
  const transformed = opts.transformSchema ? await opts.transformSchema(schema) : schema;

  let out =
    GRAPHQL_SDL_FILE_HEADER +
    printSchema(opts.sortSchema ? lexicographicSortSchema(transformed) : transformed);

  if (opts.addNewlineAtEnd) out += GRAPHQL_SDL_FILE_END;
  return out;
}
