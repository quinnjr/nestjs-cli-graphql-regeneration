# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-07-28

First release.

### Added

- `regenerate` schematic (alias `gql-regen`) for the `nest g` CLI: rebuilds a
  code-first GraphQL schema by booting the application in Nest's **preview
  mode** in a child process — no database, Redis, or secrets required, because
  providers are never instantiated.
- Collection `extends` `@nestjs/schematics`, so `nest g service`, `nest g
  resource`, and the rest keep working when this collection is set as the
  default in `nest-cli.json`.
- Configuration through a compiled `graphql.config.js` in the build output,
  read as a named entry off a `schemas` export, with the schema-option contract
  derived from `@nestjs/graphql`'s own `GqlModuleOptions`.
- Byte-parity with what `GraphQLModule` writes at runtime, proven in tests
  against both the Apollo (Express) and Mercurius (Fastify) drivers.
- Resolver and scalar harvesting that covers `@Resolver()` classes,
  `@Scalar()` providers, and `useFactory`-registered resolvers.
- Nest CLI resolution from the target project itself
  (`require.resolve('@nestjs/cli/bin/nest.js', { paths: [projectRoot] })`)
  rather than shelling out to whatever `nest`/`npx` is on `PATH`, with an
  explicit up-front error when no local install is found.
- Load-time guard on the `@nestjs/graphql` deep import of
  `GRAPHQL_SDL_FILE_END`, so a `12.0.x`/`12.1.x` install fails loudly instead
  of appending the literal string `"undefined"` to the emitted schema.
