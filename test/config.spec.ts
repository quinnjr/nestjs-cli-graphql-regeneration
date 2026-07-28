import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  resolveConfig,
  resolveOutFile,
  APP_MODULE_BASENAME,
  CONFIG_BASENAME,
  SCHEMA_CONFIG_FIELDS,
} from '../src/config/resolve';
import { distCandidates, findDistFile, resolveDistFile } from '../src/config/dist-layout';

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

// A named frame inside the user's own config file, so the surfaced stack can
// be asserted to point *there* rather than at this package's loader.
const CONFIG_JS_THROWS_DEEP = `
function explodeInsideTheUsersConfig() { throw new Error('boom from the config'); }
explodeInsideTheUsersConfig();
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

  it('chains the original error as `cause`, preserving its stack', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'graphql.config.js'), CONFIG_JS_THROWS);

    let caught: (Error & { cause?: unknown }) | undefined;
    try {
      resolveConfig(dir, 'default');
    } catch (err) {
      caught = err as Error & { cause?: unknown };
    }

    expect(caught).toBeDefined();
    // Flattening the original to a message fragment loses the stack that says
    // which line of the user's config actually threw.
    expect(caught!.cause).toBeInstanceOf(Error);
    expect((caught!.cause as Error).message).toBe('boom');
    expect((caught!.cause as Error).stack).toContain('graphql.config.js');
  });

  it('surfaces a stack pointing at the line of the user config that threw', () => {
    // `cause` alone is not enough: the emitter child reports failures across a
    // process boundary as `EmitFailure` (message + stack, no `cause`), so an
    // object reference hanging off `cause` is dropped in transit and the user
    // is left with a stack describing *this package's* loader. Merging the
    // original stack into the thrown error's own `stack` is what actually
    // reaches them.
    const dir = scratch();
    const configPath = path.join(dir, 'graphql.config.js');
    writeFileSync(configPath, CONFIG_JS_THROWS_DEEP);

    let caught: Error | undefined;
    try {
      resolveConfig(dir, 'default');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const stack = caught!.stack ?? '';
    // A real call frame in the user's file — not merely the config path, which
    // the wrapper's own message already contains.
    expect(stack).toMatch(/\n\s+at\b[^\n]*graphql\.config\.js:\d+:\d+/);
    expect(stack).toContain('explodeInsideTheUsersConfig');
    // The wrapper's context survives too; the merge adds to the message, it
    // does not replace it.
    expect(stack).toContain('Failed to load GraphQL schema config at');
    expect(caught!.message).toContain('boom from the config');
  });
});

describe('resolveOutFile', () => {
  // Ground truth: @nestjs/graphql's own resolution of `autoSchemaFile`, which
  // is what decides the path the boot path writes to.
  const {
    getPathForAutoSchemaFile,
  } = require('@nestjs/graphql/dist/utils/auto-schema-file.util.js');

  const namesAFile: Array<[string, any, string]> = [
    ['a relative string', 'src/schema.gql', 'src/schema.gql'],
    ['an absolute string', '/abs/project/src/schema.gql', '/abs/project/src/schema.gql'],
    ['a SchemaFileConfig object', { path: 'src/schema.gql' }, 'src/schema.gql'],
    [
      'a SchemaFileConfig object with federation',
      { path: 'src/schema.gql', federation: 2 },
      'src/schema.gql',
    ],
  ];

  it.each(namesAFile)('resolves %s exactly as getPathForAutoSchemaFile does', (_l, input, out) => {
    expect(resolveOutFile(input, 'default')).toBe(out);
    expect(resolveOutFile(input, 'default')).toBe(getPathForAutoSchemaFile(input));
  });

  const namesNoFile: Array<[string, any]> = [
    ['true', true],
    ['false', false],
    ['undefined', undefined],
    ['an object with no path', {}],
    ['an object with an empty path', { path: '' }],
    ['an empty string', ''],
  ];

  it.each(namesNoFile)('rejects %s, which upstream resolves to no file at all', (_l, input) => {
    // Upstream treats "no path" as "skip the write". This schematic exists to
    // write the file, so the same condition has to be a clear error rather
    // than a junk path like "/true" or "/[object Object]".
    expect(getPathForAutoSchemaFile(input)).toBeFalsy();
    expect(() => resolveOutFile(input, 'admin')).toThrow(/autoSchemaFile/);
    expect(() => resolveOutFile(input, 'admin')).toThrow(/admin/);
  });
});

describe('SCHEMA_CONFIG_FIELDS', () => {
  it('lists every option this package carries from graphql.config to the SDL', () => {
    // The runtime list is latched to `keyof SchemaConfig` at compile time (see
    // SCHEMA_CONFIG_FIELD_SET). This asserts the *contents*, so that a field
    // being added or removed is a visible, reviewable change here — and
    // test/parity-config.spec.ts then requires each one to have a byte-parity
    // case against a real boot.
    expect([...SCHEMA_CONFIG_FIELDS].sort()).toEqual([
      'addNewlineAtEnd',
      'autoSchemaFile',
      'buildSchemaOptions',
      'include',
      'sortSchema',
      'transformAutoSchemaFile',
      'transformSchema',
    ]);
  });
});

describe('dist layout probing', () => {
  it('offers the flat candidate before the nested src/ one', () => {
    expect(distCandidates('/dist', 'x.js')).toEqual([
      path.join('/dist', 'x.js'),
      path.join('/dist', 'src', 'x.js'),
    ]);
  });

  it('finds nothing when neither candidate exists', () => {
    expect(findDistFile(scratch(), CONFIG_BASENAME)).toBeUndefined();
  });

  it('falls back to the flat candidate so the consumer reports the failure', () => {
    // regenerate/index.ts hands this to the child, which `require()`s it: a
    // "Cannot find module <path>" from there is a better message than
    // anything a probe with no idea what the file is for could produce.
    const dir = scratch();
    expect(resolveDistFile(dir, APP_MODULE_BASENAME)).toBe(
      path.join(dir, APP_MODULE_BASENAME),
    );
  });

  it('resolves the config and the app module to the same layout — flat', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, CONFIG_BASENAME), CONFIG_JS);
    writeFileSync(path.join(dir, APP_MODULE_BASENAME), '');

    expect(resolveConfig(dir, 'default').autoSchemaFile).toBe('src/schema.gql');
    expect(resolveDistFile(dir, APP_MODULE_BASENAME)).toBe(path.join(dir, APP_MODULE_BASENAME));
  });

  it('resolves the config and the app module to the same layout — nested src/', () => {
    // The two halves of one layout question. Before they shared a helper,
    // whenever the config resolved to candidate #2 the app module was still
    // looked up at candidate #1 — so the documented `dist/src/` layout could
    // never work end to end.
    const dir = scratch();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', CONFIG_BASENAME), CONFIG_JS);
    writeFileSync(path.join(dir, 'src', APP_MODULE_BASENAME), '');

    expect(resolveConfig(dir, 'default').autoSchemaFile).toBe('src/schema.gql');
    expect(resolveDistFile(dir, APP_MODULE_BASENAME)).toBe(
      path.join(dir, 'src', APP_MODULE_BASENAME),
    );
  });
});
