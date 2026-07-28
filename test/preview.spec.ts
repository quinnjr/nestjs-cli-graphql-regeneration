import type { MockInstance } from 'vitest';
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ModulesContainer } from '@nestjs/core';
import { InitializeOnPreviewAllowlist } from '@nestjs/core/inspector';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import {
  createPreviewContext,
  suppressGraphQLModulePreviewInit,
} from '../src/emitter/preview';
import { harvest } from '../src/emitter/harvest';
import { RecipesResolver } from './fixtures/basic/recipes.resolver';

const OUT = join(__dirname, 'fixtures', 'basic', 'preview-sideeffect.gql');

@Injectable()
class RealisticConfigService {
  private readonly values = new Map([['SCHEMA', OUT]]);
  // A method, not a field — this is the shape that crashes without the fix.
  get(key: string): string {
    return this.values.get(key)!;
  }
}

@Module({ providers: [RealisticConfigService], exports: [RealisticConfigService] })
class RealisticConfigModule {}

@Module({
  imports: [
    RealisticConfigModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [RealisticConfigModule],
      inject: [RealisticConfigService],
      useFactory: (cfg: RealisticConfigService) => ({
        autoSchemaFile: cfg.get('SCHEMA'),
        sortSchema: true,
      }),
    }),
  ],
  providers: [RecipesResolver],
})
class RealisticApp {}

// A forRoot app with literal options — no injected dependency, so it keeps
// working even when suppression fails (per the "not fatal" requirement).
const WARN_OUT = join(__dirname, 'fixtures', 'basic', 'preview-warn-sideeffect.gql');

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: WARN_OUT,
      sortSchema: true,
    }),
  ],
  providers: [RecipesResolver],
})
class WarnOnlyApp {}

describe('createPreviewContext', () => {
  afterEach(() => {
    if (existsSync(OUT)) rmSync(OUT);
    if (existsSync(WARN_OUT)) rmSync(WARN_OUT);
  });

  // GUARD: fails loudly if upstream changes the allowlist's private shape.
  it('can still reach the allowlist internals it depends on', () => {
    const store = (InitializeOnPreviewAllowlist as any).allowlist;
    expect(store).toBeInstanceOf(WeakMap);
    expect(typeof store.delete).toBe('function');
    expect(typeof InitializeOnPreviewAllowlist.has).toBe('function');
  });

  it('boots an app whose forRootAsync factory calls a method on an injected dep', async () => {
    // Without the fix this rejects with
    // "TypeError: Cannot read properties of undefined (reading 'get')".
    const ctx = await createPreviewContext(RealisticApp);
    expect(ctx).toBeDefined();
    await ctx.close();
  });

  it('does not write the module-configured schema file', async () => {
    const ctx = await createPreviewContext(RealisticApp);
    expect(existsSync(OUT)).toBe(false);
    await ctx.close();
  });

  it('does not write the schema file for an app that boots either way', async () => {
    // The assertion above is real but weak on its own: RealisticApp *throws*
    // when suppression fails, so "no file" there is also satisfied by "the
    // boot exploded before GraphQLModule's onModuleInit could run" — it
    // cannot distinguish a suppressed side effect from a crash. WarnOnlyApp
    // uses literal forRoot options and boots successfully with or without
    // suppression, so here the only thing standing between preview and a
    // written file is the suppression itself.
    const ctx = await createPreviewContext(WarnOnlyApp);
    expect(existsSync(WARN_OUT)).toBe(false);
    await ctx.close();
    // Nothing written on shutdown either — this is the invariant `--dry-run`
    // depends on.
    expect(existsSync(WARN_OUT)).toBe(false);
  });

  it('still exposes resolver metatypes for harvesting', async () => {
    const ctx = await createPreviewContext(RealisticApp);
    const { resolvers } = harvest(ctx.get(ModulesContainer) as any);
    expect(resolvers).toContain(RecipesResolver);
    await ctx.close();
  });
});

