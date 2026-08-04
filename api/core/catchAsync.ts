import type { Context, Handler } from "hono";

import { AppError } from "./errors.ts";

/**
 * Error-handling helpers, so the same try/catch shape isn't written out at
 * every call site. Three distinct needs, three helpers:
 *
 *  - catchAsync : route handlers → funnel every throw to the app's onError
 *  - nonFatal   : best-effort work (logging, bookkeeping) that must never
 *                 replace the real error or fail the request
 *  - rethrowAs  : turn a low-level failure into a classified AppError while
 *                 keeping the original as `cause` for the server log
 */

/**
 * Wraps a route handler so a rejected promise always reaches the central error
 * handler in app.ts, with the route tagged onto the log line.
 *
 * Hono already forwards async throws to onError, so this is not a correctness
 * patch — it's here so every route reads the same way, and so the failing
 * method+path is attached even when the error itself carries no context.
 */
export function catchAsync(handler: Handler): Handler {
  return async (c, next) => {
    try {
      return await handler(c, next);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Unclassified: keep the original for the log, but note where it happened.
      console.error(`[api] unhandled in ${c.req.method} ${c.req.path}:`, err);
      throw err;
    }
  };
}

/**
 * Runs work whose failure should be logged but never surfaced.
 *
 * Used for things like "record that the pipeline failed" — if that bookkeeping
 * write itself fails, reporting *it* would bury the actual pipeline error the
 * user needs to read. Returns null instead of throwing.
 */
export async function nonFatal<T>(work: Promise<T> | (() => Promise<T>), context: string): Promise<T | null> {
  try {
    return await (typeof work === "function" ? work() : work);
  } catch (err) {
    console.error(`[nonfatal] ${context}: ${(err as Error).message ?? err}`);
    return null;
  }
}

/**
 * Runs work and, on failure, throws the AppError that `wrap` builds from the
 * original error — so callers classify a failure once instead of writing
 * try/catch/rethrow by hand.
 */
export async function rethrowAs<T>(work: () => Promise<T>, wrap: (cause: unknown) => AppError): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw wrap(err);
  }
}

/** Convenience for route handlers that only need the Context. */
export type AsyncHandler = (c: Context) => Promise<Response>;
