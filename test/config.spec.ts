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

const CONFIG_JS_DEFAULT_EXPORT = `
exports.default = {
  schemas: {
    default: { autoSchemaFile: 'src/schema.gql', sortSchema: true },
  },
};
`;

const CONFIG_JS_THROWS = `
throw new Error('boom');
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
    // Assert on the actual resolved path strings, not loose substrings —
    // both candidates independently contain "graphql.config.js" and "src",
    // so weaker assertions would not notice if one candidate were dropped
    // from the implementation.
    const rootCandidate = path.join(dir, 'graphql.config.js');
    const srcCandidate = path.join(dir, 'src', 'graphql.config.js');
    expect(() => resolveConfig(dir, 'default')).toThrow(rootCandidate);
    expect(() => resolveConfig(dir, 'default')).toThrow(srcCandidate);
  });

  it('names the missing schema key and the available ones', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'graphql.config.js'), CONFIG_JS);
    expect(() => resolveConfig(dir, 'nope')).toThrow(/nope/);
    expect(() => resolveConfig(dir, 'nope')).toThrow(/default, admin/);
  });

  it('supports a default-export shape as well as module.exports.schemas', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'graphql.config.js'), CONFIG_JS_DEFAULT_EXPORT);
    expect(resolveConfig(dir, 'default').autoSchemaFile).toBe('src/schema.gql');
  });

  it('wraps a load-time failure with the config path and the original cause', () => {
    const dir = scratch();
    const configPath = path.join(dir, 'graphql.config.js');
    writeFileSync(configPath, CONFIG_JS_THROWS);
    expect(() => resolveConfig(dir, 'default')).toThrow(configPath);
    expect(() => resolveConfig(dir, 'default')).toThrow(/boom/);
  });
});
