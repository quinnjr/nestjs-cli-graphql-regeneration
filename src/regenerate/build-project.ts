import { spawn } from 'child_process';

export function buildProject(projectRoot: string, projectName?: string): Promise<void> {
  const args = ['nest', 'build'];
  if (projectName) args.push(projectName);

  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, { cwd: projectRoot, stdio: 'inherit', shell: true });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"nest build" exited with code ${code}.`));
    });
  });
}
