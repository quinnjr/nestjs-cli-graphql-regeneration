import { GraphQLSchema, lexicographicSortSchema, printSchema } from 'graphql';
import { GRAPHQL_SDL_FILE_HEADER, GRAPHQL_SDL_FILE_END } from '@nestjs/graphql/dist/graphql.constants.js';

/**
 * `GRAPHQL_SDL_FILE_END` (and the `addNewlineAtEnd` plumbing in upstream's
 * `GraphQLSchemaBuilder.generateSchema` that this module reproduces
 * byte-for-byte) first appears in `@nestjs/graphql@12.2.0` — our declared
 * peer floor. On an older 12.0.x/12.1.x install this deep import silently
 * resolves to `undefined`, and `out += undefined` would append the literal
 * string "undefined" to the caller's schema file instead of a newline. Fail
 * loudly here rather than corrupt output — same philosophy as the
 * NODE_PATH-divergence and preview-suppression warnings elsewhere in this
 * codebase (../emitter/child.ts, ../emitter/preview.ts).
 */
if (typeof GRAPHQL_SDL_FILE_HEADER !== 'string' || typeof GRAPHQL_SDL_FILE_END !== 'string') {
  throw new Error(
    'Could not read GRAPHQL_SDL_FILE_HEADER/GRAPHQL_SDL_FILE_END from ' +
      '@nestjs/graphql/dist/graphql.constants.js — the installed @nestjs/graphql may have ' +
      'renamed or removed these internals. addNewlineAtEnd requires @nestjs/graphql >=12.2.0.',
  );
}

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
