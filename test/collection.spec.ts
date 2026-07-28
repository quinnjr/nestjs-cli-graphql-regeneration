import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { NodeModulesEngineHost } from '@angular-devkit/schematics/tools';
import { SchematicEngine, Tree } from '@angular-devkit/schematics';
import * as path from 'path';
import { readFileSync } from 'fs';
import { publishForSchematicsRequire } from './helpers/schematics-require-bridge';
// Imported here, below the hoisted `vi.mock` calls, so the factory module is built against
// the mocks — exactly what ts-jest's single CJS registry gave the engine implicitly.
import * as regenerateFactory from '../src/regenerate/index';

// The Rule under test (Task 9) really builds and really spawns the emitter. Those are covered
// end to end elsewhere (test/regenerate.spec.ts, test/parity.spec.ts); here we only need the
// Rule to run to completion so this test can keep proving what it always proved: that every
// property `nest g` injects survives schema validation and the factory actually executes.
vi.mock('../src/emitter/spawn', () => ({
  spawnEmitter: vi.fn().mockResolvedValue({
    ok: true,
    sdl: 'type Query {\n  ok: String\n}\n',
    outFile: 'src/schema.gql',
  }),
}));

vi.mock('../src/regenerate/build-project', () => ({
  buildProject: vi.fn().mockResolvedValue(undefined),
}));

// The engine resolves `src/collection.json`'s factory with Node's `require`, which can
// neither load `.ts` nor see the `vi.mock` calls above.
publishForSchematicsRequire(
  path.join(__dirname, '..', 'src', 'regenerate', 'index.ts'),
  regenerateFactory,
);

const collectionPath = path.join(__dirname, '..', 'src', 'collection.json');
const distCollectionPath = path.join(__dirname, '..', 'dist', 'collection.json');
const closedSchemaFixturePath = path.join(
  __dirname,
  'fixtures',
  'closed-schema',
  'collection.json',
);

describe('regenerate schematic registration', () => {
  it('accepts every option nest g injects and runs the Rule', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = Tree.empty();
    tree.create(
      '/nest-cli.json',
      JSON.stringify({ sourceRoot: 'src', projects: { api: { sourceRoot: 'src' } } }),
    );

    const logEntries: string[] = [];
    const subscription = runner.logger.subscribe((entry) => logEntries.push(entry.message));

    const result = await runner.runSchematic(
      'regenerate',
      {
        name: 'default',
        path: 'src',
        collection: 'nestjs-graphql-regenerate',
        project: 'api',
        skipImport: false,
        type: 'graphql',
        crud: false,
        language: 'ts',
        sourceRoot: 'src',
        spec: true,
        flat: false,
        specFileSuffix: 'spec',
      },
      tree,
    );
    subscription.unsubscribe();

    // `runSchematic` resolving at all already proves every property above validated against
    // schema.json (a rejection from CoreSchemaRegistry would reject this promise and fail the
    // test via the unhandled `await`, independent of any assertion below). The assertions here
    // go further and pin the Rule's actual observable effect, so a future regression (e.g.
    // schema validation silently skipped, or the factory never invoked) can't slip past on a
    // vacuous `toBeDefined()`.
    //
    // Division of labor: this test only ever sends *declared* properties, so it cannot by
    // itself prove `additionalProperties` is absent from schema.json -- that is what the static
    // check below, plus the negative-control fixture test, verify directly.
    expect(logEntries.join('\n')).toMatch(/Building project "api"/);
    expect(result.files.sort()).toEqual(['/nest-cli.json', '/src/schema.gql']);
  });

  it('does not lock down additional properties', () => {
    const schema = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'src', 'regenerate', 'schema.json'), 'utf8'),
    );
    expect(schema.additionalProperties).toBeUndefined();
  });

  it('rejects an undeclared property when a schema is closed (negative control)', async () => {
    // Proves the harness can actually observe a schema-validation rejection. Without this, the
    // positive test's silence (no throw) wouldn't demonstrate anything -- a guard test that has
    // never been seen to fail is not yet a guard.
    const runner = new SchematicTestRunner('closed-schema-fixture', closedSchemaFixturePath);

    await expect(
      runner.runSchematic('closed', { name: 'x', extra: 'not declared anywhere' }, Tree.empty()),
    ).rejects.toThrow();
  });

  it('resolves a schematic native to @nestjs/schematics through the extends chain', () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const collection = runner.engine.createCollection('nest-graphql');

    // 'service' is not declared anywhere in our own collection.json. If `extends` were merely
    // tolerated by the engine without real inheritance wired up, this name would not resolve.
    expect(collection.listSchematicNames()).toEqual(
      expect.arrayContaining(['regenerate', 'service']),
    );

    const schematic = collection.createSchematic('service');
    expect(schematic.description.name).toBe('service');
    expect(schematic.description.collection.name).toBe('@nestjs/schematics');
  });
});

describe('production build (dist/) smoke test', () => {
  it('loads the compiled collection through the real NodeModulesEngineHost', () => {
    // Exercises the exact mechanism `nest g` uses in production: the non-test engine host
    // resolving the built CommonJS output via `require()` -- not the SWC-transformed
    // `src/*.ts` that the tests above exercise. `pretest` (`pnpm build`) keeps `dist/` fresh
    // for this test.
    const host = new NodeModulesEngineHost();
    const engine = new SchematicEngine(host);
    const collection = engine.createCollection(distCollectionPath);

    // Resolving the schematic already performs the real `require()` of
    // `dist/regenerate/index.js` and extracts its named export (ExportStringRef does this
    // eagerly at resolution time, not deferred to execution).
    const schematic = collection.createSchematic('regenerate');
    expect(schematic.description.name).toBe('regenerate');
  });
});
