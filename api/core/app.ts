import { Hono } from "hono";
import { cors } from "hono/cors";

import { AppError, toErrorResponse } from "./errors.ts";
import { requestLogger } from "../middleware/requestLogger.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { healthRoutes } from "../routes/health.ts";
import { authRoutes } from "../routes/auth.ts";
import { clientRoutes } from "../routes/clients.ts";
import { uploadRoutes } from "../routes/uploads.ts";
import { pipelineRoutes } from "../routes/pipeline.ts";

/**
 * The HTTP surface the frontend talks to. Routes stay thin — they validate
 * input, call a service, and shape the response; anything with real logic lives
 * in api/services/, so it can also be driven from the CLI (main.ts).
 */
export function createApp(): Hono {
  const app = new Hono();

  app.use("*", requestLogger);

  // The browser calls this API directly from the report/upload pages. Origins
  // are allow-listed rather than "*" — required anyway once credentials are on,
  // since a wildcard origin can't be combined with cookies.
  // Origins never carry a path, so a trailing slash is always a config typo,
  // not a meaningful difference — stripped so it doesn't silently fail the
  // exact-match check below and reject every request as a CORS error.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  app.use(
    "*",
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      credentials: true, // the session cookie rides on every request; without this the browser drops it
    })
  );

  app.route("/", healthRoutes);
  app.route("/api", authRoutes); // /api/auth/* — open; this IS how a caller gets a session

  // Uploading, running the pipeline, and listing every client all sit behind
  // the one signed-in session (see api/core/session.ts — v1 has exactly one
  // account, no user table).
  //
  // A single client's report/logo/pdf (GET /api/clients/:client/...) is
  // deliberately left OPEN. That's not an oversight: docs/architecture.md has
  // always described /reports/<client> as "the client-facing deliverable" —
  // the whole point is to hand that link to a prospect or client who has no
  // login. The client slug is the access control for that one report, the
  // same "anyone with the link" model as a Google Docs share link. What stays
  // gated is discovery: GET /api/clients (the list) requires a session so a
  // stranger can't enumerate which reports exist, even though any one they
  // already know the slug for is reachable without signing in.
  app.use("/api/uploads", requireAuth);
  app.use("/api/pipeline/*", requireAuth);
  app.use("/api/clients", requireAuth);
  // Exact match only — the report/logo/pdf GETs live one segment deeper
  // (/api/clients/:client/report etc.) and stay open; only DELETE lands here.
  app.use("/api/clients/:client", requireAuth);

  app.route("/api", clientRoutes);
  app.route("/api", uploadRoutes);
  app.route("/api", pipelineRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  /**
   * Single exit point for every thrown error. Classified AppErrors keep their
   * message (the pipeline's messages are the useful part); anything else is
   * logged in full and reduced to a generic 500, so internals never leak.
   */
  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);

    if (err instanceof AppError) {
      console.warn(`[api] ${body.error.code} on ${c.req.method} ${c.req.path}: ${err.message}`);
      if (err.cause) console.warn("[api]   caused by:", err.cause);
    } else {
      console.error(`[api] UNHANDLED on ${c.req.method} ${c.req.path}:`, err);
    }

    return c.json(body, status as 400);
  });

  return app;
}
