import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { InitializeOnPreviewAllowlist } from '@nestjs/core/inspector';
import { GraphQLModule } from '@nestjs/graphql';

/**
 * `@nestjs/graphql` allowlists GraphQLModule so it initializes even under
 * preview mode. That is wrong for us on two counts: its options factory
 * throws when it injects from a module preview did not instantiate, and its
 * onModuleInit writes the user's schema file as a side effect.
 *
 * There is no public removal API, so this reaches the private WeakMap backing
 * the allowlist. `test/preview.spec.ts` guards that shape.
 */
export function suppressGraphQLModulePreviewInit(): boolean {
  const store = (InitializeOnPreviewAllowlist as unknown as {
    allowlist?: WeakMap<object, boolean>;
  }).allowlist;

  if (!(store instanceof WeakMap)) return false;
  return store.delete(GraphQLModule as unknown as object);
}

export async function createPreviewContext(
  appModule: unknown,
): Promise<INestApplicationContext> {
  suppressGraphQLModulePreviewInit();

  return NestFactory.createApplicationContext(appModule as any, {
    preview: true,
    abortOnError: false,
    logger: false,
  });
}
