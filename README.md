# @scope/nest-graphql

Regenerate a NestJS code-first GraphQL schema without booting your app — no
database, no Redis, no secrets.

`@scope/nest-graphql` is a [`nest g`](https://docs.nestjs.com/cli/overview)
schematic collection. It boots your application in Nest's **preview mode**
(the same mode `nest info`-style tooling uses to walk the module graph
without instantiating providers), harvests your resolvers and scalars, builds
the schema the same way `GraphQLModule` does internally, and writes the
result to disk — all in a child process, driven by the CLI you already use.

## Install

```bash
pnpm add -D @scope/nest-graphql
```

## Requirements

Install these in the **project you're generating a schema for**, not just
alongside this package:

- **`@nestjs/cli` as a local dependency** — e.g. `pnpm add -D @nestjs/cli`.
  Many Nest projects only have a *globally* installed `nest` command; that's
  not enough. `regenerate` runs `nest build` by resolving your project's own
  installed CLI (`require.resolve('@nestjs/cli/bin/nest.js', { paths:
  [projectRoot] })` — see `src/regenerate/build-project.ts`), not by
  shelling out to whatever `nest`/`npx` happens to be on your `PATH`. If it
  can't find a local install, you'll see exactly this before anything else
  runs:

  ```
  Could not find "@nestjs/cli" from "<projectRoot>". This package only
  peer-depends on @nestjs/schematics; the Nest CLI itself must be installed
  in your project (e.g. "npm install --save-dev @nestjs/cli") to run "nest
  build".
  ```

- `@nestjs/common`, `@nestjs/core` (`>=10`), `@nestjs/graphql` (`>=12.2.0`),
  and `@nestjs/schematics` (`>=10`) — declared as peer dependencies. Whatever
  your application already depends on satisfies these; nothing extra to add
  for a typical Nest + GraphQL project.

  The `@nestjs/graphql` floor is `12.2.0`, not just `12`: `GRAPHQL_SDL_FILE_END`
  and the `addNewlineAtEnd` plumbing in `GraphQLSchemaBuilder.generateSchema`
  were introduced together in `12.2.0`. On an older `12.0.x`/`12.1.x` install,
  `src/emitter/serialize.ts`'s deep import of that constant resolves to
  `undefined`, and a load-time guard there throws rather than silently
  appending the literal string `"undefined"` to your schema file.

## Use

```bash
nest g -c @scope/nest-graphql regenerate
```

Optionally set the collection as your default in `nest-cli.json` to drop the
`-c` flag. The collection `extends` `@nestjs/schematics`, so `nest g service`,
`nest g resource`, and friends keep working unmodified:

```json
{ "collection": "@scope/nest-graphql" }
```

```bash
nest g regenerate
```

The schematic is also registered under the alias `gql-regen` — swap it in
for `regenerate` in either invocation above (`nest g -c @scope/nest-graphql
gql-regen`, or `nest g gql-regen` once the collection is your default) for
anyone who'd rather not type the whole word.

## Configure

`resolveConfig()` requires a compiled `graphql.config.js` at the root of your
build output (or under a nested `src/`, e.g. `dist/src/graphql.config.js`).
It reads a named entry from a `schemas` export:

```ts
// src/graphql.config.ts
export const schemas = {
  default: { autoSchemaFile: 'src/schema.gql', sortSchema: true },
  admin: { autoSchemaFile: 'src/admin.gql', include: [AdminModule] },
};
```

Import the same object into your bootstrap so the CLI and your runtime read
identical options:

```ts
import { schemas } from './graphql.config';

GraphQLModule.forRoot({ driver: ApolloDriver, ...schemas.default });
```

**This is required, not merely a style preference.** We deliberately prevent
`GraphQLModule` from initializing during the preview boot this tool uses
(`src/emitter/preview.ts`), because letting it run would both crash on
common `forRootAsync` configurations and write your schema file to disk as
a side effect of just walking the module graph — a factory that injects a
dependency from a module preview mode never instantiated, then calls a
method on it, throws on `undefined`. Since `GraphQLModule` never
initializes during preview, its options are never constructed, so there is
nothing in the container to read them from. The exported config object is
the only reliable channel.

If suppression itself ever fails — for example, against a future
`@nestjs/core` release that changes the private internals it relies on —
this tool warns on stderr and falls back to the older behavior (the
crash-on-undefined-dependency failure mode described above becomes possible
again) rather than failing silently; see `test/preview.spec.ts`. A default
export shape (`export default { schemas: {...} }`) also works.

If the compiled config can't be found, or doesn't export the requested
schema name, the error names every path that was checked and every schema
name that *is* available.

### Which options a schema entry may set

A schema entry is a subset of `@nestjs/graphql`'s own `GqlModuleOptions` —
the type is literally derived from it (`Pick<GqlModuleOptions, ...>` in
`src/config/resolve.ts`), so these behave exactly as they do at boot:

| Option | Notes |
|---|---|
| `autoSchemaFile` | Where to write. `string` or `{ path }`; **must resolve inside the project**, since a schematic can only write within the project it runs against. An absolute path (`join(process.cwd(), 'src/schema.gql')`, as the Nest docs use) is fine and is mapped back to a project-relative path. `true` is rejected: it tells the boot path to build the schema in memory and write nothing, which leaves this schematic with nothing to do. |
| `sortSchema` | Lexicographic sort. |
| `include` | Modules to scan. **Transitive**: naming a module also picks up everything it `imports`, exactly as at boot. |
| `buildSchemaOptions` | Passed to the schema factory (`orphanedTypes`, `scalarsMap`, `dateScalarMode`, `addNewlineAtEnd`, ...). |
| `transformSchema` | Only applied to the written file when `transformAutoSchemaFile` is also set — matching `GraphQLSchemaBuilder`, which gates on `transformAutoSchemaFile && transformSchema`. An app that transforms its *served* schema writes an untransformed `.gql` at boot, and so do we. |
| `transformAutoSchemaFile` | Opts `transformSchema` into the written file. Defaults falsy. |

`addNewlineAtEnd` belongs under `buildSchemaOptions` (that is where upstream
declares it, on `BuildSchemaOptions`). A top-level `addNewlineAtEnd` is still
honoured as a legacy alias, but the nested form wins when both are present.

Every option in that table has a byte-parity test that boots a real app with
it set and compares against our output — see `test/parity-config.spec.ts`,
which also fails if an option is added without such a test.

## Options

The schematic accepts every property `nest g` injects into a generator
(`project`, `sourceRoot`, `path`, `collection`, `skipImport`, `type`, `crud`,
`language`, `spec`, `flat`, `specFileSuffix`) so it won't reject an
unfamiliar flag from the CLI — only `name` and `project` actually change its
behavior:

| Command | Effect |
|---|---|
| `nest g regenerate` | Regenerate the `default` schema |
| `nest g regenerate admin` | Regenerate the schema named `admin` in your `schemas` export |
| `nest g regenerate --project api` | Resolve `api`'s `sourceRoot`/`distRoot` from `nest-cli.json` and build/regenerate that project |
| `nest g regenerate --dry-run` | Preview: still runs `nest build` and the emitter, but discards the resulting file write instead of committing it |

`--dry-run` is a flag `nest generate` itself understands (`-d, --dry-run` in
`nest generate --help`), not something declared in this schematic's own
options. It works by discarding the schematic's in-memory `Tree` changes
instead of committing them to disk — it does **not** skip the `nest build`
step or the emitter child process, both of which run unconditionally before
the write would happen. So `--dry-run` previews *whether the schema file
would change*; it isn't a fast no-op.

Under the hood, `regenerate`:

1. Reads `/nest-cli.json` from the schematic `Tree` and resolves the target
   project's `sourceRoot`/`distRoot` (single-app or monorepo, via
   `resolveProject`).
