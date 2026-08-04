import { Hono } from "hono";
import { checkDbHealth } from "../../db/health.ts";

export const healthRoutes = new Hono();

/**
 * Reports database reachability alongside liveness.
 *
 * `db.state: "disabled"` is not a failure — persistence is optional by design
 * (see db/client.ts), so the service is still healthy without it. Only an
 * unreachable-but-configured database degrades status, because that means
 * writes are silently being lost.
 */
healthRoutes.get("/health", async (c) => {
  const db = await checkDbHealth();
  const ok = db.state !== "unreachable";
  return c.json({ status: ok ? "ok" : "degraded", db, uptimeSeconds: Math.round(process.uptime()) }, ok ? 200 : 503);
});
