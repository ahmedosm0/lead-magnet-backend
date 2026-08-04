import { Hono } from "hono";
import { cors } from "hono/cors";

import { AppError, toErrorResponse } from "./errors.ts";
import { requestLogger } from "../middleware/requestLogger.ts";
import { healthRoutes } from "../routes/health.ts";
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
  // are allow-listed rather than "*" so this stays correct once credentials or
  // an ops token are added.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    "*",
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    })
  );

  app.route("/", healthRoutes);
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
