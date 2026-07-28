/**
 * Wrap a caught value in a new `Error` that adds context *without* losing
 * anything the original carried.
 *
 * Three separate concerns, each of which was independently gotten wrong in
 * this package before this helper existed:
 *
 * 1. **Normalization.** A `catch` binding is `unknown` for a reason: `throw
 *    'a string'`, `throw { code }` and `throw null` are all reachable from
 *    user code this package `require()`s. Reading `.message` off any of them
 *    yields `undefined`, which then serializes away entirely.
 * 2. **The cause chain.** `.cause` keeps the original object reachable for
 *    any caller that knows to look — but note that it is an object reference,
 *    so it does *not* survive a `JSON.stringify` process boundary (see
 *    `EmitFailure` in `./emitter/protocol.ts`, which carries only `message`
 *    and `stack`).
 * 3. **The stack.** This is the part that actually reaches the user. Because
 *    `.cause` is dropped at the process boundary, merging the original's
 *    stack into the wrapper's `.stack` is the only thing that gets the frame
 *    that *really* threw — a line in the user's `graphql.config.ts`, a
 *    provider constructor — in front of them. A wrapper's own stack points at
 *    this package's code, which is exactly the wrong place to look.
 *
 * `nest g` always exits 0 even when a schematic throws (an upstream
 * limitation), so an error message is the only signal a user ever gets. That
 * makes all three of the above load-bearing rather than cosmetic.
 *
 * The `message` argument is a prefix, not a full sentence: the original's
 * message is appended after a colon.
 */
export function wrapPreservingCause(message: string, err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const wrapped = new Error(`${message}: ${original.message}`);
  (wrapped as Error & { cause?: unknown }).cause = original;
  if (original.stack) wrapped.stack = `${wrapped.message}\n${original.stack}`;
  return wrapped;
}
