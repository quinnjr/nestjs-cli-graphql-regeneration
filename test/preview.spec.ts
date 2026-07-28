import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ModulesContainer } from '@nestjs/core';
import { InitializeOnPreviewAllowlist } from '@nestjs/core/inspector';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import { createPreviewContext } from '../src/emitter/preview';
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
  let hasSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  afterEach(() => {
    hasSpy?.mockRestore();
    stderrSpy?.mockRestore();
    if (existsSync(WARN_OUT)) rmSync(WARN_OUT);
    if (existsSync(OUT)) rmSync(OUT);
  });

  function stubGraphQLModuleAsStillAllowlisted(): void {
    const originalHas = InitializeOnPreviewAllowlist.has.bind(InitializeOnPreviewAllowlist);
    hasSpy = jest
      .spyOn(InitializeOnPreviewAllowlist, 'has')
      .mockImplementation((type: Function) =>
        type === GraphQLModule ? true : originalHas(type as any),
      );
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
});
