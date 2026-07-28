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

**This is required, not stylistic — not merely a style preference.** Nest's
preview mode does run a `forRootAsync` factory (it isn't skipped), but any
dependency your factory injects from a module preview mode did not
instantiate arrives as `undefined`. A factory that calls a method on that
dependency (`cfg.get('SCHEMA')`, for example) throws before the schema can be
built. There is no reliable way to recover your `GqlModuleOptions` from the
container in the general case, so the shared config object is the one
channel this tool can depend on. A default export shape
(`export default { schemas: {...} }`) also works.

If the compiled config can't be found, or doesn't export the requested
schema name, the error names every path that was checked and every schema
name that *is* available.

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

## Not supported

- **Apollo Federation / Mercurius federation.** Federated schemas are built
  via `buildSubgraphSchema`, a different path than the one this tool
  exercises. Out of scope.
- **`--watch` via `nest g`.** See above; use a watcher process instead.
