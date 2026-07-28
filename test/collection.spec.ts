import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { Tree } from '@angular-devkit/schematics';
import * as path from 'path';

const collectionPath = path.join(__dirname, '..', 'src', 'collection.json');

describe('regenerate schematic registration', () => {
  it('accepts every option nest g injects', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    const tree = Tree.empty();
    tree.create('/nest-cli.json', '{"sourceRoot":"src"}');

    const result = await runner.runSchematic(
      'regenerate',
      {
        name: 'default',
        path: 'src',
        collection: '@scope/nest-graphql',
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

    expect(result).toBeDefined();
  });

  it('does not lock down additional properties', () => {
    const schema = require('../src/regenerate/schema.json');
    expect(schema.additionalProperties).toBeUndefined();
  });
});
