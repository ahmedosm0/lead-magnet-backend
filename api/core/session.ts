import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * v1 has exactly one account (see docs/project.md — no user accounts beyond a
 * protected ops route). There's nowhere to store a second one, so the
 * credentials and the session signing key both live in env vars rather than a
 * users table. Defaults exist so the app runs out of the box in dev; change
 * ADMIN_PASSWORD and set a real SESSION_SECRET before this is reachable from
 * anywhere but your own machine.
 */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@gmail.com";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "pass@123";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me";
if (!process.env.SESSION_SECRET) {
  console.warn(
    "[session] SESSION_SECRET is not set — using a fixed, publicly-known dev fallback. " +
      "Set a long random SESSION_SECRET in backend/.env before deploying anywhere reachable from outside your machine."
  );
}

export const SESSION_COOKIE_NAME = "session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Constant-time string comparison, used for both the login check and (via
 * verifySessionToken) the cookie signature check — a length- or content-
 * dependent early-exit would let a timing attack narrow down the secret one
 * byte at a time. Hashing first also sidesteps the "different lengths" case,
 * which crypto.timingSafeEqual refuses to compare directly.
 */
function safeEqual(a: string, b: string): boolean {
  const digestOf = (value: string) => createHmac("sha256", SESSION_SECRET).update(value).digest();
  return timingSafeEqual(digestOf(a), digestOf(b));
}

export function checkAdminCredentials(email: string, password: string): boolean {
  return safeEqual(email.toLowerCase(), ADMIN_EMAIL.toLowerCase()) && safeEqual(password, ADMIN_PASSWORD);
}

interface SessionPayload {
  email: string;
  exp: number;
}

/**
 * A signed, self-contained token: base64url(payload) + "." + HMAC signature.
 * No server-side session store needed — verifying is just re-computing the
 * signature and checking `exp`, which is what lets api/middleware/requireAuth.ts
 * stay a pure function with no database round-trip.
 */
export function createSessionToken(email: string): string {
  const payload: SessionPayload = { email, exp: Date.now() + SESSION_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export function verifySessionToken(token: string | undefined): { email: string } | null {
  if (!token) return null;

  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;

  const expectedSignature = createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  if (signature.length !== expectedSignature.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as SessionPayload;
    if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    return { email: payload.email };
  } catch {
    return null;
  }
}
