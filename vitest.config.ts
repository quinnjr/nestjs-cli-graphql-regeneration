import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

const require = createRequire(import.meta.url);
/** `.../graphql/index.js` — the CommonJS entry, i.e. the `main` field. */
const graphqlCjsEntry = require.resolve('graphql');
const graphqlDir = dirname(graphqlCjsEntry);

/**
 * Vitest's default transform is esbuild, which does not implement
 * `emitDecoratorMetadata` — it is an explicit non-goal upstream. This package's
 * fixtures depend on it: `test/fixtures/basic/recipe.model.ts` declares bare
 * `@Field()` / `@Field({ nullable: true })` properties whose GraphQL types are
 * inferred from the `design:type` metadata TypeScript emits. Under esbuild that
 * metadata is absent and schema construction fails with "Cannot determine a
 * GraphQL output type", taking the byte-parity proof with it.
 *
 * SWC does implement it, so the transform is routed through unplugin-swc. The
 * two `jsc.transform` flags below are the whole reason this plugin is here;
 * changing them silently breaks the fixtures rather than failing loudly.
 */
export default defineConfig({
  // Vitest 4 replaced esbuild with Oxc as the built-in transform. unplugin-swc
  // still sets `esbuild: false`, which is now a no-op — Vitest says so out loud
  // on startup. Without this, Oxc transforms alongside SWC and the decorator
  // metadata SWC just emitted is not guaranteed to survive.
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2021',
      },
      // Deliberately no `module: { type: 'commonjs' }`. The published package is
      // CJS (tsc handles that for `dist/`), but SWC here only feeds Vite, which
      // resolves ES modules. Emitting CJS makes SWC rewrite every `import` into
      // a `require()` that Vite's resolver never sees, and every relative source
      // import fails with "Cannot find module '../src/...'".
    }),
  ],
  resolve: {
    // Without this, every `instanceof`-style check inside graphql fails with
    // "Cannot use GraphQLScalarType 'Boolean' from another module or realm" and
    // all three parity suites — the correctness guarantee of this package — die.
    //
    // Note what it is *not*: only one graphql version is installed, so there is
    // nothing for `resolve.dedupe` to deduplicate (it was tried, and does
    // nothing). The two realms are the same package reached through two entry
    // points. graphql@16 ships no `exports` map, just `"main": "index"` and
    // `"module": "index.mjs"`. Node's `require()` — which is what
    // @nestjs/graphql's CommonJS `dist/` uses internally — therefore lands on
    // `index.js`, while Vite's resolver prefers the `module` field and lands on
    // `index.mjs`. Two copies of every class, in one process.
    //
    // Pinning the bare specifier (and every subpath) to the CommonJS entry
    // collapses them: `index.js` pulls `./type/definition.js` &c. in through
    // `require`, so the classes come out of Node's single CJS registry no matter
    // which side asked for them. That is the invariant Jest gave us for free by
    // running everything through one registry per worker, restored explicitly.
    alias: [
      { find: /^graphql$/, replacement: graphqlCjsEntry },
      { find: /^graphql\/(.*)$/, replacement: `${graphqlDir}/$1` },
    ],
  },
  test: {
    // Deliberately no `server.deps.inline` for @nestjs/*. Those packages are
    // CommonJS with `exports` maps whose `import` and `require` conditions point
    // at the same `dist/index.js`, so leaving them external routes every one of
    // them — and everything they `require` internally — through Node's single CJS
    // registry, which is exactly the Jest-like behaviour the suite needs
    // (test/harvest.spec.ts reaches for `require('@nestjs/graphql')` directly and
    // has to see the same TypeMetadataStorage as the fixtures' `import`s).
    // Inlining them was tried while chasing the graphql realm split above; it is
    // not what fixed it, and it only adds a second evaluation of each barrel.

    // Jest-style globals so the 141 existing assertions keep working unchanged.
    // `vi` still has to be imported or referenced explicitly.
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],

    // Several suites mutate process-global state that must not leak between
    // files: `preview.spec.ts` deletes GraphQLModule from @nestjs/core's
    // InitializeOnPreviewAllowlist, while `parity.spec.ts` performs a real
    // Nest boot that depends on it being present. @nestjs/graphql's
    // TypeMetadataStorage is likewise module-global. File-level isolation is
    // what keeps those from interfering — do not disable it for speed.
    isolate: true,

    // Some suites spawn real `node` child processes and boot a full Nest app.
    testTimeout: 60000,
  },
});
