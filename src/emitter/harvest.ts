import 'reflect-metadata';

export const RESOLVER_TYPE_METADATA = 'graphql:resolver_type';
export const SCALAR_NAME_METADATA = 'graphql:scalar_name';
export const SCALAR_TYPE_METADATA = 'graphql:scalar_type';

export interface ModuleLike {
  metatype?: Function | null;
  providers: Map<unknown, { metatype?: Function | null }>;
  /** `@nestjs/core`'s `Module.imports` is a `Set<Module>`. */
  imports?: Iterable<ModuleLike>;
}

export interface ContainerLike {
  values(): Iterable<ModuleLike>;
}

/**
 * The module set `include` selects, computed the way
 * `@nestjs/graphql`'s `BaseExplorerService.getModules` computes it.
 *
 * `include` is **not** a flat exact-match filter. Upstream whitelists the
 * modules named in `include`, then walks the transitive closure over each
 * one's `imports` — so `include: [AdminModule]` picks up every resolver,
 * scalar and type reachable through the modules `AdminModule` imports. A flat
 * match (what this function used to do inline) silently emits an empty
 * schema for the README's own multi-schema example, with no error and no
 * warning.
 *
 * The traversal is transcribed rather than merely reimplemented, because the
 * *order* of the resulting modules feeds the resolver order, which feeds
 * field order in the printed SDL whenever `sortSchema` is off. `pop()` (LIFO)
 * and the `includes` de-duplication are both load-bearing for byte parity.
 * `test/harvest.spec.ts` pins this against a live `BaseExplorerService`.
 */
export function selectModules(container: ContainerLike, include?: Function[]): ModuleLike[] {
  const modules = [...container.values()];
  if (!include || include.length === 0) return modules;

  const explicitlyWhitelisted = modules.filter(({ metatype }) =>
    include.some((item) => item === metatype),
  );

  const modulesToInclude: ModuleLike[] = [];
  const toCheck = [...explicitlyWhitelisted];
  while (toCheck.length) {
    const moduleRef = toCheck.pop() as ModuleLike;
    if (!modulesToInclude.includes(moduleRef)) {
      modulesToInclude.push(moduleRef);
      toCheck.push(...(moduleRef.imports ?? []));
    }
  }
  return modulesToInclude;
}

export function harvest(
  container: ContainerLike,
  include?: Function[],
): { resolvers: Function[]; scalars: Function[] } {
  const resolvers: Function[] = [];
  const scalars: Function[] = [];

  for (const module of selectModules(container, include)) {
    for (const wrapper of module.providers.values()) {
      // Known, deliberate boundary — not a bug to "fix" here. For a
      // `useFactory` provider, `metatype` is the factory function, not the
      // class it constructs, so a resolver only ever reached through a
      // factory is invisible to this check and silently dropped. Boot sees
      // it via `ResolversExplorerService.getAllCtors()`, which reads
      // `instance.constructor` — but that requires the provider to already
      // be instantiated, which is exactly what preview mode exists to avoid.
      // See README.md's "Known limitations" for the user-facing writeup and
      // workaround (register the class directly, or via `useClass`).
      const metatype = wrapper.metatype;
      if (typeof metatype !== 'function') continue;
      // `hasMetadata`, not a truthiness test on `getMetadata`. A bare
      // `@Resolver()` (no name, no type function) reaches
      // `addResolverMetadata(undefined, undefined, target)` upstream, which
      // does `SetMetadata(RESOLVER_TYPE_METADATA, resolver || name)` — i.e.
      // it *defines* the key with the value `undefined`. Testing truthiness
      // therefore drops exactly the class the boot path keeps: at boot,
      // `ResolversExplorerService.getAllCtors` maps every provider in the
      // included modules to its constructor with no metadata filter at all,
      // so a bare `@Resolver()` is unconditionally handed to
      // `GraphQLSchemaFactory.create`. Observed divergence: boot emitted
      // `hello` + `recipes`, this path emitted only `recipes`.
      if (Reflect.hasMetadata(RESOLVER_TYPE_METADATA, metatype)) resolvers.push(metatype);
      // Truthiness *is* correct here, and is not an oversight to be made
      // symmetric with the line above: `GraphQLSchemaFactory`'s
      // `addScalarTypeByClassRef` opens with
      // `if (!scalarNameMetadata) { return; }`, so a falsy `@Scalar()` name
      // registers nothing at boot either. Mirroring that bail-out is the
      // whole point.
      if (Reflect.getMetadata(SCALAR_NAME_METADATA, metatype)) scalars.push(metatype);
    }
  }

  return { resolvers, scalars };
}

/**
 * The GraphQL type a `@Scalar()` class maps onto — `@Scalar(name, () => Type)`'s
 * second argument when present, else the class itself. This is the key
 * `GraphQLSchemaBuilder` de-duplicates `scalarsMap` on; see ./build.ts.
 */
export function scalarTargetType(classRef: Function): unknown {
  const scalarTypeMetadata = Reflect.getMetadata(SCALAR_TYPE_METADATA, classRef);
  return (typeof scalarTypeMetadata === 'function' && scalarTypeMetadata()) || classRef;
}
