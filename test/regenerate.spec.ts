import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { SchematicsException, Tree } from '@angular-devkit/schematics';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { ChildProcess } from 'child_process';
import * as childProcess from 'child_process';

// Imported statically so the mocked bindings are available directly. `vi.mock` is
// hoisted above these imports, so both names resolve to the mock, not the real module
// -- the Vitest equivalent of Jest's in-test `require()` of a mocked path.
import { spawnEmitter } from '../src/emitter/spawn';
import { buildProject } from '../src/regenerate/build-project';
import * as projectModule from '../src/config/project';
import * as regenerateFactory from '../src/regenerate/index';
import { publishForSchematicsRequire } from './helpers/schematics-require-bridge';

// A pass-through mock, purely to make `child_process` spy-able.
//
// The `buildProject (real implementation)` block below intercepts `spawn` so the real
// implementation can be driven without launching anything. Under ts-jest both this file
// and build-project.ts compiled to CommonJS, so `require('child_process')` handed both the
// same singleton `module.exports` object and patching it here was enough. Vitest resolves
// `import { spawn } from 'child_process'` to a genuine ES module namespace instead: its
// properties are non-configurable and non-writable, so `vi.spyOn` reports "Module namespace
// is not configurable in ESM" and a direct assignment throws outright. Re-exporting the real
// module through `vi.mock` replaces that namespace with a configurable one — same functions,
// same instance for every importer including build-project.ts (which the tests below load
// with `vi.importActual`), but now patchable. Nothing is stubbed: every export is the real
// one until an individual test spies on it.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
}));

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

// @angular-devkit/schematics resolves `src/collection.json`'s factory with Node's own
// `require`, which can neither load `.ts` nor see the `vi.mock` calls above. Publishing the
// module Vitest already built (against those mocks) under its source path is what ts-jest's
// single CJS registry used to do implicitly.
publishForSchematicsRequire(
  path.join(__dirname, '..', 'src', 'regenerate', 'index.ts'),
  regenerateFactory,
);

const collectionPath = path.join(__dirname, '..', 'src', 'collection.json');

function treeWithNestCli(json: object): Tree {
  const tree = Tree.empty();
  tree.create('/nest-cli.json', JSON.stringify(json));
  return tree;
}

