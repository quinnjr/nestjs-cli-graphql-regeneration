import { spawn } from 'child_process';

export function buildProject(projectRoot: string, projectName?: string): Promise<void> {
  // No `shell: true`: with a shell, Node joins command + args into a single string
  // handed to `/bin/sh -c` without escaping, so a `projectName` containing `;`, `|`,
  // backticks, or `$()` -- which comes straight from the CLI via `options.project` --
  // would be interpreted by the shell. `npx` needs no shell on POSIX, so `shell: true`
  // bought nothing here and only opened that surface.
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['nest', 'build'];
  if (projectName) args.push(projectName);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' });

    // Without a shell, a command that can't be launched at all (e.g. `npx` missing)
    // surfaces as an 'error' event, not a non-zero 'close' -- unlike the `shell: true`
    // behavior this replaces, where the shell itself would run and exit non-zero.
    // Unhandled, 'error' would leave this promise pending forever, hanging the CLI.
    // Mirrors the same blast-containment fix in ../emitter/spawn.ts.
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn "nest build": ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"nest build" exited with code ${code}.`));
    });
  });
}
