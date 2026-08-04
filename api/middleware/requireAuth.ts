import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";

import { AuthError } from "../core/errors.ts";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../core/session.ts";

/**
 * Gates the routes that cost money or expose client data (uploads, pipeline
 * runs, report reads) behind the one signed-in session — see api/routes/auth.ts.
 * Registered per route group in app.ts, not globally, so /health and
 * /api/auth/* stay reachable without a session.
 */
export async function requireAuth(c: Context, next: Next): Promise<void> {
  const session = verifySessionToken(getCookie(c, SESSION_COOKIE_NAME));
  if (!session) {
    throw new AuthError("Sign in required.");
  }
  c.set("authEmail", session.email);
  await next();
}
