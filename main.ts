/**
 * Backend entrypoint — the HTTP API the frontend talks to.
 *
 * Usage (from backend/):
 *   npm run dev      # watch mode
 *   npm run start
 *
 * The pipeline can also be driven from the command line (scripts/cli.ts,
 * `npm run pipeline`). Both paths call the same step functions — neither
 * duplicates the other's logic.
 */

import { serve } from "@hono/node-server";

import { createApp } from "./api/core/app.ts";
import { checkDbHealth } from "./db/health.ts";

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Verifies the database before accepting traffic, so a bad key or an unreachable
 * project surfaces here — at boot, once — instead of as a confusing failure on
 * someone's first upload.
 *
 * An unreachable-but-configured database is fatal: it means credentials were
 * supplied and are silently not working, and continuing would drop every write.
 * A database that isn't configured at all is fine — persistence is optional by
 * design (see db/client.ts), so we log it and carry on with checkpoint files.
 */
async function verifyDatabase(): Promise<void> {
  const health = await checkDbHealth();

  switch (health.state) {
    case "connected":
      console.log(`[startup] database connected (${health.latencyMs}ms)`);
      return;
    case "disabled":
      console.warn(`[startup] database disabled — ${health.reason}`);
      return;
    case "unreachable":
      console.error(`[startup] database unreachable — ${health.reason}`);
      console.error("[startup] Supabase credentials are set but not working. Fix them, or unset them to run without persistence.");
      process.exit(1);
  }
}

async function main(): Promise<void> {
  await verifyDatabase();

  const server = serve({ fetch: createApp().fetch, port: PORT }, (info) => {
    console.log(`[startup] API listening on http://localhost:${info.port}`);
  });

  // Without this, a busy port surfaces as a raw Node stack trace, which reads
  // like a crash rather than "something else is already running".
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[startup] port ${PORT} is already in use — another backend is probably still running.`);
      console.error(`[startup] Stop it, or start this one on a different port: PORT=4001 npm start`);
    } else {
      console.error("[startup] server error:", err);
    }
    process.exit(1);
  });

  // Let in-flight requests finish; a pipeline run mid-request shouldn't be cut off.
  const shutdown = (signal: string) => {
    console.log(`\n[shutdown] ${signal} received, closing server...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[startup] failed:", err);
  process.exit(1);
});
