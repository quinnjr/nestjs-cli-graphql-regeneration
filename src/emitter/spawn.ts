import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { EmitRequest, EmitSuccess, EmitFailure } from './protocol';

export { EmitRequest, EmitSuccess, EmitFailure };

// The child always loads compiled JavaScript, so child.js must exist as a real
// file on disk. Post-build, this module runs as dist/emitter/spawn.js with
// dist/emitter/child.js right beside it. Under ts-jest, though, this module
// runs straight from src/emitter/spawn.ts — __dirname is src/emitter, where
// child.ts has no .js sibling — so also try the compiled output one level up.
// Mirrors the dual-candidate-path pattern in ../config/resolve.ts.
function resolveChildEntry(): string {
  const candidates = [
    path.join(__dirname, 'child.js'),
    path.join(__dirname, '..', '..', 'dist', 'emitter', 'child.js'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `Could not find the compiled emitter child entry. Looked in:\n` +
        candidates.map((c) => `  - ${c}`).join('\n') +
        `\nRun "pnpm build" first.`,
    );
  }
  return found;
}

export function spawnEmitter(req: EmitRequest): Promise<EmitSuccess> {
  const childEntry = resolveChildEntry();

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-r', 'reflect-metadata', childEntry, JSON.stringify(req)],
      {
        cwd: req.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_PATH: path.join(req.projectRoot, 'node_modules'),
        },
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', () => {
      let parsed: EmitSuccess | EmitFailure;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`Emitter produced no usable output.\n${stderr || stdout}`));
        return;
      }
      if (parsed.ok) resolve(parsed);
      else reject(new Error(parsed.message));
    });
  });
}
