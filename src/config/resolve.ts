import type { GqlModuleOptions } from '@nestjs/graphql';
import { distCandidates, findDistFile } from './dist-layout';
import { wrapPreservingCause } from '../wrap-error';

export const CONFIG_BASENAME = 'graphql.config.js';
export const APP_MODULE_BASENAME = 'app.module.js';

/**
 * The subset of `GqlModuleOptions` that influences the SDL `autoSchemaFile`
 * writes at boot.
 *
 * Deliberately expressed as a `Pick<>` off `@nestjs/graphql`'s own interface
 * rather than as a hand-written shape. A hand-written copy is how this
 * package ended up typing `autoSchemaFile` as `string` when upstream accepts
 * `boolean | string | SchemaFileConfig`, and how `transformAutoSchemaFile`
 * went missing entirely — divergences the compiler could not see because a
 * config loaded through `require()` arrives as `any`.
 *
 * What tying the type to upstream actually buys: a rename, removal, or type
 * change of one of the six fields named below (`autoSchemaFile`,
 * `sortSchema`, `buildSchemaOptions`, `transformSchema`,
 * `transformAutoSchemaFile`, `include`) is a compile error here, because
 * `Pick<>` re-derives each named field's type from `GqlModuleOptions` rather
 * than restating it.
 *
 * What it does NOT buy, despite an earlier version of this comment claiming
 * otherwise: catching the *next option upstream adds*. `Pick<T, K>` only
 * looks up the keys named in `K` — it does not enumerate `T`'s full key set —
 * so a brand-new sibling field on `GqlModuleOptions` compiles cleanly whether
 * or not `SchemaConfig` picks it up. Confirmed with a minimal repro: adding a
 * field to the source interface leaves both this `Pick` and the
 * `Record<keyof SchemaConfig, true>` latch below compiling unchanged. If a
 * future @nestjs/graphql release adds an option that affects the written SDL
 * — the way `transformAutoSchemaFile` once did before this package tracked it
 * — nothing here will flag it; that residual risk is closed only by reading
 * upstream's changelog, not by the type system. (An `Exclude<keyof
 * GqlModuleOptions, keyof SchemaConfig | ...>` assertion pinned to `never`
 * was considered to make the original claim true, but `GqlModuleOptions` has
 * eighteen fields outside this pick — `path`, `typeDefs`, `typePaths`,
 * `driver`, `directiveResolvers`, `schema`, `resolvers`, `definitions`,
 * `useGlobalPrefix`, `fieldResolverEnhancers`, `resolverValidationOptions`,
 * `inheritResolversFromInterfaces`, `transformResolvers`, `context`,
 * `metadata`, `debug`, `introspection`, `stopOnApplicationShutdown` — and
 * excluding all of them by name would be a sprawling, unmaintainable list for
 * a comment's sake, so it was skipped in favor of this honest one.)
 *
 * The same gap exists one nesting level down, and it is not hypothetical:
 * `BuildSchemaOptions` has nine fields, and only three currently have a
 * byte-parity case in `test/parity-config.spec.ts` — `orphanedTypes`,
 * `addNewlineAtEnd`, and `scalarsMap`. That nesting level is exactly where
 * two of this package's real defects lived (`addNewlineAtEnd` read at the
 * wrong level; a `scalarsMap` entry colliding with a discovered `@Scalar()`
 * crashing schema construction — see `dedupeAgainstUserScalars` in
 * `../emitter/build.ts`), so the other six fields (`dateScalarMode`,
 * `numberScalarMode`, `skipCheck`, `directives`, `fieldMiddleware`,
 * `noDuplicatedFields`) are an open gap, not a proven-safe area.
 */
export type SchemaConfig = Pick<
  GqlModuleOptions,
  | 'autoSchemaFile'
  | 'sortSchema'
  | 'buildSchemaOptions'
  | 'transformSchema'
  | 'transformAutoSchemaFile'
  | 'include'
> & {
  /**
   * Legacy top-level alias for `buildSchemaOptions.addNewlineAtEnd`.
   *
   * Upstream declares `addNewlineAtEnd` on `BuildSchemaOptions` only, and
   * `GraphQLSchemaBuilder.generateSchema` reads it off the merged
   * `buildSchemaOptions`. Earlier versions of this package read it at the top
   * level, so it stays supported as a fallback — but the nested form is
   * authoritative and wins whenever both are present.
   */
  addNewlineAtEnd?: boolean;
};

