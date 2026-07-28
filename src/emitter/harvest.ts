import 'reflect-metadata';

export const RESOLVER_TYPE_METADATA = 'graphql:resolver_type';
export const SCALAR_NAME_METADATA = 'graphql:scalar_name';

export interface ModuleLike {
  metatype?: Function | null;
  providers: Map<unknown, { metatype?: Function | null }>;
}

export interface ContainerLike {
  values(): Iterable<ModuleLike>;
}

export function harvest(
  container: ContainerLike,
  include?: Function[],
): { resolvers: Function[]; scalars: Function[] } {
  const resolvers: Function[] = [];
  const scalars: Function[] = [];
  const filter = include && include.length ? new Set(include) : null;

  for (const module of container.values()) {
    if (filter && (!module.metatype || !filter.has(module.metatype))) continue;

    for (const wrapper of module.providers.values()) {
      const metatype = wrapper.metatype;
      if (typeof metatype !== 'function') continue;
      if (Reflect.getMetadata(RESOLVER_TYPE_METADATA, metatype)) resolvers.push(metatype);
      if (Reflect.getMetadata(SCALAR_NAME_METADATA, metatype)) scalars.push(metatype);
    }
  }

  return { resolvers, scalars };
}
