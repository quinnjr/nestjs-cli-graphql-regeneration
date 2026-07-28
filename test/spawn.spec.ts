import { mkdtempSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { spawnEmitter } from '../src/emitter/spawn';
import { resolveDistFile } from '../src/config/dist-layout';
import { APP_MODULE_BASENAME } from '../src/config/resolve';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Point spawn.ts's `resolveChildEntry` at a throwaway file for the duration of
 * `fn`, then put `NEST_GRAPHQL_CHILD_ENTRY` back exactly as it was.
 *
 * A few failure paths (no compiled entry at all; a child that speaks the
 * protocol wrongly; a child killed by a signal) can't be reached through the
 * public `EmitRequest` surface — the child has to be replaced. These tests used
 * to do that by renaming or overwriting the *real* `dist/emitter/child.js` in
 * place and restoring it in a `finally`. That works right up until it doesn't:
 * a Jest timeout, a `--bail` abort or a crash between the two halves leaves the
 * repo's own build output replaced by a stub, and the next bare `vitest` run then
 * tests the stub without saying so. Nothing here touches `dist/` any more.
 */
async function withChildEntry<T>(entry: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NEST_GRAPHQL_CHILD_ENTRY;
  process.env.NEST_GRAPHQL_CHILD_ENTRY = entry;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NEST_GRAPHQL_CHILD_ENTRY;
    else process.env.NEST_GRAPHQL_CHILD_ENTRY = previous;
  }
}

const GRAPHQL_CONFIG_JS =
  `module.exports.schemas = { default: { autoSchemaFile: 'src/schema.gql', sortSchema: true } };`;

