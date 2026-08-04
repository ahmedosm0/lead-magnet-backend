/**
 * Step 6 (Assemble) — docs/pipeline-steps.md
 *
 * Combines three already-produced checkpoints into one self-contained
 * report record: 02_normalized.json (for the chart series), 03_aggregates.json
 * (the numbers), and 05_narrative.json (the write-up) — plus branding for
 * whichever prospect agency the report is for. This is the one step that
 * legitimately reads more than its immediate predecessor, because its whole
 * job is combining things, not computing something new.
 *
 * Usage:
 *   node --experimental-strip-types scripts/assemble/run.ts                                   # all clients, default agency
 *   node --experimental-strip-types scripts/assemble/run.ts <client> [agencySlug]              # one client, optional agency
 *
 * Agency also settable via AGENCY_SLUG env var (used when main.ts drives this step for every client).
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assembleReport } from "./assemble.ts";
import { resolveBrandingForClient } from "./branding.ts";
import { writeCheckpoint } from "../lib/checkpoint.ts";
import { getReportIdBySlug, saveReportRecord, setReportStatus } from "../../db/reports.ts";
import type { NormalizedDataset } from "../normalize/types.ts";
import type { AggregateResult } from "../aggregate/types.ts";
import type { NarrativeResult } from "../narrative/types.ts";
import type { ReportRecord } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const OUTPUT_DIR = path.join(REPO_ROOT, "backend", "output");

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function discoverNarratedClients(): Promise<string[]> {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function readJsonCheckpoint<T>(outputDir: string, fileName: string, client: string, stepLabel: string): Promise<T> {
  const filePath = path.join(outputDir, fileName);
  try {
    const text = await readFile(filePath, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${filePath} not found. Run ${stepLabel} for "${client}" first.`);
  }
}

function buildReportTextSummary(report: ReportRecord): string {
  const { branding, narrative, metrics, chartSeries } = report;

  const lines: string[] = [
    `Report record — ${report.client}`,
    `Step 6 checkpoint: narrative + numbers + branding, combined into one self-contained object (see docs/pipeline-steps.md)`,
    ``,
    `--- Branding (${branding.agencySlug}) ---`,
    `Agency: ${branding.agencyName}`,
    `Colors: ${branding.primaryColor} / ${branding.secondaryColor}`,
    `Logo:   ${branding.logoPath}`,
    ``,
    `--- Headline metrics ---`,
    `Period: ${metrics.currentPeriod.period.start} to ${metrics.currentPeriod.period.end}`,
    `Spend:  ${fmtMoney(metrics.currentPeriod.spend)}  Results: ${metrics.currentPeriod.metaResults}  ` +
      (metrics.pacing === null ? `Pacing: n/a (no plan on record)` : `Pacing: ${metrics.pacing.pct.toFixed(1)}% (${metrics.pacing.status})`),
    ``,
    `--- Narrative ---`,
    narrative.executiveSummary,
    ``,
    `--- Chart series (day-by-day, for the report's trend chart) ---`,
    `${chartSeries.length} days: ${chartSeries[0]?.date} to ${chartSeries[chartSeries.length - 1]?.date}`,
    ``,
    pad("Date", 12) + pad("Sessions", 10) + pad("Spend", 10) + pad("Results", 9) + pad("Revenue", 10),
    "-".repeat(55),
  ];

  for (const point of chartSeries.slice(0, 5)) {
    lines.push(
      pad(point.date, 12) +
        pad(point.sessions, 10) +
        pad(fmtMoney(point.spend), 10) +
        pad(point.results, 9) +
        pad(fmtMoney(point.revenue), 10)
    );
  }
  lines.push(`... (${chartSeries.length - 5} more days)`);

  return lines.join("\n") + "\n";
}

export async function assembleClient(client: string): Promise<void> {
  const outputDir = path.join(OUTPUT_DIR, client);

  const normalized = await readJsonCheckpoint<NormalizedDataset>(
    outputDir,
    "02_normalized.json",
    client,
    "Step 2 (normalize)"
  );
  const aggregate = await readJsonCheckpoint<AggregateResult>(
    outputDir,
    "03_aggregates.json",
    client,
    "Step 3 (aggregate)"
  );
  const narrativeResult = await readJsonCheckpoint<NarrativeResult>(
    outputDir,
    "05_narrative.json",
    client,
    "Step 5 (narrative)"
  );

  const branding = await resolveBrandingForClient(client);
  const report = assembleReport({
    client,
    branding,
    narrative: narrativeResult.narrative,
    aggregate,
    normalizedRows: normalized.rows,
  });

  const { jsonPath } = await writeCheckpoint({
    outputDir,
    stepName: "06_report",
    data: report,
    textSummary: buildReportTextSummary(report),
  });

  // Last pipeline step before rendering — persist the assembled record and
  // mark the report viewable.
  const reportId = await getReportIdBySlug(client);
  await saveReportRecord(reportId, report);
  await setReportStatus(reportId, "ready");

  console.log(`[assemble] ${client}: branded for ${branding.agencyName} -> ${jsonPath}`);
}

async function main(): Promise<void> {
  const requestedClient = process.argv[2];
  const requestedAgency = process.argv[3];
  if (requestedAgency) process.env.AGENCY_SLUG = requestedAgency;

  const clients = requestedClient ? [requestedClient] : await discoverNarratedClients();

  if (clients.length === 0) {
    console.error(`No clients found under ${OUTPUT_DIR}. Run Step 5 (narrative) first.`);
    process.exit(1);
  }

  for (const client of clients) {
    await assembleClient(client);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[assemble] failed:", err.message ?? err);
    process.exit(1);
  });
}