describe('createPreviewContext diagnostics when suppression fails', () => {
  // Stub `has()` — the one other public method the allowlist guarantees —
  // rather than poking the private WeakMap directly. Reporting GraphQLModule
  // as still allowlisted here reproduces exactly what a real upstream rename
  // would cause: `container.js` consults the same `has()` internally to
  // decide whether to skip a type's preview initialization, so this also
  // makes GraphQLModule genuinely initialize during preview in these tests
  // — not just a fake internal flag — while every other type keeps the real,
  // unstubbed behaviour so the rest of preview mode is unaffected.
  let hasSpy: MockInstance;
  let stderrSpy: MockInstance;

  afterEach(() => {
    hasSpy?.mockRestore();
    stderrSpy?.mockRestore();
    if (existsSync(WARN_OUT)) rmSync(WARN_OUT);
    if (existsSync(OUT)) rmSync(OUT);
  });

  function stubGraphQLModuleAsStillAllowlisted(): void {
    const originalHas = InitializeOnPreviewAllowlist.has.bind(InitializeOnPreviewAllowlist);
    hasSpy = vi
      .spyOn(InitializeOnPreviewAllowlist, 'has')
      .mockImplementation((type: Function) =>
        type === GraphQLModule ? true : originalHas(type as any),
      );
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  it('warns on stderr, and still succeeds, for a forRoot app with literal options', async () => {
    stubGraphQLModuleAsStillAllowlisted();

    const ctx = await createPreviewContext(WarnOnlyApp);
    await ctx.close();

    expect(stderrSpy).toHaveBeenCalled();
    const warning = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(warning).toMatch(/could not remove GraphQLModule/);
    expect(warning).toMatch(/@nestjs\/core/);
  });

  it('augments the thrown error with suppression-failure context, preserving the original message', async () => {
    stubGraphQLModuleAsStillAllowlisted();

    // Same crash shape as the fix's target bug: GraphQLModule genuinely
    // initializes here (has() says it's exempt), while RealisticConfigService
    // is correctly skipped by real preview behaviour, so its `.get` call
    // throws exactly like the original regression.
    const bootPromise = createPreviewContext(RealisticApp);
    await expect(bootPromise).rejects.toThrow(/GraphQLModule could not be excluded/);
    // The original message is preserved verbatim inside the augmented one.
    await expect(bootPromise).rejects.toThrow(
      /Cannot read properties of undefined \(reading 'get'\)/,
    );
  });

  it('states the GraphQLModule connection as a possibility, not a verified cause', async () => {
    stubGraphQLModuleAsStillAllowlisted();

    // All this code actually knows is that suppression could not be confirmed
    // and that the boot threw. Preview still builds the module graph and runs
    // module-level user code, so the two are not necessarily related — and a
    // confidently wrong attribution sends the user hunting in the wrong file.
    let caught: Error | undefined;
    try {
      await createPreviewContext(RealisticApp);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/may be caused by GraphQLModule initializing during preview/);
    expect(caught!.message).toMatch(/may be unrelated/);
    // No unhedged causal claim.
    expect(caught!.message).not.toMatch(/caused this failure/);
  });

  it('keeps the original error reachable as `cause` and its frames in the stack', async () => {
    stubGraphQLModuleAsStillAllowlisted();

    let caught: (Error & { cause?: unknown }) | undefined;
    try {
      await createPreviewContext(RealisticApp);
    } catch (err) {
      caught = err as Error & { cause?: unknown };
    }

    expect(caught).toBeDefined();
    expect(caught!.cause).toBeInstanceOf(Error);
    // The stack is the half that survives the emitter's process boundary
    // (EmitFailure carries message + stack, never `cause`), so the augmented
    // error has to carry the original's frames itself.
    expect(caught!.stack).toContain((caught!.cause as Error).stack);
    expect(caught!.stack).toContain(caught!.message);
  });
});

describe('createPreviewContext when the allowlist itself is unreachable', () => {
  // `InitializeOnPreviewAllowlist` is private API on a peer pinned at `>=10`.
  // A *field*-shape change is handled by the `instanceof WeakMap` check, but
  // the class being removed or relocated makes the imported binding
  // `undefined`, and reading `.allowlist` off it throws before any graceful
  // path runs. These reproduce that by making the accesses themselves throw.
  let stderrSpy: MockInstance;
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
    stderrSpy?.mockRestore();
    if (existsSync(WARN_OUT)) rmSync(WARN_OUT);
    if (existsSync(OUT)) rmSync(OUT);
  });

  function makeAllowlistReadThrow(): void {
    const original = Object.getOwnPropertyDescriptor(
      InitializeOnPreviewAllowlist,
      'allowlist',
    )!;
    Object.defineProperty(InitializeOnPreviewAllowlist, 'allowlist', {
      configurable: true,
      get() {
        throw new TypeError("Cannot read properties of undefined (reading 'allowlist')");
      },
    });
    restores.push(() =>
      Object.defineProperty(InitializeOnPreviewAllowlist, 'allowlist', original),
    );
  }

  it('reports suppression as failed instead of throwing when the internals are gone', () => {
    makeAllowlistReadThrow();
    expect(() => suppressGraphQLModulePreviewInit()).not.toThrow();
    expect(suppressGraphQLModulePreviewInit()).toBe(false);
  });

  it('treats an unanswerable allowlist check as "still allowlisted" and warns', async () => {
    // Scoped to *our* lookup only — the first `has` call after the spy is
    // installed, which is createPreviewContext's own check (suppression
    // itself goes through the WeakMap, not `has`). @nestjs/core consults the
    // same method internally for every scanned type, and in the real "class
    // was removed" scenario that internal caller would not exist either, so
    // throwing for all of them would test a situation that cannot occur while
    // destroying the boot this case is meant to prove still works.
    const originalHas = InitializeOnPreviewAllowlist.has.bind(InitializeOnPreviewAllowlist);
    let ourCheckPending = true;
    const hasSpy = vi
      .spyOn(InitializeOnPreviewAllowlist, 'has')
      .mockImplementation((type: Function) => {
        if (ourCheckPending && type === GraphQLModule) {
          ourCheckPending = false;
          throw new TypeError("Cannot read properties of undefined (reading 'has')");
        }
        return originalHas(type as any);
      });
    restores.push(() => hasSpy.mockRestore());
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Not fatal: the boot still happens and still succeeds.
    const ctx = await createPreviewContext(WarnOnlyApp);
    await ctx.close();

    // "Can't tell" resolves conservatively to "suppression may have failed",
    // so the user gets the warning rather than false reassurance.
    const warning = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(warning).toMatch(/could not remove GraphQLModule/);
  });
});