2. Runs `nest build` (optionally scoped to `--project`) so the emitter has
   fresh compiled output to load.
3. Spawns the emitter in a child process against that build output.
4. Compares the emitter's SDL to what's already on disk. If they're
   byte-identical, it logs `<file> is up to date.` and leaves the file
   untouched. Otherwise it creates or overwrites the file and logs which.

`--project` targets a Nest monorepo project declared in `nest-cli.json`'s
`projects` map; omit it for a standard single-app layout.

## Which GraphQL drivers this works with

Works with any `@nestjs/graphql` driver. Byte-parity against a real
application boot is verified in CI against **two drivers**: **Apollo** (on
Express) and **Mercurius** (on Fastify) — including a test that builds the
same resolver through both drivers and asserts the emitted SDL is
byte-identical.

The HTTP platform (Express vs. Fastify) is irrelevant to schema generation,
and this isn't an assumption: the emitter boots your app via Nest's
`createApplicationContext`, which never instantiates an HTTP adapter, and
`GraphQLModule.onModuleInit` bails out early (`if (!httpAdapter) return;`)
before it ever starts a driver's HTTP integration. The only thing that can
affect the emitted SDL is the driver's `generateSchema` implementation
itself, which is exactly what the two-driver parity test exists to catch.

Federation is **out of scope**. Federated subgraphs are built through
`buildSubgraphSchema`, a different code path this tool does not exercise —
don't point this at a `MercuriusFederationDriver`/`ApolloFederationDriver`
setup and expect a subgraph-correct result.

