import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { Tree } from '@angular-devkit/schematics';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { ChildProcess } from 'child_process';
// Plain `require`, not `import * as`: TypeScript's ES-module interop helper wraps a
// `import * as ns from 'child_process'` namespace in a new, frozen object, which
// `jest.spyOn` cannot redefine properties on ("Cannot redefine property: spawn"). A plain
// `require` returns Node's real (shared, singleton) module object, matching what
// build-project.ts's own compiled `require('child_process')` call resolves to.
const childProcess = require('child_process') as typeof import('child_process');

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

  it('probes the nested dist/src/ layout for the app module, like the config lookup does', async () => {
    const { spawnEmitter } = require('../src/emitter/spawn');
    // The dual-candidate probe is a real filesystem question, so give it a
    // real file to find. `dist/` is this package's own (gitignored) build
    // output and `process.cwd()` is the repo root, which is exactly the
    // projectRoot the Rule uses.
    const nestedDir = path.join(process.cwd(), 'dist', 'src');
    const nestedAppModule = path.join(nestedDir, 'app.module.js');
    const preExisting = fs.existsSync(nestedDir);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(nestedAppModule, '// stub for the nested-layout probe\n');

    try {
      const runner = new SchematicTestRunner('nest-graphql', collectionPath);
      await runner.runSchematic('regenerate', { name: 'default' }, treeWithNestCli({
        sourceRoot: 'src',
      }));

      expect(spawnEmitter).toHaveBeenCalledWith(
        expect.objectContaining({ appModulePath: nestedAppModule }),
      );
    } finally {
      fs.rmSync(nestedAppModule, { force: true });
      if (!preExisting) fs.rmSync(nestedDir, { recursive: true, force: true });
    }
  });
});

// CRITICAL: `outFile` is the user's `autoSchemaFile` verbatim, and a schematic
// `Tree` is rooted at the project, so its paths are project-relative. The old
// `'/' + outFile.replace(/^\.?\//, '')` handled exactly one of the shapes
// @nestjs/graphql accepts. The other three wrote to junk paths — silently
// committing a new file in a deep directory while the real schema went stale,
// and never reporting "up to date" because `tree.read()` of that path was
// always null.
describe('regenerate — mapping autoSchemaFile onto a Tree path', () => {
  beforeEach(() => jest.clearAllMocks());

  function runWithOutFile(outFile: string, tree = treeWithNestCli({ sourceRoot: 'src' })) {
    const { spawnEmitter } = require('../src/emitter/spawn');
    spawnEmitter.mockResolvedValueOnce({
      ok: true,
      sdl: 'type Query {\n  ok: String\n}\n',
      outFile,
    });
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    return runner.runSchematic('regenerate', { name: 'default' }, tree);
  }

  it('maps a project-relative path onto the matching Tree path', async () => {
    const result = await runWithOutFile('src/schema.gql');
    expect(result.readContent('/src/schema.gql')).toContain('type Query');
  });

  it('maps a "./"-prefixed path onto the matching Tree path', async () => {
    const result = await runWithOutFile('./src/schema.gql');
    expect(result.readContent('/src/schema.gql')).toContain('type Query');
  });

  it('maps an absolute in-project path back onto the project-relative Tree path', async () => {
    // `join(process.cwd(), 'src/schema.gql')` is the form the official NestJS
    // code-first docs use, and the form this repo's own fixtures use. It used
    // to land at a Tree path mirroring the whole machine directory layout.
    const result = await runWithOutFile(path.join(process.cwd(), 'src', 'schema.gql'));
    expect(result.readContent('/src/schema.gql')).toContain('type Query');
  });

  it('still reports "up to date" for an absolute path whose content matches', async () => {
    // The regression that made this invisible: with a junk target,
    // `tree.read(target)` was always null, so the short-circuit never fired
    // and every run looked like it had produced a change.
    const messages: string[] = [];
    const tree = treeWithNestCli({ sourceRoot: 'src' });
    tree.create('/src/schema.gql', 'type Query {\n  ok: String\n}\n');
    const overwriteSpy = jest.spyOn(tree, 'overwrite');

    const { spawnEmitter } = require('../src/emitter/spawn');
    spawnEmitter.mockResolvedValueOnce({
      ok: true,
      sdl: 'type Query {\n  ok: String\n}\n',
      outFile: path.join(process.cwd(), 'src', 'schema.gql'),
    });
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);
    runner.logger.subscribe((e) => messages.push(e.message));

    await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(messages.join('\n')).toMatch(/up to date/);
    expect(overwriteSpy).not.toHaveBeenCalled();
  });

  it('refuses a path that escapes the project root rather than writing junk', async () => {
    await expect(runWithOutFile(path.join(process.cwd(), '..', 'outside.gql'))).rejects.toThrow(
      /outside the project root/,
    );
  });

  it('refuses an absolute path on another branch of the filesystem', async () => {
    await expect(runWithOutFile('/etc/schema.gql')).rejects.toThrow(/outside the project root/);
  });
});

// `buildProject` is mocked (above) for every test in the `regenerate` describe block --
// deliberately, per the brief: this task tests orchestration and Tree writes, not process-
// spawning mechanics. These tests exercise the *real*, unmocked `buildProject` directly
// (via `jest.requireActual`, which bypasses the `jest.mock` call at the top of this file)
// to prove the shell-injection fix and its consequences: no shell on any platform, no
// `npx`, a validated project name, and an actionable message when the target project
// doesn't have `@nestjs/cli` installed.
describe('buildProject (real implementation)', () => {
  const { buildProject: realBuildProject } = jest.requireActual('../src/regenerate/build-project');

  it('spawns node directly against the resolved nest CLI bin, with no shell and no npx', async () => {
    // @nestjs/cli is not (and must not become, per this task's "no dependency changes"
    // constraint) an actual dependency of this package, so a real installed copy isn't
    // available to resolve against. Build a throwaway fake project root with just enough
    // of a node_modules layout for `require.resolve(..., { paths: [projectRoot] })` to
    // find a real file, so the resolution the implementation performs is genuinely
    // exercised rather than mocked away.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'regenerate-build-project-'));
    const binDir = path.join(tempRoot, 'node_modules', '@nestjs', 'cli', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const nestBin = path.join(binDir, 'nest.js');
    fs.writeFileSync(nestBin, '// stub nest CLI bin for tests\n');

    // child_process is a Node built-in (a singleton module instance regardless of which
    // file calls `require('child_process')`), so spying on it here intercepts the exact
    // same `spawn` reference build-project.ts holds.
    const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
      on: (event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0);
      },
    } as unknown as ChildProcess);

    try {
      await realBuildProject(tempRoot, 'api');

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawnSpy.mock.calls[0];
      expect(command).toBe(process.execPath);
      expect(args).toEqual([nestBin, 'build', 'api']);
      expect((options as Record<string, unknown>).shell).toBeUndefined();
      expect((options as Record<string, unknown>).cwd).toBe(tempRoot);
    } finally {
      spawnSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a project name containing shell metacharacters before spawning anything', async () => {
    const spawnSpy = jest.spyOn(childProcess, 'spawn');

    try {
      await expect(realBuildProject(process.cwd(), 'evil; rm -rf /')).rejects.toThrow(
        /Invalid project name/,
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('rejects with an actionable message when @nestjs/cli is not resolvable from the project', async () => {
    // This repo's own root is real ambient state for this case: the package only
    // peer-depends on @nestjs/schematics, and @nestjs/cli is genuinely not installed here.
    await expect(realBuildProject(process.cwd())).rejects.toThrow(/@nestjs\/cli/);
  });
});
