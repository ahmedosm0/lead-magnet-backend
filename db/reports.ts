import { runQuery, runScopedQuery } from "./query.ts";
import type { AggregateResult } from "../scripts/aggregate/types.ts";
import type { Branding } from "../scripts/assemble/types.ts";
import type { NormalizedMetricRow } from "../scripts/normalize/types.ts";
import type { Narrative } from "../scripts/narrative/types.ts";

/**
 * Persistence for one report run.
 *
 * Every function here is a no-op when Supabase isn't configured, or when the
 * client has no `reports` row — handled once in runQuery/runScopedQuery rather
 * than guarded at each call site. Callers therefore never branch on whether
 * persistence is on; the checkpoint files remain the pipeline's source of
 * truth either way.
 *
 * Ordering matches the pipeline: upsertReport (upload) → saveNormalizedMetrics
 * (Step 2) → saveAggregates (3) → saveBrief (4) → saveNarrative (5) →
 * saveReportRecord + setReportStatus (6) → saveRender (8).
 */

export interface UpsertReportInput {
  clientSlug: string;
  clientName: string;
  websiteUrl?: string | null;
  branding?: Partial<Branding> | null;
  monthlyPlan?: number | null;
}

export type ReportStatus = "pending" | "parsing" | "narrating" | "ready" | "failed";

/** Creates (or refreshes) the report row for a client and returns its id. */
export async function upsertReport(input: UpsertReportInput): Promise<string | null> {
  const row = await runQuery("upsertReport", (supabase) =>
    supabase
      .from("reports")
      .upsert(
        {
          client_slug: input.clientSlug,
          client_name: input.clientName,
          website_url: input.websiteUrl ?? null,
          branding: input.branding ?? {},
          monthly_plan: input.monthlyPlan ?? null,
          status: "pending",
          error_message: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_slug" }
      )
      .select("id")
      .single()
  );
  return (row?.id as string) ?? null;
}

export async function getReportIdBySlug(clientSlug: string): Promise<string | null> {
  const row = await runQuery("getReportIdBySlug", (supabase) =>
    supabase.from("reports").select("id").eq("client_slug", clientSlug).maybeSingle()
  );
  return (row?.id as string) ?? null;
}

export async function setReportStatus(
  reportId: string | null,
  status: ReportStatus,
  errorMessage?: string
): Promise<void> {
  await runScopedQuery("setReportStatus", reportId, (supabase, id) =>
    supabase
      .from("reports")
      .update({ status, error_message: errorMessage ?? null, updated_at: new Date().toISOString() })
      .eq("id", id)
  );
}

/** Step 1 input: one row per uploaded CSV. Bytes stay on disk; this records what/where. */
export async function saveRawUpload(
  reportId: string | null,
  upload: { source: "ga4" | "meta"; fileName: string; storagePath: string; byteSize: number; contentHash: string }
): Promise<void> {
  await runScopedQuery("saveRawUpload", reportId, (supabase, id) =>
    supabase.from("raw_uploads").upsert(
      {
        report_id: id,
        source: upload.source,
        file_name: upload.fileName,
        storage_path: upload.storagePath,
        byte_size: upload.byteSize,
        content_hash: upload.contentHash,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: "report_id,source" }
    )
  );
}

/**
 * Step 2 output. Replaces this report's rows wholesale — re-running normalize
 * must not append a second copy. Chunked because this is the one table whose
 * row count grows with the size of the client's history.
 */
export async function saveNormalizedMetrics(reportId: string | null, rows: NormalizedMetricRow[]): Promise<void> {
  if (!reportId) return;

  await runScopedQuery("saveNormalizedMetrics (clear)", reportId, (supabase, id) =>
    supabase.from("normalized_metrics").delete().eq("report_id", id)
  );

  const payload = rows.map((row) => ({
    report_id: reportId,
    metric_date: row.date,
    source: row.source,
    dimension: row.dimension,
    dimension_value: row.dimensionValue,
    sessions: row.sessions ?? null,
    spend: row.spend,
    results: row.results,
    result_type: row.resultType ?? null,
    revenue: row.revenue,
  }));

  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    await runQuery("saveNormalizedMetrics", (supabase) => supabase.from("normalized_metrics").insert(slice));
  }
}

