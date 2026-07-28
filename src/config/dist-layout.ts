import { existsSync } from 'fs';
import * as path from 'path';

/**
 * `nest build` does not produce one canonical output shape. With
 * `"sourceRoot": "src"` and no `rootDir` narrowing, TypeScript preserves the
 * common source directory, so a project whose sources live only under `src/`
 * emits `dist/main.js`; add a single `.ts` outside `src/` (a root-level
 * `graphql.config.ts`, a `test/` file included in the program, ...) and the
 * common root becomes the project root, so the very same sources emit
 * `dist/src/main.js` instead.
 *
 * Both layouts are real and this package documents support for both
 * (README, "Configure"). Every file the emitter loads out of the build output
 * has to answer that question the same way, or half the tool resolves one
 * layout and half resolves the other — which is exactly the bug this module
 * exists to make impossible: `resolveConfig` probed both candidates while the
 * app module path was hardcoded to the flat one, so the nested layout could
 * never work end to end.
 *
 * Single source of truth: every dist lookup goes through here.
 */
export const DIST_LAYOUT_SUBDIRS = ['', 'src'] as const;

/** Every path a `basename` could legitimately occupy inside a build output. */
export function distCandidates(distRoot: string, basename: string): string[] {
  return DIST_LAYOUT_SUBDIRS.map((sub) => path.join(distRoot, sub, basename));
}

/** The first candidate that exists on disk, or `undefined` if none do. */
export function findDistFile(distRoot: string, basename: string): string | undefined {
  return distCandidates(distRoot, basename).find((c) => existsSync(c));
}

/**
 * The first candidate that exists on disk, falling back to the flat (first)
 * candidate when none do.
 *
 * The fallback matters for callers whose failure mode is better reported by
 * whatever consumes the path (e.g. `require()`'s "Cannot find module
 * <path>"), rather than by a probe that has no idea what the caller wanted
 * the file for. Callers that can produce a better message — like
 * `resolveConfig` — should use `distCandidates`/`findDistFile` and report
 * every attempted path themselves.
 */
export function resolveDistFile(distRoot: string, basename: string): string {
  return findDistFile(distRoot, basename) ?? distCandidates(distRoot, basename)[0];
}
