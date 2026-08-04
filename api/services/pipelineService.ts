import { parseClient } from "../../scripts/parse/run.ts";
import { normalizeClient } from "../../scripts/normalize/run.ts";
import { aggregateClient } from "../../scripts/aggregate/run.ts";
import { buildBriefForClient } from "../../scripts/brief/run.ts";
import { generateNarrativeForClient } from "../../scripts/narrative/run.ts";
import { assembleClient } from "../../scripts/assemble/run.ts";

import { PipelineError, ValidationError } from "../core/errors.ts";
import { nonFatal } from "../core/catchAsync.ts";
import { isValidClientSlug } from "../../lib/slug.ts";
import {
  finishPipelineRun,
  getReportIdBySlug,
  markPipelineStep,
  setReportStatus,
  startPipelineRun,
} from "../../db/reports.ts";

/**
 * Runs Steps 1-6 in-process.
 *
 * Previously the frontend shelled out to `main.ts` with execFile and parsed
 * stdout. Calling the step functions directly means a step's thrown Error
 * arrives as an Error — so we know exactly which step failed and can attach
 * that to both the HTTP response and the pipeline_runs row, instead of
 * scraping a log. It also drops a process spawn per report.
 */
const STEPS: Array<{ name: string; run: (client: string) => Promise<void> }> = [
  { name: "parse", run: parseClient },
  { name: "normalize", run: normalizeClient },
  { name: "aggregate", run: aggregateClient },
  { name: "brief", run: buildBriefForClient },
  { name: "narrative", run: generateNarrativeForClient },
  { name: "assemble", run: assembleClient },
];

export interface PipelineRunResult {
  client: string;
  steps: Array<{ name: string; durationMs: number }>;
  durationMs: number;
}

export async function runPipeline(client: string): Promise<PipelineRunResult> {
  if (!isValidClientSlug(client)) {
    throw new ValidationError(`Invalid client id "${client}"`, { field: "client" });
  }

  const reportId = await getReportIdBySlug(client);
  const runId = await startPipelineRun(reportId);
  const startedAt = Date.now();
  const steps: PipelineRunResult["steps"] = [];

  try {
    for (const step of STEPS) {
      await markPipelineStep(runId, step.name);
      const stepStartedAt = Date.now();
      try {
        await step.run(client);
      } catch (err) {
        // The pipeline throws deliberately specific messages ("column X missing
        // in row 12") — that text is the most useful thing we can hand back, so
        // preserve it and tag which step produced it.
        throw new PipelineError((err as Error).message ?? String(err), step.name, err);
      }
      steps.push({ name: step.name, durationMs: Date.now() - stepStartedAt });
    }

    const durationMs = Date.now() - startedAt;
    await finishPipelineRun(runId, { status: "succeeded", durationMs });
    return { client, steps, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const failedStep = err instanceof PipelineError ? (err.details?.step as string) : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Record the failure, but never let a bookkeeping failure mask the real
    // error — that would replace an actionable message with a Supabase one.
    await nonFatal(
      finishPipelineRun(runId, { status: "failed", failedStep, errorMessage, durationMs }),
      "record pipeline run failure"
    );
    await nonFatal(setReportStatus(reportId, "failed", errorMessage), "mark report failed");

    throw err;
  }
}
