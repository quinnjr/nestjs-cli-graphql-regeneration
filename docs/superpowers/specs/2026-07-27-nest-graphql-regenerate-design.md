# `nest g regenerate` — offline GraphQL schema regeneration

**Date:** 2026-07-27
**Status:** Approved design, pending implementation plan

> `@scope/nest-graphql` throughout this document is a placeholder. The published package name is an open decision and does not affect any design choice below.

## Problem

`@nestjs/graphql` code-first writes `schema.gql` during application bootstrap via `autoSchemaFile`. Producing the SDL therefore requires a full `NestFactory.create(AppModule)` — which opens database connections, validates environment configuration, and runs every `onModuleInit` hook.

This breaks three workflows:

1. **CI drift detection.** `schema.gql` is committed, so it goes stale. Catching that requires booting the app, which requires production-shaped infrastructure in CI.
2. **Client codegen.** `graphql-codegen` needs SDL before the server can run.
3. **Pre-flight validation.** Schema-breaking changes surface at boot rather than at review time.

The documented workaround (`GraphQLSchemaBuilderModule` + `GraphQLSchemaFactory.create([...])`, see [docs.nestjs.com/graphql/schema-generator](https://docs.nestjs.com/graphql/schema-generator)) requires hand-enumerating every resolver class and carries an explicit caveat that it "may not generate the schema in the exact same way" as the boot path. Both problems are fatal for drift detection: a hand-maintained resolver list drifts, and non-identical output produces permanent false positives.

Demand is established upstream and unmet: [nestjs/graphql#1587](https://github.com/nestjs/graphql/issues/1587) requests exactly this, with [#291](https://github.com/nestjs/graphql/issues/291) and [#1324](https://github.com/nestjs/graphql/issues/1324) as duplicates. No shipped solution exists.

## Goals

- Regenerate `schema.gql` without instantiating providers or connecting to infrastructure.
- Produce **byte-identical** output to the boot path, so drift detection has no false positives.
- Discover resolvers automatically — never hand-enumerated.
- Support Nest monorepo projects and multiple schemas per application.
- Fail CI with a non-zero exit code when the committed schema is stale.

## Non-goals (v1)

- **Apollo Federation subgraphs.** Federated schemas use `GraphQLFederationFactory` / `buildSubgraphSchema` and `@key` directive handling — a separate emit path. Deferred.
- **Watch mode.** Structurally impossible under `nest g` (see "Flag budget"). Documented as a `chokidar` recipe instead.
- **Schema-first → TypeScript typings.** That is `GraphQLDefinitionsFactory`'s job and a different direction of travel.

## Decisions

### D1 — Delivery: schematics collection extending `@nestjs/schematics`

`@nestjs/cli` has **no plugin API**. `commands/command.loader.ts` hardcodes six commands (`new`, `build`, `start`, `info`, `add`, `generate`); there is no dynamic registration path. Literal `nest graphql regenerate` is therefore unavailable without forking the `nest` binary.

The chosen vehicle is an external schematics collection, invoked through the one extension point the CLI does expose:

```
nest g -c @scope/nest-graphql regenerate
```

`CollectionFactory.create()` routes any non-`@nestjs/schematics` collection to `CustomCollection`, which resolves it via `new NodeWorkflow(process.cwd(), {})` — so the package must be installed in the target project's `node_modules`.

**Collection `extends`.** `CustomCollection.getSchematics()` reads `collection.baseDescriptions`, which is the schematics `extends` chain. Declaring:

```json
{ "extends": ["@nestjs/schematics"], "schematics": { "regenerate": { ... } } }
```

means a user *may* optionally repoint their default collection in `nest-cli.json`:

```json
{ "collection": "@scope/nest-graphql" }
```

and then get `nest g regenerate` with no `-c`, while `nest g resource`, `nest g service`, etc. continue to work through the inherited chain.

> **Documentation stance:** the README leads with the explicit `-c @scope/nest-graphql` form. The `nest-cli.json` override is presented as an optional convenience, not the happy path.

### D2 — Discovery: preview-mode boot

`NestApplicationContextOptions.preview` is documented in `@nestjs/common` as: *"In the preview mode, providers/controllers are not instantiated & resolved."*

The emitter creates a preview context of the user's `AppModule` and harvests resolver and scalar **metatypes** from the DI container without constructing a single provider. This mirrors how `ResolversExplorerService` works at runtime (it walks `ModulesContainer`, filtered by `gqlOptions.include`), so discovery fidelity matches boot: dynamic modules, conditional imports, and `include` filtering are all respected for free.

`@nestjs/graphql` explicitly anticipates this mode — `schema-builder/schema-builder.module.ts` ends with `InitializeOnPreviewAllowlist.add(GraphQLSchemaBuilderModule)`, allowlisting the schema builder's own providers to initialize under preview.

Rejected alternative: **ts-morph static analysis.** Higher surface area (barrel files, path aliases, re-exports), and blind to conditional registration. Retained only as a documented escape hatch if preview boot proves insufficient in practice.

### D3 — Scope

In: single-app code-first, Nest monorepo `projects`, multiple schemas per app. Out: federation (see Non-goals).

## Flag budget

`generate.command.ts` declares a **closed commander option allowlist**, and `bin/nest.ts` never calls `allowUnknownOption()`. Positional arguments are capped by `exitIfExtraArgs(command, 3)`. Any novel flag — `--check`, `--out`, `--watch` — hard-errors as an unknown option before reaching the action handler.

The feature set must therefore ride on existing flags:

| Capability | Rides on | Status |
|---|---|---|
| Named schema selection | `[name]` positional | Supported |
| Monorepo project selection | `--project <name>` | Supported |
| CI drift check | `--dry-run` | Supported |
| Watch mode | — | Not available |

Resulting surface:

```
nest g -c @scope/nest-graphql regenerate                 # write default schema
nest g -c @scope/nest-graphql regenerate admin           # write named schema
nest g -c @scope/nest-graphql regenerate --project api   # monorepo project
nest g -c @scope/nest-graphql regenerate --dry-run       # CI check; exit 1 on drift
```

`--dry-run` is a natural fit rather than a workaround: the schematic writes through the schematics `Tree`, so dry-run reports `UPDATE src/schema.gql` without committing. The schematic additionally throws `SchematicsException` on drift to force a non-zero exit.

Recommended `package.json` aliases:

```json
{
  "scripts": {
    "gql:gen": "nest g -c @scope/nest-graphql regenerate",
    "gql:check": "nest g -c @scope/nest-graphql regenerate --dry-run"
  }
}
```

## Architecture

Three units with narrow interfaces.

### U1 — `regenerate` schematic (`src/regenerate/`)

Orchestrator. Knows nothing about GraphQL.

- **Does:** reads `nest-cli.json`, resolves the target project and its `sourceRoot`, invokes `nest build` for that project, spawns U2, writes the returned SDL through the `Tree`, compares against existing content and throws on drift under `--dry-run`.
- **Depends on:** `@angular-devkit/schematics`, U2, U3.
- **Interface:** a standard schematics `Rule`.

### U2 — Emitter subprocess (`src/emitter/`)

A forked Node process that performs the boot and returns SDL as JSON on stdout.

- **Does:** preview-boots `AppModule`, harvests metatypes, builds the schema, prints SDL.
- **Interface:** `{ projectRoot, distEntry, schemaName, options } → { sdl: string } | { error: SerializedError }`.

**Why a subprocess, not in-process:**

1. **Version isolation.** It resolves `@nestjs/core` and `@nestjs/graphql` from *the project's* `node_modules` via `require.resolve(id, { paths: [projectRoot] })`. A globally installed `nest` CLI carrying different Nest versions would otherwise produce wrong schemas or hard crashes.
2. **Blast containment.** Module-level side effects and stray `process.exit()` calls in user code cannot take down the CLI process.
3. **Clean environment.** `.env` loading and env stubbing apply to the child only.

**Algorithm:**

```ts
// 1. Preview graph — no provider construction, no DB, no onModuleInit
const ctx = await NestFactory.createApplicationContext(AppModule, {
  preview: true, abortOnError: false, logger: false,
});

// 2. Harvest metatypes
const resolvers = [], scalars = [];
for (const mod of ctx.get(ModulesContainer).values())
  for (const w of mod.providers.values()) {
    const t = w.metatype; if (!t) continue;
    if (Reflect.getMetadata(RESOLVER_TYPE_METADATA, t)) resolvers.push(t);
    if (Reflect.getMetadata(SCALAR_NAME_METADATA, t)) scalars.push(t);
  }

// 3. Build via the same factory the boot path uses
const schemaCtx = await NestFactory.createApplicationContext(
  GraphQLSchemaBuilderModule, { logger: false },
);
const schema = await schemaCtx.get(GraphQLSchemaFactory).create(
  resolvers, scalars, buildSchemaOptions,
);
```

Step 3 uses `createApplicationContext` rather than the `NestFactory.create` shown in the Nest docs: the schema builder needs no HTTP layer, and `create` would drag in a platform adapter the emitter has no use for.

Metadata keys are exported from `@nestjs/graphql`'s `graphql.constants`: `RESOLVER_TYPE_METADATA = 'graphql:resolver_type'`, `SCALAR_NAME_METADATA = 'graphql:scalar_name'`.

`GraphQLSchemaFactory.create()` internally calls `LazyMetadataStorage.load(resolvers)` and `TypeMetadataStorage.compile(options.orphanedTypes)`, so decorator metadata registered as an import side effect is picked up without further work.

**SDL serialization.** `GraphQLSchemaBuilder.generateSchema()` performs exactly the transformation we need — header, `lexicographicSortSchema`, `transformSchema`, trailing newline — but `GraphQLSchemaBuilderModule` exports only `GraphQLSchemaFactory` and `FileSystemHelper`; `GraphQLSchemaBuilder` is not among its providers and cannot be retrieved with `app.get()`. U2 therefore reimplements that ~15-line sequence:

```ts
let out = GRAPHQL_SDL_FILE_HEADER + printSchema(
  sortSchema ? lexicographicSortSchema(transformed) : transformed,
);
if (addNewlineAtEnd) out += GRAPHQL_SDL_FILE_END;
```

Both constants are exported from `graphql.constants`. **Byte-parity is a test obligation, not an assumption** — see Testing.

The file write is deliberately *not* delegated to `FileSystemHelper`; U1 writes through the `Tree` so `--dry-run` works natively.

### U3 — Config resolver (`src/config/`)

- **Does:** loads `graphql.config.ts` from the resolved project root, returns the named-schema map.
- **Interface:** `(projectRoot, schemaName) → GqlSchemaConfig`.

## Config contract

A single exported object, imported by both the CLI and the runtime module:

```ts
// graphql.config.ts
export const schemas = {
  default: { autoSchemaFile: 'src/schema.gql', sortSchema: true },
  admin:   { autoSchemaFile: 'src/admin.gql', include: [AdminModule] },
};
```

```ts
GraphQLModule.forRoot({ driver: ApolloDriver, ...schemas.default })
```

This is load-bearing, not stylistic. **`forRootAsync` factories do not execute under preview mode**, so the tool cannot recover effective `GqlModuleOptions` from the module graph. The shared object is the only reliable channel for `autoSchemaFile`, `sortSchema`, `include`, and `buildSchemaOptions`.

The `[name]` positional selects the key: `nest g -c @scope/nest-graphql regenerate admin` resolves `schemas.admin`. Absent a name, `schemas.default` is used.

## Monorepo resolution

1. Read `projects` from `nest-cli.json`.
2. `--project <name>` selects the entry; absent, use the default project's `sourceRoot`.
3. Resolve `graphql.config.ts` and the `dist/` entry point relative to that project's root.
4. Emit each schema named in that project's config.

## Drift check semantics

Under `--dry-run`:

1. Generate SDL in memory.
2. Read the existing file from the `Tree`.
3. Byte-compare.
4. Identical → log "up to date", exit 0.
5. Different, or file absent → print a unified diff and throw `SchematicsException`, forcing a non-zero exit.

## Failure modes

1. **Module-level side effects.** Preview mode skips provider construction but *not* module evaluation. A top-level `new Redis()` or a `ConfigModule` with `validationSchema` still throws on import. Mitigation: the emitter loads `.env` when present and surfaces the underlying error with a pointer to this limitation. Env stubbing is a follow-up if it proves common.
2. **CLI plugin parity.** `@nestjs/graphql/plugin` is a TypeScript *transformer* configured in `nest-cli.json`; it is what allows bare `@Field()` without an explicit type. Generic TS loaders (`ts-node`, `tsx`, `jiti`) do not apply it, and loading `src/` through one silently produces a schema that differs from the boot schema. **Mitigation: always build via `nest build` and load `dist/`.** This is why U1 shells out to the build rather than loading TypeScript directly.
3. **Stale `dist/`.** Addressed by (2) — the build always runs. A config-level opt-out for speed is a follow-up.
4. **Schema option injection.** `generate.command.ts` unconditionally pushes `spec`, `flat`, `specFileSuffix`, `skipImport`, `type`, `crud`, and `collection` into the schematic invocation, and `generate.action.ts` appends `language`. The schematic's `schema.json` must accept all of them; `"additionalProperties": false` will cause a validation failure.
5. **Version skew.** Addressed by U2's project-root module resolution.

## Testing

| Level | Coverage |
|---|---|
| Byte-parity (critical) | Fixture app booted normally with `autoSchemaFile`, versus U2's output. Must match byte-for-byte. Guards every drift-check claim. |
| Discovery | Fixture with resolvers behind a dynamic module, a conditional import, and an `include` filter. Assert the harvested set matches `ResolversExplorerService`. |
| Side-effect isolation | Fixture whose provider constructor throws and whose `onModuleInit` connects to a nonexistent host. Must still emit. |
| Drift check | Assert exit 0 when in sync, exit 1 plus diff when stale or absent. |
| Monorepo / multi-schema | Two-project `nest-cli.json`, two named schemas; assert correct file targets. |

The byte-parity suite is the project's spine. Everything else is downstream of it.

## Package layout

```
src/
  collection.json          # extends @nestjs/schematics
  regenerate/
    index.ts               # U1 — Rule
    schema.json            # tolerant of injected options
  emitter/
    child.ts               # U2 — forked entry
    harvest.ts             # container walk
    serialize.ts           # SDL writer (byte-parity surface)
  config/
    resolve.ts             # U3
```

## Estimate

| Phase | Effort |
|---|---|
| Collection skeleton, `extends` chain, `schema.json` | 0.5 d |
| Emitter subprocess (preview boot, harvest, serialize) | 1.0 d |
| Tree write, dry-run drift, exit codes | 0.5 d |
| Monorepo `--project`, multi-schema `[name]` | 0.5 d |
| Config resolver, README, recipes | 0.5 d |
| **Total** | **~3 days** |

## Follow-ups

1. Apollo Federation subgraph emission (`buildSubgraphSchema` path).
2. Watch mode as a `chokidar` wrapper script, documented in the README.
3. Env stubbing for fixtures whose module-level evaluation requires configuration.
4. ts-morph static-analysis fallback, if preview boot proves insufficient.
5. Upstream contribution: generic external-command resolution in `@nestjs/cli` (`nest <cmd>` → `nest-<cmd>`), which would unlock first-class `nest graphql regenerate` and benefit the whole ecosystem.
