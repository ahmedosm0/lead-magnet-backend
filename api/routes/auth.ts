import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { AuthError, ValidationError } from "../core/errors.ts";
import { catchAsync } from "../core/catchAsync.ts";
import { ADMIN_EMAIL, SESSION_COOKIE_NAME, checkAdminCredentials, createSessionToken, verifySessionToken } from "../core/session.ts";

export const authRoutes = new Hono();

const isProd = process.env.NODE_ENV === "production";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // keep in step with SESSION_TTL_MS in core/session.ts

authRoutes.post(
  "/auth/login",
  catchAsync(async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!email || !password) {
      throw new ValidationError("Email and password are required.");
    }

    // Same message either way — don't tell a caller which of the two they got wrong.
    if (!checkAdminCredentials(email, password)) {
      throw new AuthError("Incorrect email or password.");
    }

    setCookie(c, SESSION_COOKIE_NAME, createSessionToken(ADMIN_EMAIL), {
      httpOnly: true, // never readable from JS — an XSS bug can't exfiltrate the session this way
      sameSite: "Lax",
      secure: isProd,
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });

    return c.json({ email: ADMIN_EMAIL });
  })
);

authRoutes.post(
  "/auth/logout",
  catchAsync(async (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  })
);

/** Open (no requireAuth) on purpose — this is how a caller checks whether it needs to log in at all. */
authRoutes.get(
  "/auth/me",
  catchAsync(async (c) => {
    const session = verifySessionToken(getCookie(c, SESSION_COOKIE_NAME));
    return c.json({ email: session?.email ?? null });
  })
);
