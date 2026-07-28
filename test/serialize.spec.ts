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
    const header = require('@nestjs/graphql/dist/graphql.constants.js').GRAPHQL_SDL_FILE_HEADER;
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
    const end = require('@nestjs/graphql/dist/graphql.constants.js').GRAPHQL_SDL_FILE_END;
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

  it('sorts transformed schema, not original', async () => {
    const out = await serialize(schemaWithFields('zebra', 'alpha'), {
      sortSchema: true,
      transformSchema: (schema) => {
        // Reveal the order fields appear in the input schema by appending position suffixes
        const queryType = schema.getQueryType();
        if (!queryType) throw new Error('No query type');
        const fieldNames = Object.keys(queryType.getFields());

        // Create new fields with position suffix: zebra_pos0, alpha_pos1 (if transform runs first)
        // or alpha_pos0, zebra_pos1 (if sort ran first)
        const fields: Record<string, { type: typeof GraphQLString }> = {};
        fieldNames.forEach((name, i) => {
          fields[`${name}_pos${i}`] = { type: GraphQLString };
        });
        return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields }) });
      },
    });

    // If transform ran FIRST (correct):
    // Fields are zebra, alpha (original order)
    // Transform creates: zebra_pos0, alpha_pos1
    // Sort produces: alpha_pos1, zebra_pos0
    // We verify alpha has pos1

    // If sort ran FIRST (wrong):
    // Fields become alpha, zebra (sorted)
    // Transform creates: alpha_pos0, zebra_pos1
    // Sort produces: alpha_pos0, zebra_pos1
    // We verify alpha has pos0 - this would fail our assertion

    expect(out).toContain('alpha_pos1');
    expect(out).not.toContain('alpha_pos0');
  });
});