describe('spawnEmitter', () => {
  it('returns SDL from a child process', async () => {
    const dir = tempDir('gqlspawn-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const result = await spawnEmitter({
      projectRoot: process.cwd(),
      distRoot,
      appModulePath: path.join(distRoot, 'basic', 'app.module.js'),
      schemaName: 'default',
    });

    expect(result.ok).toBe(true);
    expect(result.sdl).toContain('type Recipe');
    expect(result.outFile).toBe('src/schema.gql');
  });

  it('is not confused by user code logging to stdout before the payload', async () => {
    // The failure this protects against is silent and total: the emitter
    // shares stdout with `require(appModulePath)` and the whole preview boot,
    // so one config banner, dotenv debug line or ORM deprecation notice at
    // require time used to turn a correct schema into
    // "Emitter produced no usable output."
    const dir = tempDir('gqlspawn-noisy-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    // A module that chatters on stdout at require time, then re-exports the
    // real app module — the exact shape of a noisy dependency.
    const noisyModulePath = path.join(distRoot, 'noisy-app.module.js');
    writeFileSync(
      noisyModulePath,
      `console.log('[db] connected to postgres://localhost:5432');\n` +
        `console.log(JSON.stringify({ ok: true, sdl: 'IMPOSTOR', outFile: 'nope.gql' }));\n` +
        `process.stdout.write('trailing chatter with no newline');\n` +
        `module.exports = require('./basic/app.module');\n`,
    );

    const result = await spawnEmitter({
      projectRoot: process.cwd(),
      distRoot,
      appModulePath: noisyModulePath,
      schemaName: 'default',
    });

    expect(result.ok).toBe(true);
    expect(result.sdl).toContain('type Recipe');
    // Specifically: a well-formed impostor payload on stdout must not be able
    // to impersonate the real one.
    expect(result.sdl).not.toContain('IMPOSTOR');
    expect(result.outFile).toBe('src/schema.gql');
  });

  it('composes the nested dist/src/ layout: config and app module both under src/', async () => {
    const dir = tempDir('gqlspawn-nested-');
    const distRoot = path.join(dir, 'dist');
    const nested = path.join(distRoot, 'src');
    mkdirSync(nested, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), nested, { recursive: true });
    // Candidate #2 for the config...
    writeFileSync(path.join(nested, 'graphql.config.js'), GRAPHQL_CONFIG_JS);
    // ...and candidate #2 for the app module, resolved through the same helper
    // regenerate/index.ts uses, so this proves the two halves agree.
    writeFileSync(
      path.join(nested, 'app.module.js'),
      `module.exports = require('./basic/app.module');\n`,
    );

    const result = await spawnEmitter({
      projectRoot: process.cwd(),
      distRoot,
      appModulePath: resolveDistFile(distRoot, APP_MODULE_BASENAME),
      schemaName: 'default',
    });

    expect(result.sdl).toContain('type Recipe');
  });

  it('surfaces the child error message on failure', async () => {
    await expect(
      spawnEmitter({
        projectRoot: process.cwd(),
        distRoot: '/nonexistent',
        appModulePath: '/nonexistent/app.module.js',
        schemaName: 'default',
      }),
    ).rejects.toThrow(/graphql\.config\.js|Cannot find module/);
  });

  it('rejects rather than crashing the parent when the child fails to spawn', async () => {
    // A nonexistent cwd makes the underlying spawn() call itself fail: Node
    // emits 'error' on the ChildProcess before it ever starts. Confirmed by
    // hand that, without an 'error' listener, this is an *unhandled* 'error'
    // event — which throws and takes down the process emitting it (here,
    // the test process itself) rather than merely failing this one test.
    const projectRoot = path.join(tmpdir(), `gqlspawn-unspawnable-${Date.now()}`);

    await expect(
      spawnEmitter({
        projectRoot,
        distRoot: path.join(projectRoot, 'dist'),
        appModulePath: path.join(projectRoot, 'dist', 'app.module.js'),
        schemaName: 'default',
      }),
    ).rejects.toThrow(/spawn|ENOENT/i);
  });

  it('does not truncate a large error payload from the child', async () => {
    // Regression test. An earlier protocol wrote the payload to stdout and
    // called process.exit() immediately after — process.exit() does not wait
    // for an asynchronous, piped write to flush, so a large err.stack —
    // plausible for a deep Nest DI failure — could be cut off. Confirmed by
    // hand that a 5,000,000-char payload written this way and immediately
    // followed by process.exit(1) reliably truncates around ~146KB over a
    // real OS pipe. child.ts now writes the payload with a synchronous,
    // short-write-tolerant loop (writeSync) to the dedicated descriptor in
    // ./protocol.ts, and only calls process.exit() explicitly (0 on success,
    // 1 on failure) once that write loop has already completed — so every
    // byte is in the kernel's hands before the process ever ends, and a
    // child that would otherwise hang the CLI open (an app module's stray
    // setInterval or DB client) can't do so.
    const dir = tempDir('gqlspawn-large-error-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const bigMessage = 'X'.repeat(5_000_000);
    const bigModulePath = path.join(distRoot, 'large-error.js');
    writeFileSync(bigModulePath, `throw new Error(${JSON.stringify(bigMessage)});`);

    let caught: Error | undefined;
    try {
      await spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: bigModulePath,
        schemaName: 'default',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toBe(bigMessage);
  });

  it('attaches the child\'s stack to the rejected error', async () => {
    // EmitFailure has carried `stack` since the protocol was written and the
    // child has always populated it, but the parent used to drop it on the
    // floor -- discarding the only stack that describes what actually failed
    // inside the child's preview boot. The large-payload test above exists
    // precisely to keep a deep Nest DI stack intact in transit; that is
    // pointless if it is then thrown away on arrival.
    const dir = tempDir('gqlspawn-stack-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const throwingModulePath = path.join(distRoot, 'thrower.js');
    writeFileSync(
      throwingModulePath,
      `function deepFrameForTheStack() { throw new Error('boom from the child'); }\n` +
        `deepFrameForTheStack();\n`,
    );

    let caught: Error | undefined;
    try {
      await spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: throwingModulePath,
        schemaName: 'default',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toBe('boom from the child');
    expect(caught!.stack).toContain('deepFrameForTheStack');
    expect(caught!.stack).toContain('thrower.js');
  });

  it('surfaces a clear error when the child dies without producing usable output', async () => {
    // Exercises the branch that exists precisely for cases like
    // @nestjs/common's loadPackage calling process.exit(1) directly: some
    // code reachable from the required app module exits before ever calling
    // writePayload — i.e. before anything reaches the dedicated payload
    // descriptor in ./protocol.ts. A raw process.exit() at require-time
    // reproduces that shape without needing real Nest internals.
    const dir = tempDir('gqlspawn-no-output-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const explodingModulePath = path.join(distRoot, 'exit-before-output.js');
    writeFileSync(explodingModulePath, `process.exit(1);\n`);

    await expect(
      spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: explodingModulePath,
        schemaName: 'default',
      }),
    ).rejects.toThrow(/produced no usable output/i);
  });

  it('resolves a module that is reachable only via NODE_PATH', async () => {
    // Proves the NODE_PATH fallback mechanism itself works, independent of
    // its (unproven) precedence relative to the ordinary ancestor walk: the
    // marker package below lives only under a fake project root's
    // node_modules, and the "app module" that requires it lives in a wholly
    // unrelated directory tree, so the ordinary node_modules ancestor walk
    // from the app module's own location can never reach it. The only way
    // this resolves is via NODE_PATH, which spawnEmitter sets to
    // <projectRoot>/node_modules.
    const projectRoot = tempDir('gqlspawn-nodepath-project-');
    const markerDir = path.join(projectRoot, 'node_modules', 'only-via-nodepath-marker');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      path.join(markerDir, 'package.json'),
      JSON.stringify({ name: 'only-via-nodepath-marker', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(path.join(markerDir, 'index.js'), `module.exports = 'FOUND_VIA_NODE_PATH';`);
    // spawnEmitter always preloads `-r reflect-metadata`, resolved the same
    // way as any other bare specifier (via NODE_PATH, since projectRoot here
    // has no ordinary ancestor chain to our repo). Give this fake project its
    // own copy so that preload doesn't fail before the probe module even runs.
    cpSync(
      path.join(__dirname, '..', 'node_modules', 'reflect-metadata'),
      path.join(projectRoot, 'node_modules', 'reflect-metadata'),
      { recursive: true },
    );

    const otherDir = tempDir('gqlspawn-unrelated-');
    const distRoot = path.join(otherDir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const probeModulePath = path.join(distRoot, 'nodepath-probe.js');
    writeFileSync(
      probeModulePath,
      `throw new Error('MARKER:' + require('only-via-nodepath-marker'));`,
    );

    await expect(
      spawnEmitter({
        projectRoot,
        distRoot,
        appModulePath: probeModulePath,
        schemaName: 'default',
      }),
    ).rejects.toThrow('MARKER:FOUND_VIA_NODE_PATH');
  });

  it('rejects rather than throws when the compiled child entry is missing', async () => {
    const dir = tempDir('gqlspawn-missing-entry-');
    // A path that deliberately does not exist, so resolveChildEntry's
    // existsSync probe fails over its only candidate.
    const absentEntry = path.join(dir, 'child.js');

    await withChildEntry(absentEntry, async () => {
      await expect(
        spawnEmitter({
          projectRoot: process.cwd(),
          distRoot: '/nonexistent',
          appModulePath: '/nonexistent/app.module.js',
          schemaName: 'default',
        }),
      ).rejects.toThrow(/Could not find the compiled emitter child entry/);
    });
  });

  it('surfaces a clear error for parseable-but-wrong-shaped child output', async () => {
    const dir = tempDir('gqlspawn-wrong-shape-');
    // Writes to the dedicated payload descriptor, not stdout: the result
    // payload moved off stdout so a `console.log` in user code can no longer
    // corrupt it (see src/emitter/protocol.ts). A stub emulating the child
    // has to emulate the protocol it actually speaks — on stdout this blob
    // would now be indistinguishable from ordinary user output, which is
    // precisely the property the move buys.
    const stubEntry = path.join(dir, 'wrong-shape-child.js');
    writeFileSync(
      stubEntry,
      `require('fs').writeSync(3, JSON.stringify({ unexpected: 'shape' }));\n`,
    );

    const caught = await withChildEntry(stubEntry, async () => {
      try {
        await spawnEmitter({
          projectRoot: process.cwd(),
          distRoot: '/nonexistent',
          appModulePath: '/nonexistent/app.module.js',
          schemaName: 'default',
        });
      } catch (err) {
        return err as Error;
      }
      return undefined;
    });

    expect(caught).toBeDefined();
    expect(caught!.message).not.toBe('undefined');
    expect(caught!.message).toMatch(/unexpected output/i);
  });

  it('does not corrupt multi-byte characters that straddle a pipe chunk boundary', async () => {
    // Regression test. The payload arrives as a stream of arbitrarily-sized
    // Buffers, and a UTF-8 sequence routinely straddles two of them. Decoding
    // each chunk independently (`payload += chunk.toString()`) turns every
    // split sequence into U+FFFD — and the damage is *silent*: the JSON still
    // parses, so a mangled SDL would be written to the user's schema file
    // rather than failing loudly. Measured 8 replacement characters in a
    // 200 KB non-ASCII payload before spawn.ts called setEncoding('utf8').
    //
    // The existing 5 MB 'X'.repeat() test above cannot catch this: pure ASCII
    // is one byte per character, so no chunk boundary can ever split one.
    // What matters here is byte-width variety (2, 3 and 4-byte sequences) and
    // enough total volume to cross many chunk boundaries, not raw size.
    const dir = tempDir('gqlspawn-utf8-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    // 15 UTF-8 bytes per unit across four different sequence widths, so only
    // 5 of every 15 byte offsets fall on a character boundary.
    const unit = 'é—漢字🎉';
    const bigMessage = unit.repeat(60_000); // ~900 KB, well over a dozen chunks
    const modulePath = path.join(distRoot, 'utf8-error.js');
    writeFileSync(modulePath, `throw new Error(${JSON.stringify(bigMessage)});`);

    let caught: Error | undefined;
    try {
      await spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: modulePath,
        schemaName: 'default',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain('�');
    expect(caught!.message).toBe(bigMessage);
  });

  it('reports the child exit code when it dies without producing output', async () => {
    // "Emitter produced no usable output" on its own describes the absence of
    // a payload and nothing about the cause. The exit status is the only thing
    // that distinguishes a child that exited cleanly having written nothing
    // from one that failed — and Node hands it to the 'close' listener for
    // free, so discarding it was pure loss.
    const dir = tempDir('gqlspawn-exit-code-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const exitingModulePath = path.join(distRoot, 'exit-7.js');
    writeFileSync(exitingModulePath, `process.exit(7);\n`);

    await expect(
      spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: exitingModulePath,
        schemaName: 'default',
      }),
    ).rejects.toThrow(/produced no usable output \(exited with code 7\)/i);
  });

  it('reports the killing signal when the child is killed', async () => {
    // The case this finding was actually about: an OOM kill. The kernel sends
    // SIGKILL, the child writes nothing, there is no stderr and no exit code —
    // so without the signal the user is told only "produced no usable output"
    // for what is really "your machine ran out of memory". A child that kills
    // itself reproduces exactly that shape.
    const dir = tempDir('gqlspawn-signal-');
    const stubEntry = path.join(dir, 'self-kill-child.js');
    writeFileSync(stubEntry, `process.kill(process.pid, 'SIGKILL');\n`);

    await withChildEntry(stubEntry, async () => {
      await expect(
        spawnEmitter({
          projectRoot: process.cwd(),
          distRoot: '/nonexistent',
          appModulePath: '/nonexistent/app.module.js',
          schemaName: 'default',
        }),
      ).rejects.toThrow(/produced no usable output \(killed by signal SIGKILL\)/i);
    });
  });

  it('accepts an app module exported as `default` rather than `AppModule`', async () => {
    // src/emitter/child.ts resolves `mod.AppModule ?? mod.default`. The
    // `default` half covers a CommonJS build of `export default class
    // AppModule` — the shape `tsc` emits for a project whose entry module is a
    // default export — and had no coverage, so a regression that dropped the
    // fallback would have been caught only by a user.
    const dir = tempDir('gqlspawn-default-export-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    cpSync(path.join(__dirname, 'fixtures-dist'), distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const defaultOnlyPath = path.join(distRoot, 'default-export-app.module.js');
    writeFileSync(
      defaultOnlyPath,
      // Deliberately exports *only* `default`, so `mod.AppModule` is undefined
      // and the fallback is the only thing that can resolve this.
      `module.exports.default = require('./basic/app.module').AppModule;\n`,
    );

    const result = await spawnEmitter({
      projectRoot: process.cwd(),
      distRoot,
      appModulePath: defaultOnlyPath,
      schemaName: 'default',
    });

    expect(result.ok).toBe(true);
    expect(result.sdl).toContain('type Recipe');
  });

  it('rejects with a clear message when the app module exports neither shape', async () => {
    const dir = tempDir('gqlspawn-no-app-module-');
    const distRoot = path.join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(path.join(distRoot, 'graphql.config.js'), GRAPHQL_CONFIG_JS);

    const wrongExportPath = path.join(distRoot, 'not-an-app-module.js');
    writeFileSync(wrongExportPath, `module.exports = { somethingElse: class {} };\n`);

    await expect(
      spawnEmitter({
        projectRoot: process.cwd(),
        distRoot,
        appModulePath: wrongExportPath,
        schemaName: 'default',
      }),
    ).rejects.toThrow(/does not export AppModule/);
  });
});
