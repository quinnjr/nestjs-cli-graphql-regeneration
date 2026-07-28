import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { serialize } from '../src/emitter/serialize';

function schemaWithFields(...names: string[]) {
  const fields: Record<string, { type: typeof GraphQLString }> = {};
  for (const n of names) fields[n] = { type: GraphQLString };
  return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields }) });
}

describe('serialize', () => {
  it('prefixes the @nestjs/graphql SDL header', async () => {
    const out = await serialize(schemaWithFields('a'), {});
    const header = require('@nestjs/graphql/dist/graphql.constants').GRAPHQL_SDL_FILE_HEADER;
    expect(out.startsWith(header)).toBe(true);
  });

  it('sorts lexicographically when asked', async () => {
    const out = await serialize(schemaWithFields('zeta', 'alpha'), { sortSchema: true });
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('zeta'));
  });

  it('preserves declaration order when not asked', async () => {
    const out = await serialize(schemaWithFields('zeta', 'alpha'), { sortSchema: false });
    expect(out.indexOf('zeta')).toBeLessThan(out.indexOf('alpha'));
  });

  it('appends the trailing newline marker when asked', async () => {
    const end = require('@nestjs/graphql/dist/graphql.constants').GRAPHQL_SDL_FILE_END;
    const out = await serialize(schemaWithFields('a'), { addNewlineAtEnd: true });
    expect(out.endsWith(end)).toBe(true);
  });

  it('applies transformSchema before printing', async () => {
    const out = await serialize(schemaWithFields('a'), {
      transformSchema: () => schemaWithFields('replaced'),
    });
    expect(out).toContain('replaced');
    expect(out).not.toContain('a: String');
  });
});
