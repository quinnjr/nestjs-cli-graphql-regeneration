import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { Tree } from '@angular-devkit/schematics';
import * as path from 'path';

jest.mock('../src/emitter/spawn', () => ({
  spawnEmitter: jest.fn().mockResolvedValue({
    ok: true,
    sdl: 'type Query {\n  ok: String\n}\n',
    outFile: 'src/schema.gql',
  }),
}));

jest.mock('../src/regenerate/build-project', () => ({
  buildProject: jest.fn().mockResolvedValue(undefined),
}));

const collectionPath = path.join(__dirname, '..', 'src', 'collection.json');

function treeWithNestCli(json: object): Tree {
  const tree = Tree.empty();
  tree.create('/nest-cli.json', JSON.stringify(json));
  return tree;
}

describe('regenerate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes the schema file returned by the emitter', async () => {
    const { spawnEmitter } = require('../src/emitter/spawn');
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = treeWithNestCli({ sourceRoot: 'src' });

    const result = await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(result.readContent('/src/schema.gql')).toContain('type Query');

    // Pins the resolveProject -> EmitRequest wiring for the single-app (no --project)
    // case: this is the orchestration this task exists to prove, and it is otherwise
    // completely unverified since spawnEmitter is mocked everywhere.
    expect(spawnEmitter).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      distRoot: path.join(process.cwd(), 'dist'),
      appModulePath: path.join(process.cwd(), 'dist', 'app.module.js'),
      schemaName: 'default',
    });
  });

  it('overwrites an existing stale schema file', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = treeWithNestCli({ sourceRoot: 'src' });
    tree.create('/src/schema.gql', 'type Query { stale: String }\n');

    const result = await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(result.readContent('/src/schema.gql')).not.toContain('stale');
  });

  it('reports "up to date" and leaves content alone when already in sync', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const messages: string[] = [];
    runner.logger.subscribe((e) => messages.push(e.message));

    const tree = treeWithNestCli({ sourceRoot: 'src' });
    tree.create('/src/schema.gql', 'type Query {\n  ok: String\n}\n');

    // Structural check, not just a content check: content-only would pass identically
    // whether the Rule took the early-return branch or overwrote with byte-identical
    // content. `SchematicTestRunner`/`callRuleAsync` hand the Rule this exact `tree`
    // object with no branching (verified against @angular-devkit/schematics' source),
    // so spying on it directly observes what the Rule actually did.
    //
    // Note: `UnitTestTree.actions` (a `DelegateTree`/`HostTree` getter) cannot make
    // this distinction *for this test's setup*: @angular-devkit/core's `CordHost`
    // collapses a create-then-overwrite of the *same path within the same Tree
    // session* back into a single 'create' record (`CordHost.overwrite` only adds to
    // `_filesToOverwrite` when the path isn't already in `_filesToCreate` -- and the
    // `tree.create(...)` seed call two lines up put it there). An `.actions`-based
    // assertion was tried first and did not catch an always-overwrite regression here
    // (see task-9-report.md for the reproduction); spying on the Tree instance does.
    const overwriteSpy = jest.spyOn(tree, 'overwrite');

    const result = await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(messages.join('\n')).toMatch(/up to date/);
    expect(result.readContent('/src/schema.gql')).toBe('type Query {\n  ok: String\n}\n');
    expect(overwriteSpy).not.toHaveBeenCalled();
  });

  it('passes the project name through to the build step and the resolved paths to the emitter', async () => {
    const { buildProject } = require('../src/regenerate/build-project');
    const { spawnEmitter } = require('../src/emitter/spawn');
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = treeWithNestCli({
      sourceRoot: 'apps/api/src',
      projects: { api: { sourceRoot: 'apps/api/src', root: 'apps/api' } },
    });

    await runner.runSchematic('regenerate', { name: 'default', project: 'api' }, tree);

    expect(buildProject).toHaveBeenCalledWith(expect.any(String), 'api');

    // Pins the resolveProject -> EmitRequest wiring for the monorepo --project case,
    // so the resolveProject-derived distRoot ("dist/apps/api", not the default "dist")
    // is genuinely exercised, not just the build-step forwarding.
    expect(spawnEmitter).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      distRoot: path.join(process.cwd(), 'dist/apps/api'),
      appModulePath: path.join(process.cwd(), 'dist/apps/api', 'app.module.js'),
      schemaName: 'default',
    });
  });

  it('fails with a clear message when nest-cli.json is absent', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    await expect(
      runner.runSchematic('regenerate', { name: 'default' }, Tree.empty()),
    ).rejects.toThrow(/nest-cli\.json/);
  });

  it('fails with a clear message when nest-cli.json is not valid JSON', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = Tree.empty();
    tree.create('/nest-cli.json', '{ not valid json');

    await expect(
      runner.runSchematic('regenerate', { name: 'default' }, tree),
    ).rejects.toThrow(/nest-cli\.json/);
  });

  it('surfaces an unknown project name with the same exception framing used elsewhere', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = treeWithNestCli({ sourceRoot: 'src' });

    await expect(
      runner.runSchematic('regenerate', { name: 'default', project: 'ghost' }, tree),
    ).rejects.toThrow(/Unknown project "ghost"/);
  });
});
