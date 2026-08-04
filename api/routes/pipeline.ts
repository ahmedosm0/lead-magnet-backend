import { Hono } from "hono";

import { ValidationError } from "../core/errors.ts";
import { catchAsync } from "../core/catchAsync.ts";
import { runPipeline } from "../services/pipelineService.ts";

export const pipelineRoutes = new Hono();

/**
 * Synchronous by design for v1: a run finishes well inside the 2-minute target
 * in docs/project.md, and the caller wants the report immediately. When runs
 * outgrow an HTTP request this becomes "enqueue + poll" — the pipeline_runs row
 * already exists to support that.
 */
pipelineRoutes.post(
  "/pipeline/run",
  catchAsync(async (c) => {
    const body = await c.req.json().catch(() => null);
    const client = (body as { client?: unknown } | null)?.client;

    if (typeof client !== "string" || client.length === 0) {
      throw new ValidationError('Body must be JSON with a "client" string.', { field: "client" });
    }

    return c.json(await runPipeline(client));
  })
);
