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
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = treeWithNestCli({ sourceRoot: 'src' });

    const result = await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(result.readContent('/src/schema.gql')).toContain('type Query');
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

    const result = await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(messages.join('\n')).toMatch(/up to date/);
    expect(result.readContent('/src/schema.gql')).toBe('type Query {\n  ok: String\n}\n');
  });

  it('passes the project name through to the build step', async () => {
    const { buildProject } = require('../src/regenerate/build-project');
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = treeWithNestCli({
      sourceRoot: 'apps/api/src',
      projects: { api: { sourceRoot: 'apps/api/src', root: 'apps/api' } },
    });

    await runner.runSchematic('regenerate', { name: 'default', project: 'api' }, tree);

    expect(buildProject).toHaveBeenCalledWith(expect.any(String), 'api');
  });

  it('fails with a clear message when nest-cli.json is absent', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    await expect(
      runner.runSchematic('regenerate', { name: 'default' }, Tree.empty()),
    ).rejects.toThrow(/nest-cli\.json/);
  });
});
