/**
 * The file descriptor the emitter child writes its result payload to.
 *
 * Deliberately *not* stdout. The child shares stdout with `require()` of the
 * user's compiled app module and with the whole preview boot, so any
 * `console.log` reachable at require time — a config banner, `dotenv`'s debug
 * output, an ORM deprecation notice — lands in the same stream. Parsing the
 * whole stream as JSON then fails, turning an accurate diagnostic into
 * ../emitter/spawn.ts's "Emitter produced no usable output" rejection.
 *
 * A dedicated descriptor makes the payload structurally unmixable with user
 * output, and lets the parent inherit stdout so the user's own logging still
 * reaches their terminal instead of being swallowed.
 */
export const PAYLOAD_FD = 3;

export interface EmitRequest {
  projectRoot: string;
  distRoot: string;
  appModulePath: string;
  schemaName: string;
}

export interface EmitSuccess {
  ok: true;
  sdl: string;
  outFile: string;
}

export interface EmitFailure {
  ok: false;
  message: string;
  stack?: string;
}
