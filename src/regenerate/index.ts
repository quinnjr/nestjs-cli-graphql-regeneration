import { Rule, SchematicContext, SchematicsException, Tree } from '@angular-devkit/schematics';
import * as path from 'path';
import { resolveProject, ResolvedProject } from '../config/project';
import { APP_MODULE_BASENAME } from '../config/resolve';
import { resolveDistFile } from '../config/dist-layout';
import { spawnEmitter } from '../emitter/spawn';
import { buildProject } from './build-project';

/**
 * Turn the emitter's `outFile` — the user's `autoSchemaFile` value, verbatim —
 * into a schematics `Tree` path.
 *
 * A `Tree` is rooted at the project, so its paths are always project-relative
 * and absolute-looking. `autoSchemaFile`, meanwhile, is very often a real
 * absolute path: `join(process.cwd(), 'src/schema.gql')` is what the official
 * NestJS code-first docs use, and what this repo's own fixtures use. Simply
 * prefixing a `/` turned that into a Tree path mirroring the machine's full
 * directory layout — so the schematic committed a brand new file in a deep
 * junk directory, never updated the real schema, and (because `tree.read()`
 * of that path was always `null`) could never report "up to date" either.
 */
function toTreePath(projectRoot: string, outFile: string): string {
  const absolute = path.resolve(projectRoot, outFile);
  const relative = path.relative(projectRoot, absolute);

  if (relative === '') {
    // Not "outside" the project root — the opposite: `autoSchemaFile`
    // resolved to the project root directory itself, with nothing left over
    // to be a filename. Still unwritable, but for a different reason than
    // the escaping-the-root cases below, so it gets its own message rather
    // than being lumped in with them.
    throw new SchematicsException(
      `The configured schema output path "${outFile}" resolves to "${absolute}" — the ` +
        `project root itself, not a file inside it. A schematic can only write to a file. ` +
        `Point "autoSchemaFile" at a path inside the project (e.g. 'src/schema.gql', or ` +
        `join(process.cwd(), 'src/schema.gql')).`,
    );
  }

  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new SchematicsException(
      `The configured schema output path "${outFile}" resolves to "${absolute}", which is ` +
        `outside the project root "${projectRoot}". A schematic can only write inside the ` +
        `project it is run against. Point "autoSchemaFile" at a path inside the project ` +
        `(e.g. 'src/schema.gql', or join(process.cwd(), 'src/schema.gql')).`,
    );
  }

  // Tree paths are POSIX-style regardless of host platform.
  return '/' + relative.split(path.sep).join('/');
}

export interface RegenerateOptions {
  name?: string;
  path?: string;
  project?: string;
  sourceRoot?: string;
}

export function regenerate(options: RegenerateOptions): Rule {
  return async (tree: Tree, context: SchematicContext) => {
    const nestCliBuffer = tree.read('/nest-cli.json');
    if (!nestCliBuffer) {
      throw new SchematicsException(
        'Could not find nest-cli.json. Run this from a NestJS project root.',
      );
    }

    let nestCli: Record<string, any>;
    try {
      nestCli = JSON.parse(nestCliBuffer.toString('utf8'));
    } catch (err) {
      throw new SchematicsException(
        `Could not parse nest-cli.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let project: ResolvedProject;
    try {
      project = resolveProject(nestCli, options.project);
    } catch (err) {
      // resolveProject throws a plain Error; re-wrap so every failure in this Rule
      // surfaces with the same SchematicsException framing.
      throw new SchematicsException(err instanceof Error ? err.message : String(err));
    }

    const projectRoot = process.cwd();
    const schemaName = options.name ?? 'default';

    context.logger.info(`Building project${options.project ? ` "${options.project}"` : ''}...`);
    await buildProject(projectRoot, options.project);

    const distRoot = path.join(projectRoot, project.distRoot);

    const result = await spawnEmitter({
      projectRoot,
      distRoot,
      // Probed the same way, through the same helper, as the compiled
      // graphql.config.js: both files answer one question — "flat or nested
      // `src/` build output?" — and answering it differently in two places is
      // what made the documented `dist/src/` layout impossible end to end.
      appModulePath: resolveDistFile(distRoot, APP_MODULE_BASENAME),
      schemaName,
    });

    const target = toTreePath(projectRoot, result.outFile);
    const existing = tree.read(target);

    if (existing && existing.toString('utf8') === result.sdl) {
      context.logger.info(`${target} is up to date.`);
      return tree;
    }

    if (existing) tree.overwrite(target, result.sdl);
    else tree.create(target, result.sdl);

    context.logger.info(`${existing ? 'Updated' : 'Created'} ${target}`);
    return tree;
  };
}
