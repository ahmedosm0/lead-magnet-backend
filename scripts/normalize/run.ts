/**
 * Step 2 (Normalize) — docs/pipeline-steps.md
 *
 * Reads the 01_parsed checkpoint written by Step 1 (does NOT re-parse the
 * raw CSVs — that's the point of checkpointing: this step can be re-run on
 * its own against whatever is in 01_parsed.json) and maps GA4 rows + Meta
 * rows into one unified schema. Writes the 02_normalized checkpoint.
 *
 * Usage:
 *   node --experimental-strip-types scripts/normalize/run.ts            # all clients
 *   node --experimental-strip-types scripts/normalize/run.ts <client>   # one client
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeGa4Rows, normalizeMetaRows, inferResultType } from "./normalize.ts";
import { writeCheckpoint } from "../lib/checkpoint.ts";
import { getReportIdBySlug, saveNormalizedMetrics } from "../../db/reports.ts";
import type { ParsedDataset } from "../parse/types.ts";
import type { NormalizedDataset, NormalizedMetricRow } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives at <backend-root>/scripts/normalize/ — two levels down
// from the backend's own root, where output/ actually lives.
const BACKEND_ROOT = path.resolve(__dirname, "../../");
const OUTPUT_DIR = path.join(BACKEND_ROOT, "output");

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

async function discoverParsedClients(): Promise<string[]> {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function buildNormalizedTextSummary(client: string, dataset: NormalizedDataset): string {
  const { rows } = dataset;
  const ga4Rows = rows.filter((r) => r.source === "ga4");
  const metaRows = rows.filter((r) => r.source === "meta");

  const totalSessions = ga4Rows.reduce((sum, r) => sum + (r.sessions ?? 0), 0);
  const totalSpend = metaRows.reduce((sum, r) => sum + r.spend, 0);
  const ga4Revenue = ga4Rows.reduce((sum, r) => sum + r.revenue, 0);
  const metaRevenue = metaRows.reduce((sum, r) => sum + r.revenue, 0);
  const ga4Results = ga4Rows.reduce((sum, r) => sum + r.results, 0);
  const metaResults = metaRows.reduce((sum, r) => sum + r.results, 0);

  const dimensionValues = [...new Set(rows.map((r) => r.dimensionValue))].sort();

  const header = [
    `Normalized metrics — ${client}`,
    `Step 2 checkpoint: unified GA4 + Meta schema (see docs/pipeline-steps.md)`,
    `Client-level result type: ${dataset.resultType}` +
      (dataset.sources.meta ? "" : " (inferred from GA4 revenue — no Meta export supplied)"),
    ``,
    `Rows: ${rows.length} (${ga4Rows.length} GA4 + ${metaRows.length} Meta)`,
    `Dimensions present: ${dimensionValues.join(", ")}`,
    ``,
    dataset.sources.ga4
      ? `GA4 side:  ${totalSessions} sessions, ${ga4Results} key events, $${ga4Revenue.toFixed(2)} site revenue`
      : `GA4 side:  not supplied — sessions and site revenue are omitted downstream, not reported as 0`,
    dataset.sources.meta
      ? `Meta side: $${totalSpend.toFixed(2)} spend, ${metaResults} results, $${metaRevenue.toFixed(2)} platform-attributed revenue`
      : `Meta side: not supplied — spend, results, cost/result and campaigns are omitted downstream, not reported as 0`,
    `Note: GA4 "key events"/revenue and Meta "results"/revenue are NOT additive — GA4 counts all channels`,
    `(organic + paid), Meta counts only its own paid campaigns' attributed results. Aggregation (Step 3)`,
    `is where these get reconciled into one pacing/performance view, not here.`,
    ``,
    pad("Date", 12) + pad("Source", 8) + pad("Dimension", 11) + pad("Value", 40) +
      pad("Sessions", 9) + pad("Spend", 9) + pad("Results", 8) + pad("Revenue", 10),
    "-".repeat(107),
  ].join("\n");

  const sorted = [...rows].sort((a, b) =>
    a.date === b.date ? a.source.localeCompare(b.source) : a.date.localeCompare(b.date)
  );

  const body = sorted
    .map(
      (r) =>
        pad(r.date, 12) +
        pad(r.source, 8) +
        pad(r.dimension, 11) +
        pad(r.dimensionValue.slice(0, 38), 40) +
        pad(r.sessions ?? "-", 9) +
        pad(`$${r.spend.toFixed(2)}`, 9) +
        pad(r.results, 8) +
        pad(`$${r.revenue.toFixed(2)}`, 10)
    )
    .join("\n");

  return `${header}\n${body}\n`;
}

export async function normalizeClient(client: string): Promise<void> {
  const outputDir = path.join(OUTPUT_DIR, client);
  const parsedPath = path.join(outputDir, "01_parsed.json");

  let parsedText: string;
  try {
    parsedText = await readFile(parsedPath, "utf-8");
  } catch {
    throw new Error(
      `${parsedPath} not found. Run Step 1 (parse) for "${client}" first: ` +
        `npm run parse -- ${client}`
    );
  }

  const parsed: ParsedDataset = JSON.parse(parsedText);
  // Checkpoints written before `sources` existed don't carry it — infer from the rows.
  const sources = parsed.sources ?? { ga4: parsed.ga4.length > 0, meta: parsed.meta.length > 0 };
  const resultType = inferResultType(parsed.meta, parsed.ga4, client);

  const rows: NormalizedMetricRow[] = [
    ...normalizeGa4Rows(parsed.ga4, resultType),
    ...normalizeMetaRows(parsed.meta),
  ];

  const dataset: NormalizedDataset = {
    client,
    normalizedAt: new Date().toISOString(),
    resultType,
    sources,
    rows,
  };

  const { jsonPath } = await writeCheckpoint({
    outputDir,
    stepName: "02_normalized",
    data: dataset,
    textSummary: buildNormalizedTextSummary(client, dataset),
  });

  // Mirror into Supabase when configured — no-op otherwise (see backend/db/client.ts).
  const reportId = await getReportIdBySlug(client);
  await saveNormalizedMetrics(reportId, rows);

  console.log(`[normalize] ${client}: ${rows.length} unified rows (resultType=${resultType}) -> ${jsonPath}`);
}

async function main(): Promise<void> {
  const requestedClient = process.argv[2];
  const clients = requestedClient ? [requestedClient] : await discoverParsedClients();

  if (clients.length === 0) {
    console.error(`No parsed clients found under ${OUTPUT_DIR}. Run Step 1 (parse) first.`);
    process.exit(1);
  }

  for (const client of clients) {
    await normalizeClient(client);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[normalize] failed:", err.message ?? err);
    process.exit(1);
  });
}
