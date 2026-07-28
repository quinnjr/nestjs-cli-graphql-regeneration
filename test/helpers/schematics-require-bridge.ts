import * as path from 'path';

/**
 * Lets `@angular-devkit/schematics` load a TypeScript schematic factory under Vitest.
 *
 * The engine resolves a collection's `"factory"` string with Node's own `require()`
 * (`tools/export-ref.js` does `require.resolve(...)` then `require(...)[name]`), and
 * `src/collection.json` points at `./regenerate/index`. Under ts-jest that worked for
 * two reasons that Vitest does not reproduce:
 *
 *  1. `moduleFileExtensions: ['ts', 'js', 'json']` made Jest's `require` resolve the
 *     extensionless path to `src/regenerate/index.ts`. Node's real `require` only knows
 *     `.js`, `.json` and `.node`, so it fails with MODULE_NOT_FOUND.
 *  2. Jest kept one module registry, so the factory it loaded shared instances with the
 *     spec — and therefore saw the spec's `jest.mock()`ed `spawnEmitter`/`buildProject`.
 *     Vitest's mocks live in its own module runner; anything Node `require()`s is a
 *     second, unmocked copy, so even a `.ts`-capable loader would silently defeat every
 *     `vi.mock` in the file.
 *
 * Both halves are restored here. Registering a `.ts` handler puts the extension into
 * `Module._extensions`, which is the list `Module._findPath` walks — that alone fixes
 * resolution. The handler then serves the module object Vitest already evaluated, so the
 * factory the engine executes is the very one the spec mocked and spied on.
 *
 * `.ts` is appended after `.js`, so an extensionless path that has a real `.js` next to
 * it (notably `dist/regenerate/index.js`, which the production-build smoke test loads
 * through the same engine) still resolves to the compiled output, untouched.
 */

type ModuleNamespace = Record<string, unknown>;

const REGISTRY_KEY = '__nestGraphqlSchematicsRequireBridge__';

type BridgeHost = typeof globalThis & { [REGISTRY_KEY]?: Map<string, ModuleNamespace> };

/**
 * Held on `globalThis` rather than in module scope on purpose. `isolate: true` gives every
 * spec file a fresh module registry, so a module-scoped Map would be a different Map from
 * the one closed over by the `.ts` handler a previously-run spec file installed into the
 * (process-wide) `Module._extensions`. Looking the registry up through `globalThis` on
 * every call keeps the handler and the publisher pointed at the same table.
 */
function registry(): Map<string, ModuleNamespace> {
  const host = globalThis as BridgeHost;
  return (host[REGISTRY_KEY] ??= new Map<string, ModuleNamespace>());
}

if (!require.extensions['.ts']) {
  require.extensions['.ts'] = (module, filename) => {
    const published = registry().get(filename);
    if (!published) {
      throw new Error(
        `No Vitest module has been published for "${filename}". A TypeScript schematic ` +
          `factory has to be imported by the spec (so vi.mock applies to it) and passed to ` +
          `publishForSchematicsRequire() before @angular-devkit/schematics resolves it.`,
      );
    }
    module.exports = published;
  };
}

/**
 * Publish an already-imported module under the absolute path of its `.ts` source, so the
 * schematics engine's `require()` of that path hands back this exact object.
 */
export function publishForSchematicsRequire(
  tsSourcePath: string,
  moduleNamespace: ModuleNamespace,
): void {
  registry().set(path.resolve(tsSourcePath), moduleNamespace);
}