describe('regenerate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the schema file returned by the emitter', async () => {
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

    // Positive control for the two `expect(overwriteSpy).not.toHaveBeenCalled()`
    // assertions guarding the "up to date" short-circuit. Those are proven only
    // negatively, on a `Tree` handed to `SchematicTestRunner` -- and devkit does wrap
    // the Tree in a `ScopedTree` when `executionOptions.scope` is set. If the
    // observation point ever stops matching the object the Rule actually mutates, a
    // spy that can never fire makes both of them vacuously true and silently stops
    // guarding anything. This asserts the same spy on the same kind of Tree *does*
    // fire when the Rule takes the other branch, so the pair brackets the branch.
    const overwriteSpy = vi.spyOn(tree, 'overwrite');

    const result = await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(result.readContent('/src/schema.gql')).not.toContain('stale');
    expect(overwriteSpy).toHaveBeenCalledWith('/src/schema.gql', 'type Query {\n  ok: String\n}\n');
  });

  // `schemaName` is the whole of multi-schema support (`nest g regenerate admin`), and
  // it was reachable by exactly one value: every test passed 'default', so replacing
  // `options.name ?? 'default'` with the literal 'default' left the suite green. The
  // failure that hides behind is silent and destructive -- it regenerates the *default*
  // schema and writes it over admin.gql.
  it('forwards a named schema through to the emitter', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);

    await runner.runSchematic('regenerate', { name: 'admin' }, treeWithNestCli({ sourceRoot: 'src' }));

    expect(spawnEmitter).toHaveBeenCalledWith(expect.objectContaining({ schemaName: 'admin' }));
  });

  it('falls back to the "default" schema when no name is given', async () => {
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);

    await runner.runSchematic('regenerate', {}, treeWithNestCli({ sourceRoot: 'src' }));

    expect(spawnEmitter).toHaveBeenCalledWith(expect.objectContaining({ schemaName: 'default' }));
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
    const overwriteSpy = vi.spyOn(tree, 'overwrite');

    const result = await runner.runSchematic('regenerate', { name: 'default' }, tree);

    expect(messages.join('\n')).toMatch(/up to date/);
    expect(result.readContent('/src/schema.gql')).toBe('type Query {\n  ok: String\n}\n');
    expect(overwriteSpy).not.toHaveBeenCalled();
  });

  it('passes the project name through to the build step and the resolved paths to the emitter', async () => {
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

  // `nest g` exits 0 even when a schematic throws, so the exception the Rule raises is
  // the entire user-facing signal. The Rule's comment claimed "every failure in this
  // Rule surfaces with the same SchematicsException framing" while only resolveProject
  // was actually wrapped; buildProject and spawnEmitter escaped as plain Errors. These
  // pin all three, and pin that wrapping does not swallow the original message.
  describe.each([
    ['build', vi.mocked(buildProject), '"nest build" exited with code 1.'],
    ['emitter', vi.mocked(spawnEmitter), 'Emitter exited with code 1: boom'],
  ] as const)('a %s failure', (_label, mockedExport, message) => {
    it('surfaces as a SchematicsException with the original message intact', async () => {
      mockedExport.mockRejectedValueOnce(new Error(message));
      const runner = new SchematicTestRunner('nest-graphql', collectionPath);

      const error = await runner
        .runSchematic('regenerate', { name: 'default' }, treeWithNestCli({ sourceRoot: 'src' }))
        .then(
          () => undefined,
          (err: unknown) => err as Error,
        );

      expect(error).toBeInstanceOf(SchematicsException);
      expect(error!.message).toBe(message);
    });
  });

  it('refuses a dist root that escapes the project root', async () => {
    // The check on `root` inside resolveProject makes this unreachable through today's
    // call path -- which is exactly why the containment check is *also* applied where
    // the value is used. `distRoot` is what gets require()d (config and app module
    // alike), so it is re-verified at the point of use rather than trusted from a
    // `ResolvedProject` that some future caller might construct another way.
    const spy = vi
      .spyOn(projectModule, 'resolveProject')
      .mockReturnValue({ distRoot: path.join('..', '..', 'etc') });
    const runner = new SchematicTestRunner('nest-graphql', collectionPath);

    try {
      await expect(
        runner.runSchematic('regenerate', { name: 'default' }, treeWithNestCli({ sourceRoot: 'src' })),
      ).rejects.toThrow(/outside the project root/);
    } finally {
      spy.mockRestore();
    }
  });

  it('probes the nested dist/src/ layout for the app module, like the config lookup does', async () => {
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
  beforeEach(() => vi.clearAllMocks());

  function runWithOutFile(outFile: string, tree = treeWithNestCli({ sourceRoot: 'src' })) {
    vi.mocked(spawnEmitter).mockResolvedValueOnce({
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
    const overwriteSpy = vi.spyOn(tree, 'overwrite');

    vi.mocked(spawnEmitter).mockResolvedValueOnce({
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

  it('refuses a path resolving to the project root itself, with its own message', async () => {
    // Trivially reachable (`autoSchemaFile: process.cwd()`) and distinct from the
    // escaping cases above: the path is *inside* the project, there is just nothing
    // left over to be a filename. It carries its own message precisely so the user is
    // not told their in-project path is "outside the project root"; asserting on that
    // wording is what keeps the two branches from being collapsed into one.
    await expect(runWithOutFile(process.cwd())).rejects.toThrow(/the project root itself/);
  });

  it('refuses a "./"-shaped path resolving to the project root itself', async () => {
    await expect(runWithOutFile('./')).rejects.toThrow(/the project root itself/);
  });
});

// `buildProject` is mocked (above) for every test in the `regenerate` describe block --
// deliberately, per the brief: this task tests orchestration and Tree writes, not process-
// spawning mechanics. These tests exercise the *real*, unmocked `buildProject` directly
// (via `vi.importActual`, which bypasses the `vi.mock` call at the top of this file)
// to prove the shell-injection fix and its consequences: no shell on any platform, no
// `npx`, a validated project name, and an actionable message when the target project
// doesn't have `@nestjs/cli` installed.
describe('buildProject (real implementation)', () => {
  // Vitest's un-mocked-module escape hatch is async (`importActual`), unlike Jest's
  // synchronous `requireActual`, so the binding is resolved in beforeAll rather than
  // in the describe body. Same effect: every test below runs against the real module.
  let realBuildProject: typeof import('../src/regenerate/build-project').buildProject;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/regenerate/build-project')>(
      '../src/regenerate/build-project',
    );
    realBuildProject = actual.buildProject;
  });

  // @nestjs/cli is not (and must not become, per this task's "no dependency changes"
  // constraint) an actual dependency of this package, so a real installed copy isn't
  // available to resolve against. Build a throwaway fake project root with just enough
  // of a node_modules layout for `require.resolve(..., { paths: [projectRoot] })` to
  // find a real file, so the resolution the implementation performs is genuinely
  // exercised rather than mocked away.
  function makeFakeNestProject(): { tempRoot: string; nestBin: string; cleanup: () => void } {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'regenerate-build-project-'));
    const binDir = path.join(tempRoot, 'node_modules', '@nestjs', 'cli', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const nestBin = path.join(binDir, 'nest.js');
    fs.writeFileSync(nestBin, '// stub nest CLI bin for tests\n');
    return {
      tempRoot,
      nestBin,
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    };
  }

  // A child process stand-in that *stores* its listeners instead of invoking one
  // immediately, so a test can decide which event fires and when. The always-close(0)
  // stub used previously could only ever drive the success path, which left both
  // rejection branches -- and, more importantly, the fact that the 'error' listener is
  // registered at all -- completely unexercised.
  function fakeChild() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const child = {
      on(event: string, cb: (...args: unknown[]) => void) {
        const forEvent = listeners.get(event) ?? [];
        forEvent.push(cb);
        listeners.set(event, forEvent);
        return child;
      },
    };
    return {
      child: child as unknown as ChildProcess,
      emit(event: string, ...args: unknown[]) {
        const forEvent = listeners.get(event) ?? [];
        expect(forEvent.length).toBeGreaterThan(0);
        for (const cb of forEvent) cb(...args);
      },
    };
  }

  it('spawns node directly against the resolved nest CLI bin, with no shell and no npx', async () => {
    const { tempRoot, nestBin, cleanup } = makeFakeNestProject();

    // child_process is a Node built-in (a singleton module instance regardless of which
    // file calls `require('child_process')`), so spying on it here intercepts the exact
    // same `spawn` reference build-project.ts holds.
    const fake = fakeChild();
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockReturnValue(fake.child);

    try {
      const promise = realBuildProject(tempRoot, 'api');
      fake.emit('close', 0);
      await promise;

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawnSpy.mock.calls[0];
      expect(command).toBe(process.execPath);
      expect(args).toEqual([nestBin, 'build', 'api']);
      expect((options as Record<string, unknown>).shell).toBeUndefined();
      expect((options as Record<string, unknown>).cwd).toBe(tempRoot);
    } finally {
      spawnSpy.mockRestore();
      cleanup();
    }
  });

  it('rejects with the exit code when "nest build" fails', async () => {
    const { tempRoot, cleanup } = makeFakeNestProject();
    const fake = fakeChild();
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockReturnValue(fake.child);

    try {
      const promise = realBuildProject(tempRoot, 'api');
      fake.emit('close', 1);
      await expect(promise).rejects.toThrow(/"nest build" exited with code 1/);
    } finally {
      spawnSpy.mockRestore();
      cleanup();
    }
  });

  it('rejects when the child process cannot be launched at all', async () => {
    // Without a shell, an unlaunchable command surfaces as an 'error' event and never a
    // 'close'. The 'error' listener exists for exactly that: unhandled, the promise
    // stays pending forever and `nest g` hangs. Nothing verified it was wired, and
    // deleting it broke no test -- so this drives it directly.
    const { tempRoot, cleanup } = makeFakeNestProject();
    const fake = fakeChild();
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockReturnValue(fake.child);

    try {
      const promise = realBuildProject(tempRoot, 'api');
      fake.emit('error', new Error('spawn ENOENT'));
      await expect(promise).rejects.toThrow(/Failed to spawn "nest build": spawn ENOENT/);
    } finally {
      spawnSpy.mockRestore();
      cleanup();
    }
  });

  it('rejects a project name containing shell metacharacters before spawning anything', async () => {
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    try {
      await expect(realBuildProject(process.cwd(), 'evil; rm -rf /')).rejects.toThrow(
        /Invalid project name/,
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Argument injection is what survives removing the shell. The name is appended to
  // `nest build`, so `-w` becomes `nest build -w` -- watch mode, which never exits, so
  // 'close' never fires, the promise never settles, and CI hangs until it times out.
  // `-c<file>` is quieter and worse: it builds against a different tsconfig than the one
  // this schematic parsed. The old pattern `/^[A-Za-z0-9._-]+$/` accepted every one of
  // these, while its own comment claimed to cover "the whole category of shell/argument
  // injection".
  it.each(['-w', '--watch', '-c/tmp/evil.json', '-'])(
    'rejects the flag-shaped project name "%s" before spawning anything',
    async (projectName) => {
      // A project root where `@nestjs/cli` genuinely resolves, so nothing *except* the
      // name check stands between this call and a real spawn.
      const { tempRoot, cleanup } = makeFakeNestProject();
      const spawnSpy = vi.spyOn(childProcess, 'spawn');

      try {
        const error = await realBuildProject(tempRoot, projectName).then(
          () => undefined,
          (err: unknown) => err as Error,
        );

        expect(error).toBeInstanceOf(Error);
        expect(error!.message).toMatch(/Invalid project name/);
        // The message has to say *why*, or a user whose project really is called
        // something odd has no idea what to change.
        expect(error!.message).toMatch(/may not begin with "-"/);
        expect(spawnSpy).not.toHaveBeenCalled();
      } finally {
        spawnSpy.mockRestore();
        cleanup();
      }
    },
  );

  it('still accepts a name with an interior dash', async () => {
    // The fix restricts the *first* character only; "back-office" is an ordinary
    // nest-cli.json project name and must keep working.
    const { tempRoot, nestBin, cleanup } = makeFakeNestProject();
    const fake = fakeChild();
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockReturnValue(fake.child);

    try {
      const promise = realBuildProject(tempRoot, 'back-office');
      fake.emit('close', 0);
      await promise;

      expect(spawnSpy.mock.calls[0][1]).toEqual([nestBin, 'build', 'back-office']);
    } finally {
      spawnSpy.mockRestore();
      cleanup();
    }
  });

  it('rejects with an actionable message when @nestjs/cli is not resolvable from the project', async () => {
    // This repo's own root is real ambient state for this case: the package only
    // peer-depends on @nestjs/schematics, and @nestjs/cli is genuinely not installed here.
    await expect(realBuildProject(process.cwd())).rejects.toThrow(/@nestjs\/cli/);
  });
});
