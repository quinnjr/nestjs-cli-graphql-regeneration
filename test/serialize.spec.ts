import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { serialize } from '../src/emitter/serialize';

function schemaWithFields(...names: string[]) {
  const fields: Record<string, { type: typeof GraphQLString }> = {};
  for (const n of names) fields[n] = { type: GraphQLString };
  return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields }) });
}

// Hardcoded literals of the current known @nestjs/graphql SDL header/footer
// text (as of @nestjs/graphql 13.4.2, unchanged since introduction in
// 12.2.0's graphql.constants.js). These are asserted IN ADDITION TO the live
// deep import below, deliberately, so the tests can't pass vacuously: if
// GRAPHQL_SDL_FILE_HEADER/GRAPHQL_SDL_FILE_END ever disappear or change
// upstream, the live import in serialize.ts and in this test would resolve
// to `undefined` together and `out.startsWith(header)` would trivially pass
// against a self-referential `undefined`. Asserting against a literal that
// doesn't depend on that same resolution closes that hole.
const KNOWN_GRAPHQL_SDL_FILE_HEADER =
  '# ------------------------------------------------------\n' +
  '# THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)\n' +
  '# ------------------------------------------------------\n\n';
const KNOWN_GRAPHQL_SDL_FILE_END = '\n';

describe('serialize', () => {
  it('prefixes the @nestjs/graphql SDL header', async () => {
    const out = await serialize(schemaWithFields('a'), {});
    const header = require('@nestjs/graphql/dist/graphql.constants.js').GRAPHQL_SDL_FILE_HEADER;
    expect(out.startsWith(header)).toBe(true);
    expect(out.startsWith(KNOWN_GRAPHQL_SDL_FILE_HEADER)).toBe(true);
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
    expect(out.endsWith(KNOWN_GRAPHQL_SDL_FILE_END)).toBe(true);
    expect(out.endsWith('undefined')).toBe(false);
  });

  it('throws a loud error at load time if GRAPHQL_SDL_FILE_HEADER/END are missing', async () => {
    // Simulates a @nestjs/graphql install older than 12.2.0, where these
    // constants (and the addNewlineAtEnd plumbing that depends on them)
    // don't exist yet and the deep import silently resolves to `undefined`.
    // The guard in src/emitter/serialize.ts must turn that into a loud,
    // load-time failure instead of a corrupted schema file.
    //
    // `vi.doMock` only intercepts modules pulled in by a *dynamic import* after
    // the call — unlike Jest's doMock, it cannot retroactively affect a
    // `require()`. Hence the `await import(...)` and the async test.
    vi.resetModules();
    vi.doMock('@nestjs/graphql/dist/graphql.constants.js', () => ({
      GRAPHQL_SDL_FILE_HEADER: undefined,
      GRAPHQL_SDL_FILE_END: undefined,
    }));

    await expect(import('../src/emitter/serialize')).rejects.toThrow(
      /GRAPHQL_SDL_FILE_HEADER\/GRAPHQL_SDL_FILE_END/,
    );

    vi.doUnmock('@nestjs/graphql/dist/graphql.constants.js');
    vi.resetModules();
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
