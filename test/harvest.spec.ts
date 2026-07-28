import 'reflect-metadata';
import {
  harvest,
  selectModules,
  scalarTargetType,
  RESOLVER_TYPE_METADATA,
  SCALAR_NAME_METADATA,
  SCALAR_TYPE_METADATA,
} from '../src/emitter/harvest';

interface FakeModule {
  metatype: Function | null;
  providers: Map<unknown, { metatype?: Function | null }>;
  imports: Set<FakeModule>;
}

function moduleOf(metatype: Function | null, ...provided: Array<Function | null>): FakeModule {
  const providers = new Map<unknown, { metatype?: Function | null }>();
  provided.forEach((m, i) => providers.set(i, { metatype: m }));
  return { metatype, providers, imports: new Set<FakeModule>() };
}

function imports(host: FakeModule, ...imported: FakeModule[]): FakeModule {
  imported.forEach((m) => host.imports.add(m));
  return host;
}

function containerOf(...modules: FakeModule[]) {
  return { values: () => modules };
}

describe('harvest', () => {
  it('collects classes carrying resolver metadata', () => {
    class RecipesResolver {}
    class PlainService {}
    class AppModule {}
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', RecipesResolver);

    const { resolvers } = harvest(containerOf(moduleOf(AppModule, RecipesResolver, PlainService)));

    expect(resolvers).toEqual([RecipesResolver]);
  });

  it('collects a bare @Resolver() whose metadata value is undefined', () => {
    // `@Resolver()` with no argument is legal and common — it is how you write
    // a resolver class that only carries @Query/@Mutation methods. Upstream's
    // `addResolverMetadata` does `SetMetadata(RESOLVER_TYPE_METADATA,
    // resolver || name)` with both undefined, so the key is *defined* with the
    // value `undefined`: `hasMetadata` is true, `getMetadata` is falsy. A
    // truthiness test therefore silently dropped the class, while the boot
    // path (`ResolversExplorerService.getAllCtors`, which applies no metadata
    // filter at all) kept it — observed as boot emitting `hello` + `recipes`
    // and this path emitting only `recipes`.
    //
    // Uses the real decorator rather than a hand-rolled defineMetadata, so
    // this stays pinned to what `@Resolver()` actually writes.
    const { Resolver } = require('@nestjs/graphql');

    @Resolver()
    class BareResolver {}

    @Resolver(() => String)
    class TypedResolver {}

    class AppModule {}

    expect(Reflect.getMetadata(RESOLVER_TYPE_METADATA, BareResolver)).toBeUndefined();
    expect(Reflect.hasMetadata(RESOLVER_TYPE_METADATA, BareResolver)).toBe(true);

    const { resolvers } = harvest(containerOf(moduleOf(AppModule, BareResolver, TypedResolver)));

    expect(resolvers).toEqual([BareResolver, TypedResolver]);
  });

  it('collects scalars separately and skips null metatypes', () => {
    class DateScalar {}
    class AppModule {}
    Reflect.defineMetadata(SCALAR_NAME_METADATA, 'Date', DateScalar);

    const { resolvers, scalars } = harvest(containerOf(moduleOf(AppModule, DateScalar, null)));

    expect(scalars).toEqual([DateScalar]);
    expect(resolvers).toEqual([]);
  });

  it('restricts harvesting to included modules — scalars as well as resolvers', () => {
    class AdminResolver {}
    class PublicResolver {}
    class AdminScalar {}
    class PublicScalar {}
    class AdminModule {}
    class PublicModule {}
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', AdminResolver);
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', PublicResolver);
    Reflect.defineMetadata(SCALAR_NAME_METADATA, 'AdminDate', AdminScalar);
    Reflect.defineMetadata(SCALAR_NAME_METADATA, 'PublicDate', PublicScalar);

    const container = containerOf(
      moduleOf(AdminModule, AdminResolver, AdminScalar),
      moduleOf(PublicModule, PublicResolver, PublicScalar),
    );

    const { resolvers, scalars } = harvest(container, [AdminModule]);

    expect(resolvers).toEqual([AdminResolver]);
    // A scalar leaking in from an excluded module registers a GraphQLScalarType
    // the boot path never registers, so `include` has to drop both kinds of
    // provider — not just resolvers.
    expect(scalars).toEqual([AdminScalar]);
  });

  it('follows imports transitively, exactly as `include` does at boot', () => {
    // The README's headline multi-schema example. `include: [OuterModule]`
    // must reach InnerModule's resolvers and DeepModule's beyond it; a flat
    // exact-match on module metatypes silently emits neither, with no error.
    class OuterResolver {}
    class InnerResolver {}
    class DeepResolver {}
    class DeepScalar {}
    class UnrelatedResolver {}
    class OuterModule {}
    class InnerModule {}
    class DeepModule {}
    class UnrelatedModule {}
    [OuterResolver, InnerResolver, DeepResolver, UnrelatedResolver].forEach((r) =>
      Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', r),
    );
    Reflect.defineMetadata(SCALAR_NAME_METADATA, 'DeepDate', DeepScalar);

    const deep = moduleOf(DeepModule, DeepResolver, DeepScalar);
    const inner = imports(moduleOf(InnerModule, InnerResolver), deep);
    const outer = imports(moduleOf(OuterModule, OuterResolver), inner);
    const unrelated = moduleOf(UnrelatedModule, UnrelatedResolver);

    const { resolvers, scalars } = harvest(containerOf(outer, inner, deep, unrelated), [
      OuterModule,
    ]);

    expect(resolvers).toEqual(expect.arrayContaining([OuterResolver, InnerResolver, DeepResolver]));
    expect(resolvers).not.toContain(UnrelatedResolver);
    expect(scalars).toEqual([DeepScalar]);
  });

  it('terminates on a cyclic import graph', () => {
    class AResolver {}
    class BResolver {}
    class AModule {}
    class BModule {}
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', AResolver);
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', BResolver);

    const a = moduleOf(AModule, AResolver);
    const b = moduleOf(BModule, BResolver);
    imports(a, b);
    imports(b, a); // forwardRef-style cycle; legal in Nest

    const { resolvers } = harvest(containerOf(a, b), [AModule]);

    expect(resolvers.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      AResolver,
      BResolver,
    ]);
  });

  it('selects the same modules, in the same order, as BaseExplorerService.getModules', () => {
    // The contract this whole feature rests on, pinned to upstream's live
    // implementation rather than to a transcription of it. Order matters, not
    // just membership: module order drives resolver order, which drives field
    // order in the printed SDL whenever `sortSchema` is off.
    const {
      BaseExplorerService,
    } = require('@nestjs/graphql/dist/services/base-explorer.service.js');
    const upstream = new (class extends BaseExplorerService {})();

    class M1 {}
    class M2 {}
    class M3 {}
    class M4 {}
    class M5 {}

    const m3 = moduleOf(M3);
    const m4 = moduleOf(M4);
    const m5 = moduleOf(M5);
    const m1 = imports(moduleOf(M1), m3, m4);
    const m2 = imports(moduleOf(M2), m4, m5);
    const modules = [m1, m2, m3, m4, m5];

    for (const include of [
      undefined,
      [] as Function[],
      [M1],
      [M2],
      [M1, M2],
      [M3],
      [M1, M5],
    ]) {
      const ours = selectModules(containerOf(...modules), include);
      // BaseExplorerService takes a Map-like container; `values()` is all it uses.
      const theirs = upstream.getModules(new Map(modules.map((m, i) => [i, m])), include);
      expect(ours).toEqual(theirs);
    }
  });

  it('reads a @Scalar()`s target type the way GraphQLSchemaFactory does', () => {
    class Plain {}
    class Mapped {}
    class TargetType {}
    Reflect.defineMetadata(SCALAR_TYPE_METADATA, () => TargetType, Mapped);

    expect(scalarTargetType(Plain)).toBe(Plain);
    expect(scalarTargetType(Mapped)).toBe(TargetType);
  });

  it('harvests every module when include is empty or absent', () => {
    class A {}
    class B {}
    class ModA {}
    class ModB {}
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', A);
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', B);

    const container = containerOf(moduleOf(ModA, A), moduleOf(ModB, B));

    expect(harvest(container).resolvers).toEqual([A, B]);
    expect(harvest(container, []).resolvers).toEqual([A, B]);
  });

  it('matches the metadata keys @nestjs/graphql actually uses', () => {
    const constants = require('@nestjs/graphql/dist/graphql.constants.js');
    expect(RESOLVER_TYPE_METADATA).toBe(constants.RESOLVER_TYPE_METADATA);
    expect(SCALAR_NAME_METADATA).toBe(constants.SCALAR_NAME_METADATA);
    expect(SCALAR_TYPE_METADATA).toBe(constants.SCALAR_TYPE_METADATA);
  });
});