/**
 * Compile-time exhaustiveness latch. `Record<keyof SchemaConfig, true>`
 * rejects both a missing key (a `SchemaConfig` field with no runtime entry)
 * and an extra one (a runtime entry naming a field that no longer exists), so
 * `SCHEMA_CONFIG_FIELDS` cannot drift from the type. `test/parity-config.spec.ts`
 * asserts every entry here has a boot-vs-ours byte-parity case.
 */
const SCHEMA_CONFIG_FIELD_SET: Record<keyof SchemaConfig, true> = {
  autoSchemaFile: true,
  sortSchema: true,
  buildSchemaOptions: true,
  transformSchema: true,
  transformAutoSchemaFile: true,
  include: true,
  addNewlineAtEnd: true,
};

export const SCHEMA_CONFIG_FIELDS = Object.keys(
  SCHEMA_CONFIG_FIELD_SET,
) as (keyof SchemaConfig)[];

/**
 * Where the SDL should be written, resolved exactly as
 * `@nestjs/graphql`'s `getPathForAutoSchemaFile` resolves it:
 * a string is the path; an object contributes its `path`; anything else
 * (including `true`, which tells the boot path to build the schema in memory
 * without writing it) names no file at all.
 *
 * Upstream treats "names no file" as "skip the write". This package exists
 * *to* write the file, so the same condition is an error — a clear one,
 * rather than the `/true` and `/[object Object]` junk paths that a naive
 * string coercion produced.
 */
export function resolveOutFile(
  autoSchemaFile: SchemaConfig['autoSchemaFile'],
  schemaName: string,
): string {
  let resolved: string | null = null;

  if (typeof autoSchemaFile === 'string') {
    resolved = autoSchemaFile;
  } else if (autoSchemaFile !== null && typeof autoSchemaFile === 'object') {
    const { path: configuredPath } = autoSchemaFile;
    if (typeof configuredPath === 'string') resolved = configuredPath;
  }

  if (!resolved) {
    throw new Error(
      `Schema "${schemaName}" does not say where to write its SDL: "autoSchemaFile" is ` +
        `${JSON.stringify(autoSchemaFile) ?? String(autoSchemaFile)}, which names no file. ` +
        `@nestjs/graphql accepts boolean | string | { path }, but only a string or an ` +
        `object with a non-empty "path" identifies an output file — "true" means "build ` +
        `the schema in memory and write nothing", which leaves this schematic with ` +
        `nothing to do. Set autoSchemaFile to a path, e.g. ` +
        `autoSchemaFile: 'src/schema.gql'.`,
    );
  }

  return resolved;
}

export function resolveConfig(distRoot: string, schemaName: string): SchemaConfig {
  const found = findDistFile(distRoot, CONFIG_BASENAME);
  if (!found) {
    throw new Error(
      `Could not find a compiled ${CONFIG_BASENAME}. Looked in:\n` +
        distCandidates(distRoot, CONFIG_BASENAME)
          .map((c) => `  - ${c}`)
          .join('\n') +
        `\nRun "nest build" first, and export a "schemas" object from graphql.config.ts.`,
    );
  }

  let mod: any;
  try {
    mod = require(found);
  } catch (err) {
    // A throwing config is one of the most common failures here, and the
    // interesting frame is always in the user's file, never in ours.
    // `wrapPreservingCause` keeps `cause` *and* merges the original stack —
    // the latter being the part that survives `EmitFailure`'s JSON boundary
    // (see ../emitter/protocol.ts, which carries no `cause` field), so
    // without it the user is handed a stack pointing straight at this
    // function.
    throw wrapPreservingCause(`Failed to load GraphQL schema config at ${found}`, err);
  }

  const schemas = mod.schemas ?? mod.default?.schemas;
  if (!schemas) {
    throw new Error(`${found} does not export a "schemas" object.`);
  }

  const config = schemas[schemaName];
  if (!config) {
    throw new Error(
      `No schema named "${schemaName}" in ${found}. Available: ${Object.keys(schemas).join(', ')}`,
    );
  }

  return config;
}