## Isolation from your project's Nest version

The emitter runs in a child process with `NODE_PATH` pointed at your
project's `node_modules`. Be precise about what this does and doesn't
guarantee: Node consults `NODE_PATH` only as a fallback, *after* the
ordinary `node_modules` ancestor walk starting from the location of the file
doing the `require`. If that ordinary walk already finds an `@nestjs/core`
before `NODE_PATH` is ever consulted — for example, a copy hoisted into an
ancestor directory, or this tool installed globally with its own nested
copy — that copy wins, silently.

This is a **correctness net, not an isolation guarantee**. In the common
case — this tool installed locally as a dev dependency, `@nestjs/core` a
peer dependency your project supplies — the ordinary walk finds nothing on
its own and `NODE_PATH` does the real work. But it cannot be relied on to
override a version the ordinary resolution would have found first.

To make a silent version mismatch visible rather than letting it produce a
schema built against the wrong `@nestjs/core`, the child process compares
the ambient resolution of `@nestjs/core` (what it will actually use) against
a resolution scoped explicitly to your project root, and writes a warning to
stderr if they disagree. If you see that warning, install this tool locally
in the target project rather than globally.

## Known limitations

**Resolvers registered via `useFactory` are not detected.** A provider
registered as `{ provide: SOME_TOKEN, useFactory: () => new SomeResolver() }`
is invisible to this tool. `harvest()` (`src/emitter/harvest.ts`) reads
`wrapper.metatype` to find candidate classes; for a `useFactory` provider,
`metatype` is the factory function itself, not the class it happens to
construct and return — so a class carrying `@Resolver()`/`@Query()` is
silently dropped from the emitted SDL whenever it's only ever reached through
a factory.

A real boot doesn't hit this: `ResolversExplorerService.getAllCtors()` reads
`instance.constructor`, which only exists once the provider has actually been
*instantiated* by Nest's DI container. That's not a gap this tool can close
the same way — reading `instance.constructor` requires instantiating exactly
the providers preview mode exists to avoid instantiating (see "Isolation from
your project's Nest version" above, and `test/fixtures/exploding` for why
that avoidance matters). There is no metadata-only equivalent to inspect.

**Workaround:** register the resolver class directly as a provider
(`providers: [SomeResolver]`), or via `useClass`
(`{ provide: SOME_TOKEN, useClass: SomeResolver }`) — both keep the class
itself as `wrapper.metatype`, which this tool does inspect.

## CI

**`nest g` always exits `0`, even when the schematic throws.** This is a
`@nestjs/cli` limitation, not a design choice here: `AbstractRunner.run()`
calls a bare `reject()` internally, and `generate.action.ts` swallows it
rather than propagating a non-zero exit code. A CI step that only checks the
command's exit status will report success even when regeneration failed.
Assert freshness with `git diff` instead, which doesn't depend on `nest g`'s
exit code at all:

```json
{
  "scripts": {
    "gql:gen": "nest g -c @scope/nest-graphql regenerate",
    "gql:check": "pnpm gql:gen && git diff --exit-code -- '*.gql'"
  }
}
```

`gql:check` fails if regeneration changed a tracked `.gql` file — i.e., if
the checked-in schema was stale relative to the resolvers in the commit
being checked.

## Watch mode

**Not supported through `nest g`.** The Nest CLI's `generate` command
declares a closed Commander option allowlist and rejects any flag it doesn't
recognize, including `--watch`. Use a file watcher to re-run the schematic
instead:

```json
{
  "scripts": {
    "gql:watch": "chokidar 'src/**/*.ts' -c 'pnpm gql:gen'"
  }
}
```

(Requires `chokidar-cli` as a dev dependency.)
