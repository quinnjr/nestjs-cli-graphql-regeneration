import { Rule, SchematicContext, SchematicsException, Tree } from '@angular-devkit/schematics';
import * as path from 'path';
import { resolveProject, ResolvedProject } from '../config/project';
import { spawnEmitter } from '../emitter/spawn';
import { buildProject } from './build-project';

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

    const result = await spawnEmitter({
      projectRoot,
      distRoot: path.join(projectRoot, project.distRoot),
      appModulePath: path.join(projectRoot, project.distRoot, 'app.module.js'),
      schemaName,
    });

    const target = '/' + result.outFile.replace(/^\.?\//, '');
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
