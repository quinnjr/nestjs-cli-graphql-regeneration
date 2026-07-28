import 'reflect-metadata';
import { harvest, RESOLVER_TYPE_METADATA, SCALAR_NAME_METADATA } from '../src/emitter/harvest';

function moduleOf(metatype: Function | null, ...provided: Array<Function | null>) {
  const providers = new Map<unknown, { metatype?: Function | null }>();
  provided.forEach((m, i) => providers.set(i, { metatype: m }));
  return { metatype, providers };
}

function containerOf(...modules: ReturnType<typeof moduleOf>[]) {
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

  it('collects scalars separately and skips null metatypes', () => {
    class DateScalar {}
    class AppModule {}
    Reflect.defineMetadata(SCALAR_NAME_METADATA, 'Date', DateScalar);

    const { resolvers, scalars } = harvest(containerOf(moduleOf(AppModule, DateScalar, null)));

    expect(scalars).toEqual([DateScalar]);
    expect(resolvers).toEqual([]);
  });

  it('restricts harvesting to included modules', () => {
    class AdminResolver {}
    class PublicResolver {}
    class AdminModule {}
    class PublicModule {}
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', AdminResolver);
    Reflect.defineMetadata(RESOLVER_TYPE_METADATA, 'Query', PublicResolver);

    const container = containerOf(
      moduleOf(AdminModule, AdminResolver),
      moduleOf(PublicModule, PublicResolver),
    );

    expect(harvest(container, [AdminModule]).resolvers).toEqual([AdminResolver]);
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
    const constants = require('@nestjs/graphql/dist/graphql.constants');
    expect(RESOLVER_TYPE_METADATA).toBe(constants.RESOLVER_TYPE_METADATA);
    expect(SCALAR_NAME_METADATA).toBe(constants.SCALAR_NAME_METADATA);
  });
});
