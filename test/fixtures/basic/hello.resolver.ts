import { Query, Resolver } from '@nestjs/graphql';

/**
 * Bare `@Resolver()` — no name, no type function. This is the end-to-end
 * parity guard for src/emitter/harvest.ts's `Reflect.hasMetadata` fix: a
 * truthiness test on `Reflect.getMetadata(RESOLVER_TYPE_METADATA, ...)`
 * silently drops this class, because `@Resolver()` with no argument still
 * *defines* the metadata key — just with the value `undefined` — while the
 * boot path's `ResolversExplorerService.getAllCtors` applies no metadata
 * filter at all and keeps it regardless. Confirmed by hand during that fix:
 * a real boot emits `hello` + `recipes`; the truthiness-test version of
 * harvest() emitted only `recipes`. See test/harvest.spec.ts for the unit
 * level pin and test/parity.spec.ts for the byte-identical SDL this fixture
 * feeds.
 */
@Resolver()
export class HelloResolver {
  @Query(() => String)
  hello(): string {
    return 'hello';
  }
}
