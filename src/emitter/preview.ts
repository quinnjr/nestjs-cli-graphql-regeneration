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

/**
 * Best-effort, dependency-cheap lookup of the installed `@nestjs/core`
 * version, for diagnostics only. `@nestjs/core` is a peerDependency, so the
 * version actually resolved at a user's install can differ from what this
 * repo pins in devDependencies — worth surfacing when suppression fails.
 */
function resolveNestCoreVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('@nestjs/core/package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function warnSuppressionFailed(): void {
  const version = resolveNestCoreVersion();
  process.stderr.write(
    `[nest-graphql] warning: could not remove GraphQLModule from @nestjs/core's ` +
      `preview-mode allowlist (installed @nestjs/core version: ${version}). This most ` +
      `likely means the installed @nestjs/core changed the private internals this ` +
      `suppression depends on. As a result, GraphQLModule may initialize during this ` +
      `preview boot: it can crash if the app configures GraphQLModule with forRootAsync ` +
      `and an injected dependency, and it may write the app's configured schema file as ` +
      `a side effect.\n`,
  );
}

function augmentPreviewBootError(err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const augmented = new Error(
    `Preview boot failed while GraphQLModule could not be excluded from @nestjs/core's ` +
      `preview allowlist (installed @nestjs/core version: ${resolveNestCoreVersion()}). ` +
      `GraphQLModule likely initialized during preview and caused this failure — see the ` +
      `warning above. Original error: ${original.message}`,
  );
  (augmented as Error & { cause?: unknown }).cause = original;
  if (original.stack) augmented.stack = `${augmented.message}\n${original.stack}`;
  return augmented;
}

export async function createPreviewContext(
  appModule: unknown,
): Promise<INestApplicationContext> {
  suppressGraphQLModulePreviewInit();

  // The authoritative signal is whether GraphQLModule is *still* allowlisted
  // after our attempt, not the raw delete() result: within one process,
  // repeat calls legitimately return `false` from delete() once the entry is
  // already gone, which is a success state, not a failure. `has()` is the
  // one other public method the allowlist guarantees, so this check does not
  // add any further reliance on private internals beyond what
  // `suppressGraphQLModulePreviewInit` already takes on.
  const stillAllowlisted = InitializeOnPreviewAllowlist.has(GraphQLModule);
  if (stillAllowlisted) warnSuppressionFailed();

  try {
    return await NestFactory.createApplicationContext(appModule as any, {
      preview: true,
      abortOnError: false,
      logger: false,
    });
  } catch (err) {
    if (stillAllowlisted) throw augmentPreviewBootError(err);
    throw err;
  }
}
