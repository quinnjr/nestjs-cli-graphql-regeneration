import { GraphQLSchema, lexicographicSortSchema, printSchema } from 'graphql';

export interface SerializeOptions {
  sortSchema?: boolean;
  addNewlineAtEnd?: boolean;
  transformSchema?: (schema: GraphQLSchema) => GraphQLSchema | Promise<GraphQLSchema>;
}

export async function serialize(
  schema: GraphQLSchema,
  opts: SerializeOptions,
): Promise<string> {
  const constants = require('@nestjs/graphql/dist/graphql.constants');
  const transformed = opts.transformSchema ? await opts.transformSchema(schema) : schema;

  let out =
    constants.GRAPHQL_SDL_FILE_HEADER +
    printSchema(opts.sortSchema ? lexicographicSortSchema(transformed) : transformed);

  if (opts.addNewlineAtEnd) out += constants.GRAPHQL_SDL_FILE_END;
  return out;
}
