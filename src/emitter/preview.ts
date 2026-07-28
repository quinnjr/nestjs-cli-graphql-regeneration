import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { InitializeOnPreviewAllowlist } from '@nestjs/core/inspector';
import { GraphQLModule } from '@nestjs/graphql';
import { wrapPreservingCause } from '../wrap-error';

/**
 * `@nestjs/graphql` allowlists GraphQLModule so it initializes even under
 * preview mode. That is wrong for us on two counts: its options factory
 * throws when it injects from a module preview did not instantiate, and its
 * onModuleInit writes the user's schema file as a side effect.
 *
 * There is no public removal API, so this reaches the private WeakMap backing
 * the allowlist. `test/preview.spec.ts` guards that shape.
 *
 * The documented contract of this whole mechanism is warn-and-fall-back, not
 * crash — but a `!(store instanceof WeakMap)` check only delivers that for a
 * change to the *field*. `InitializeOnPreviewAllowlist` is private API on a
 * peer pinned at `>=10`; if the class is removed or moved, the imported
 * binding is `undefined` and reading `.allowlist` off it throws a TypeError
 * before the graceful path is ever reached. Hence the try/catch: any failure
 * to reach the internals means "suppression did not happen", which is
 * precisely what `false` reports. (The one shape this cannot absorb is the
 * `@nestjs/core/inspector` subpath itself disappearing, which fails at import
 * time, above this function.)
 */
export function suppressGraphQLModulePreviewInit(): boolean {
  try {
    const store = (InitializeOnPreviewAllowlist as unknown as {
      allowlist?: WeakMap<object, boolean>;
    }).allowlist;

    if (!(store instanceof WeakMap)) return false;
    return store.delete(GraphQLModule as unknown as object);
  } catch {
    return false;
  }
}

/**
 * Whether GraphQLModule is *still* exempt from preview suppression after our
 * attempt — the authoritative signal, since `delete()` legitimately returns
 * `false` on a repeat call within one process once the entry is already gone.
 *
 * `has()` is the one other public method the allowlist guarantees, so this
 * adds no further reliance on private internals beyond what
 * `suppressGraphQLModulePreviewInit` already takes on. It can still throw
 * outright if the class is gone (see above), and "I could not find out"
 * resolves to `true`: claiming suppression worked when it cannot be confirmed
 * would suppress the warning and the error augmentation in exactly the case
 * they exist for.
 */
function isStillAllowlisted(): boolean {
  try {
    return InitializeOnPreviewAllowlist.has(GraphQLModule);
  } catch {
    return true;
  }
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

/**
 * All this function actually knows is that (a) suppression could not be
 * confirmed and (b) the boot threw. It does *not* know the two are related:
 * preview still builds the module graph, instantiates
 * `@InjectableOnPreview`-style types and runs module-level user code, any of
 * which can throw entirely on its own. The message therefore states a
 * correlation and hands the user the original error, rather than asserting a
 * cause it never verified — a confidently wrong attribution costs more than
 * a hedged one, because `nest g` exits 0 either way and this text is all the
 * user gets.
 */
function augmentPreviewBootError(err: unknown): Error {
  return wrapPreservingCause(
    `Preview boot failed while GraphQLModule could not be excluded from @nestjs/core's ` +
      `preview allowlist (installed @nestjs/core version: ${resolveNestCoreVersion()}). ` +
      `This failure may be caused by GraphQLModule initializing during preview — a known ` +
      `risk when suppression fails, see the warning above — or may be unrelated, since ` +
      `preview builds the module graph and can throw for its own reasons. Original error`,
    err,
  );
}

export async function createPreviewContext(
  appModule: unknown,
): Promise<INestApplicationContext> {
  suppressGraphQLModulePreviewInit();

  // Not the raw delete() result — see isStillAllowlisted above for why the
  // post-hoc check is the authoritative signal, and why it errs toward
  // "still allowlisted" when it cannot tell.
  const stillAllowlisted = isStillAllowlisted();
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
