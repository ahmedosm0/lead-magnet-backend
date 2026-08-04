import type { MiddlewareHandler } from "hono";

/** One line per request: method, path, status, duration. Enough to see what the frontend is doing. */
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const startedAt = Date.now();
  await next();
  const ms = Date.now() - startedAt;
  console.log(`[api] ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
};
