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
