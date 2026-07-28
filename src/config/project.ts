export interface ResolvedProject {
  sourceRoot: string;
  distRoot: string;
  entryFile: string;
}

export function resolveProject(
  nestCli: Record<string, any>,
  projectName?: string,
): ResolvedProject {
  const projects = nestCli.projects ?? {};

  if (projectName) {
    const project = projects[projectName];
    if (!project) {
      throw new Error(
        `Unknown project "${projectName}". Available: ${Object.keys(projects).join(', ') || '(none)'}`,
      );
    }
    if (!project.sourceRoot) {
      throw new Error(
        `Project "${projectName}" is missing required field "sourceRoot"`,
      );
    }
    const root = project.root ?? '';
    return {
      sourceRoot: project.sourceRoot,
      distRoot: root ? `dist/${root}` : 'dist',
      entryFile: project.entryFile ?? nestCli.entryFile ?? 'main',
    };
  }

  return {
    sourceRoot: nestCli.sourceRoot ?? 'src',
    distRoot: 'dist',
    entryFile: nestCli.entryFile ?? 'main',
  };
}
