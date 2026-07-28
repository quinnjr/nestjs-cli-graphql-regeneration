import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { resolveConfig } from '../src/config/resolve';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'gqlcfg-'));
}

const CONFIG_JS = `
module.exports.schemas = {
  default: { autoSchemaFile: 'src/schema.gql', sortSchema: true },
  admin: { autoSchemaFile: 'src/admin.gql' },
};
`;

describe('resolveConfig', () => {
  it('finds the config at the dist root', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'graphql.config.js'), CONFIG_JS);
    expect(resolveConfig(dir, 'default').autoSchemaFile).toBe('src/schema.gql');
  });

  it('falls back to a nested src directory', () => {
    const dir = scratch();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'graphql.config.js'), CONFIG_JS);
    expect(resolveConfig(dir, 'admin').autoSchemaFile).toBe('src/admin.gql');
  });

  it('lists every attempted path when the config is missing', () => {
    const dir = scratch();
    expect(() => resolveConfig(dir, 'default')).toThrow(/graphql\.config\.js/);
    expect(() => resolveConfig(dir, 'default')).toThrow(/src/);
  });

  it('names the missing schema key and the available ones', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'graphql.config.js'), CONFIG_JS);
    expect(() => resolveConfig(dir, 'nope')).toThrow(/nope/);
    expect(() => resolveConfig(dir, 'nope')).toThrow(/default, admin/);
  });
});
