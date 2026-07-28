import { spawn } from 'child_process';

// Project names are nest-cli.json keys (or the --project CLI flag echoing one back) and
// should never contain anything but this. Validated before use regardless of the spawn
// mechanism below, as defence in depth against the whole category of shell/argument
// injection, not just the one instance closed by dropping `shell: true`.
//
// The leading character is restricted separately because argument injection is precisely
// what *survives* removing the shell: the name is appended to `nest build`, so a name of
// `-w` becomes `nest build -w` -- watch mode, which never exits, so `close` never fires
// and the promise below never settles, hanging the CLI until CI times it out. `-c<file>`
// is quieter and worse: it builds against a different tsconfig than the one this
// schematic parsed, so the emitted schema describes code that was never compiled.
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export function buildProject(projectRoot: string, projectName?: string): Promise<void> {
  if (projectName !== undefined && !PROJECT_NAME_PATTERN.test(projectName)) {
    return Promise.reject(
      new Error(
        `Invalid project name "${projectName}": nest-cli.json project names may only ` +
          'contain letters, digits, ".", "_", and "-", and may not begin with "-" ' +
          '(a leading "-" would be read by "nest build" as a command-line flag).',
      ),
    );
  }

  // No `npx`, no shell, on any platform. Two reasons:
  //
  // 1. `shell: true` (the original implementation) joins command + args into a single
  //    string handed to `/bin/sh -c` without escaping, so a `projectName` containing
  //    `;`, `|`, backticks, or `$()` -- which comes straight from the CLI via
  //    `options.project` -- would be shell-interpreted.
  // 2. The obvious `shell: true`-free fix, spawning `npx`/`npx.cmd` directly, does not
  //    work on Windows: `.cmd` files cannot be launched by `spawn()` without a shell (or
  //    without explicitly spawning `cmd.exe` with the script as an argument) -- see
  //    Node's child_process docs, "Spawning .bat and .cmd files on Windows". That is
  //    exactly the problem `cross-spawn` exists to solve, and exactly what silently
  //    breaks `nest build` on Windows if you "fix" this by special-casing `npx.cmd`.
  //
  // Instead, resolve the target project's own installed Nest CLI and run it with Node
  // directly -- no shell needed on any platform, and it uses the version the user
  // actually has installed. This mirrors the technique @nestjs/cli itself uses to invoke
  // schematics (its SchematicRunner spawns `node "<path>/schematics.js"` rather than
  // shelling out).
  let nestBin: string;
  try {
    nestBin = require.resolve('@nestjs/cli/bin/nest.js', { paths: [projectRoot] });
  } catch {
    return Promise.reject(
      new Error(
        `Could not find "@nestjs/cli" from "${projectRoot}". This package only peer-depends ` +
          'on @nestjs/schematics; the Nest CLI itself must be installed in your project ' +
          '(e.g. "npm install --save-dev @nestjs/cli") to run "nest build".',
      ),
    );
  }

  const args = ['build'];
  if (projectName) args.push(projectName);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nestBin, ...args], {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    // Without a shell, a command that can't be launched at all surfaces as an 'error'
    // event, not a non-zero 'close'. Unhandled, that would leave this promise pending
    // forever, hanging the CLI. Mirrors the same blast-containment fix in
    // ../emitter/spawn.ts.
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn "nest build": ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"nest build" exited with code ${code}.`));
    });
  });
}