/** Step 3 output — cached so a branding-only change never recomputes it. */
export async function saveAggregates(reportId: string | null, aggregate: AggregateResult): Promise<void> {
  await runScopedQuery("saveAggregates", reportId, (supabase, id) =>
    supabase.from("metric_aggregates").upsert({ report_id: id, payload: aggregate }, { onConflict: "report_id" })
  );
}

/** Step 4 output — the exact payload the LLM saw, kept so narratives stay auditable. */
export async function saveBrief(reportId: string | null, brief: unknown, tokenEstimate: number | null): Promise<void> {
  await runScopedQuery("saveBrief", reportId, (supabase, id) =>
    supabase
      .from("briefs")
      .upsert({ report_id: id, payload: brief, token_estimate: tokenEstimate }, { onConflict: "report_id" })
  );
}

/**
 * Step 5 output. Appends a new version rather than overwriting — Step 5 is the
 * only step that costs money, and regenerating prose must never destroy what a
 * client may already have been sent.
 */
export async function saveNarrative(reportId: string | null, narrative: Narrative, model: string): Promise<void> {
  if (!reportId) return;

  const latest = await runScopedQuery("saveNarrative (version lookup)", reportId, (supabase, id) =>
    supabase.from("narratives").select("version").eq("report_id", id).order("version", { ascending: false }).limit(1).maybeSingle()
  );

  const nextVersion = ((latest?.version as number) ?? 0) + 1;
  await runScopedQuery("saveNarrative", reportId, (supabase, id) =>
    supabase.from("narratives").insert({ report_id: id, version: nextVersion, content: narrative, model })
  );
}

/** Step 6 output — the assembled record the web view and PDF render from. */
export async function saveReportRecord(reportId: string | null, report: unknown): Promise<void> {
  await runScopedQuery("saveReportRecord", reportId, (supabase, id) =>
    supabase
      .from("report_records")
      .upsert({ report_id: id, payload: report, updated_at: new Date().toISOString() }, { onConflict: "report_id" })
  );
}

/** Step 8 — where the rendered artifacts ended up. */
export async function saveRender(
  reportId: string | null,
  render: { webViewUrl?: string; pdfUrl?: string }
): Promise<void> {
  await runScopedQuery("saveRender", reportId, (supabase, id) =>
    supabase
      .from("report_renders")
      .insert({ report_id: id, web_view_url: render.webViewUrl ?? null, pdf_url: render.pdfUrl ?? null })
  );
}

// --- reads -------------------------------------------------------------------

/** Lets the API serve reports without sharing a filesystem with the pipeline. */
export async function getReportRecordBySlug(clientSlug: string): Promise<unknown | null> {
  const row = await runQuery("getReportRecordBySlug", (supabase) =>
    supabase
      .from("report_records")
      .select("payload, reports!inner(client_slug)")
      .eq("reports.client_slug", clientSlug)
      .maybeSingle()
  );
  return row?.payload ?? null;
}

export async function listReadyClientSlugs(): Promise<string[]> {
  const rows = await runQuery("listReadyClientSlugs", (supabase) =>
    supabase.from("reports").select("client_slug, report_records!inner(id)").order("created_at", { ascending: false })
  );
  return ((rows as Array<{ client_slug: string }> | undefined) ?? []).map((row) => row.client_slug);
}

// --- pipeline run tracking ---------------------------------------------------

export async function startPipelineRun(reportId: string | null): Promise<string | null> {
  const row = await runScopedQuery("startPipelineRun", reportId, (supabase, id) =>
    supabase.from("pipeline_runs").insert({ report_id: id, status: "running" }).select("id").single()
  );
  return (row?.id as string) ?? null;
}

export async function markPipelineStep(runId: string | null, step: string): Promise<void> {
  await runScopedQuery("markPipelineStep", runId, (supabase, id) =>
    supabase.from("pipeline_runs").update({ current_step: step }).eq("id", id)
  );
}

export async function finishPipelineRun(
  runId: string | null,
  result: { status: "succeeded" | "failed"; failedStep?: string; errorMessage?: string; durationMs: number }
): Promise<void> {
  await runScopedQuery("finishPipelineRun", runId, (supabase, id) =>
    supabase
      .from("pipeline_runs")
      .update({
        status: result.status,
        failed_step: result.failedStep ?? null,
        // Truncated: a stack-y message shouldn't bloat the row.
        error_message: result.errorMessage?.slice(0, 2000) ?? null,
        finished_at: new Date().toISOString(),
        duration_ms: result.durationMs,
        current_step: null,
      })
      .eq("id", id)
  );
}
