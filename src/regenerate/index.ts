import { Rule, SchematicContext, Tree } from '@angular-devkit/schematics';

export interface RegenerateOptions {
  name?: string;
  path?: string;
  project?: string;
  sourceRoot?: string;
}

export function regenerate(options: RegenerateOptions): Rule {
  return (tree: Tree, context: SchematicContext) => {
    context.logger.info(`regenerate: schema "${options.name ?? 'default'}"`);
    return tree;
  };
}
