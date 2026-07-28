import { SchematicsException } from '@angular-devkit/schematics';
import * as path from 'path';

export interface ResolvedProject {
  distRoot: string;
}

/**
 * The one containment check every project-relative path in this tool goes through.
 *
 * The write side (`toTreePath` in ../regenerate) always refused to escape the project
 * root, because a `Tree` write outside the project is obviously wrong. The read/execute
 * side did not: `nest-cli.json`'s `root` was pasted straight into `dist/${root}`, and
 * `../../..` normalizes to *any* absolute path on the machine — which is then what gets
 * `require()`d, both for the compiled `graphql.config.js` and for the app module. Loading
 * and executing arbitrary code off a config string is a strictly worse outcome than
 * writing a file to the wrong place, so the weaker side is the one that had to move.
 *
 * Returns the resolved absolute path so callers can use it directly instead of
 * recomputing (and possibly recomputing differently).
 *
 * Note this deliberately does *not* reject `candidate` resolving to the project root
 * itself: the root is inside the project. Callers for whom "the root itself" is
 * nonetheless invalid (a file path, say) check `path.relative(...) === ''` themselves and
 * report it in their own terms.
 */
export function assertInsideProject(
  projectRoot: string,
  candidate: string,
  label: string,
  hint?: string,
): string {
  const absolute = path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, absolute);

  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new SchematicsException(
      `${label} resolves to "${absolute}", which is outside the project root ` +
        `"${projectRoot}".${hint ? ` ${hint}` : ''}`,
    );
  }

  return absolute;
}

export function resolveProject(
  nestCli: Record<string, any>,
  projectName?: string,
  projectRoot: string = process.cwd(),
): ResolvedProject {
  const projects = nestCli.projects ?? {};

  if (projectName) {
    const project = projects[projectName];
    if (!project) {
      throw new Error(
        `Unknown project "${projectName}". Available: ${Object.keys(projects).join(', ') || '(none)'}`,
      );
    }
    const root = project.root ?? '';
    if (!root) return { distRoot: 'dist' };

    assertInsideProject(
      projectRoot,
      root,
      `Project "${projectName}"'s nest-cli.json "root" value "${root}"`,
      'That value selects the compiled output directory this schematic require()s, so it ' +
        'must stay inside the project.',
    );
    return { distRoot: `dist/${root}` };
  }

  return {
    distRoot: 'dist',
  };
}
