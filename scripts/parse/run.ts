/**
 * Step 1 (Parse) — docs/pipeline-steps.md
 *
 * Reads whichever of the GA4 / Meta CSVs a client supplied, type-checks and
 * cleans them, and writes the 01_parsed checkpoint (JSON + human-readable
 * .txt) to backend/output/<client>/.
 *
 * Both exports together give the fullest report, but either one alone is
 * valid — the missing side is recorded in `sources` and every downstream step
 * omits what it can't compute rather than reporting zeroes.
 *
 * A client's CSVs can live in either of two places, checked in order:
 *   1. backend/uploads/<client>/   — real files uploaded via the frontend
 *      (gitignored, see backend/.gitignore)
 *   2. sample-data/<client>/       — the built-in seeded demo dataset
 * This lets the same discovery/parse logic serve both the demo clients and
 * anything a user uploads, without the frontend needing to know this path.
 *
 * Usage:
 *   node --experimental-strip-types scripts/parse/run.ts            # all clients
 *   node --experimental-strip-types scripts/parse/run.ts <client>   # one client
 */

import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseGa4Csv } from "./parseGa4.ts";
import { parseMetaCsv } from "./parseMeta.ts";
import { writeCheckpoint } from "../lib/checkpoint.ts";
import type { DataSources, ParsedDataset, ParsedGa4Row, ParsedMetaRow } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const SAMPLE_DATA_DIR = path.join(REPO_ROOT, "sample-data");
const UPLOADS_DIR = path.join(REPO_ROOT, "backend", "uploads");
const OUTPUT_DIR = path.join(REPO_ROOT, "backend", "output");

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const GA4_FILE = "ga4_export.csv";
const META_FILE = "meta_ads_export.csv";

/**
 * Either export on its own is enough to build a report — see DataSources in
 * ./types.ts. A directory only counts as a client if at least one is present.
 */
async function detectSources(dir: string): Promise<DataSources> {
  const [ga4, meta] = await Promise.all([
    fileExists(path.join(dir, GA4_FILE)),
    fileExists(path.join(dir, META_FILE)),
  ]);
  return { ga4, meta };
}

function hasAnySource(sources: DataSources): boolean {
  return sources.ga4 || sources.meta;
}

/** Resolves a client name to whichever of the two source dirs actually has data. */
async function resolveClientDir(client: string): Promise<{ dir: string; sources: DataSources }> {
  const uploadDir = path.join(UPLOADS_DIR, client);
  const uploadSources = await detectSources(uploadDir);
  if (hasAnySource(uploadSources)) return { dir: uploadDir, sources: uploadSources };

  const sampleDir = path.join(SAMPLE_DATA_DIR, client);
  const sampleSources = await detectSources(sampleDir);
  if (hasAnySource(sampleSources)) return { dir: sampleDir, sources: sampleSources };

  throw new Error(
    `No ${GA4_FILE} or ${META_FILE} found for "${client}" under ` +
      `${UPLOADS_DIR} or ${SAMPLE_DATA_DIR}.`
  );
}

async function listClientDirs(baseDir: string): Promise<string[]> {
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const clients: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (hasAnySource(await detectSources(path.join(baseDir, entry.name)))) clients.push(entry.name);
  }
  return clients;
}

export async function discoverClients(): Promise<string[]> {
  const [uploaded, demo] = await Promise.all([listClientDirs(UPLOADS_DIR), listClientDirs(SAMPLE_DATA_DIR)]);
  return [...new Set([...uploaded, ...demo])].sort();
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function buildGa4TextSummary(client: string, rows: ParsedGa4Row[]): string {
  const dates = rows.map((r) => r.date).sort();
  const channels = [...new Set(rows.map((r) => r.channel))].sort();
  const totalSessions = rows.reduce((sum, r) => sum + r.sessions, 0);
  const totalKeyEvents = rows.reduce((sum, r) => sum + r.keyEvents, 0);
  const totalRevenue = rows.reduce((sum, r) => sum + r.totalRevenue, 0);

  const header = [
    `GA4 export — ${client}`,
    `Step 1 checkpoint: parsed & type-cleaned, not yet normalized (see docs/pipeline-steps.md)`,
    ``,
    `Rows: ${rows.length}`,
    `Date range: ${dates[0]} to ${dates[dates.length - 1]}`,
    `Channels: ${channels.join(", ")}`,
    `Totals: ${totalSessions} sessions, ${totalKeyEvents} key events, $${totalRevenue.toFixed(2)} revenue`,
    ``,
    pad("Date", 12) + pad("Channel", 18) + pad("Sessions", 10) + pad("Engaged", 9) +
      pad("Events", 8) + pad("KeyEv", 7) + pad("Revenue", 10),
    "-".repeat(80),
  ].join("\n");

  const body = rows
    .map((r) =>
      pad(r.date, 12) +
      pad(r.channel, 18) +
      pad(r.sessions, 10) +
      pad(r.engagedSessions, 9) +
      pad(r.eventCount, 8) +
      pad(r.keyEvents, 7) +
      pad(`$${r.totalRevenue.toFixed(2)}`, 10)
    )
    .join("\n");

  return `${header}\n${body}\n`;
}

function buildMetaTextSummary(client: string, rows: ParsedMetaRow[]): string {
  const dates = rows.map((r) => r.reportingStart).sort();
  const campaigns = [...new Set(rows.map((r) => r.campaignName))].sort();
  const totalSpend = rows.reduce((sum, r) => sum + r.amountSpent, 0);
  const totalResults = rows.reduce((sum, r) => sum + r.results, 0);
  const resultTypes = [...new Set(rows.map((r) => r.resultType))];

  const header = [
    `Meta Ads Manager export — ${client}`,
    `Step 1 checkpoint: parsed & type-cleaned, not yet normalized (see docs/pipeline-steps.md)`,
    ``,
    `Rows: ${rows.length}`,
    `Date range: ${dates[0]} to ${dates[dates.length - 1]}`,
    `Campaigns: ${campaigns.join(" | ")}`,
    `Result type(s): ${resultTypes.join(", ")}`,
    `Totals: $${totalSpend.toFixed(2)} spend, ${totalResults} results, ` +
      `${totalResults === 0 ? "n/a" : `$${(totalSpend / totalResults).toFixed(2)}`} blended cost/result`,
    ``,
    pad("Date", 12) + pad("Campaign", 42) + pad("Spend", 10) + pad("Results", 9) +
      pad("Type", 10) + pad("Cost/Result", 12),
    "-".repeat(95),
  ].join("\n");

  const body = rows
    .map((r) =>
      pad(r.reportingStart, 12) +
      pad(r.campaignName.slice(0, 40), 42) +
      pad(`$${r.amountSpent.toFixed(2)}`, 10) +
      pad(r.results, 9) +
      pad(r.resultType, 10) +
      pad(`$${r.costPerResult.toFixed(2)}`, 12)
    )
    .join("\n");

  return `${header}\n${body}\n`;
}

export async function parseClient(client: string): Promise<void> {
  const { dir: clientDir, sources } = await resolveClientDir(client);

  const ga4 = sources.ga4
    ? parseGa4Csv(await readFile(path.join(clientDir, GA4_FILE), "utf-8"), client)
    : [];
  const meta = sources.meta
    ? parseMetaCsv(await readFile(path.join(clientDir, META_FILE), "utf-8"), client)
    : [];

  const dataset: ParsedDataset = {
    client,
    parsedAt: new Date().toISOString(),
    sources,
    ga4,
    meta,
  };

  const outputDir = path.join(OUTPUT_DIR, client);

  // Only the supplied sources get a per-source checkpoint — an empty
  // 01_parsed_meta.txt would read as "Meta returned nothing", which is a very
  // different problem from "this client didn't send a Meta export".
  if (sources.ga4) {
    await writeCheckpoint({
      outputDir,
      stepName: "01_parsed_ga4",
      data: ga4,
      textSummary: buildGa4TextSummary(client, ga4),
    });
  }
  if (sources.meta) {
    await writeCheckpoint({
      outputDir,
      stepName: "01_parsed_meta",
      data: meta,
      textSummary: buildMetaTextSummary(client, meta),
    });
  }

  const supplied = [sources.ga4 ? "GA4" : null, sources.meta ? "Meta" : null].filter(Boolean).join(" + ");
  const { jsonPath } = await writeCheckpoint({
    outputDir,
    stepName: "01_parsed",
    data: dataset,
    textSummary:
      `Combined Step 1 checkpoint for ${client}\n` +
      `Sources supplied: ${supplied}\n` +
      `See 01_parsed_ga4.txt / 01_parsed_meta.txt for per-source detail.\n\n` +
      `GA4 rows: ${sources.ga4 ? ga4.length : "n/a (no GA4 export supplied)"}\n` +
      `Meta rows: ${sources.meta ? meta.length : "n/a (no Meta export supplied)"}\n` +
      `Parsed at: ${dataset.parsedAt}\n`,
  });

  console.log(
    `[parse] ${client}: ${supplied} — ${ga4.length} GA4 rows, ${meta.length} Meta rows -> ${path.dirname(jsonPath)}`
  );
}

async function main(): Promise<void> {
  const requestedClient = process.argv[2];
  const clients = requestedClient ? [requestedClient] : await discoverClients();

  if (clients.length === 0) {
    console.error(
      `No clients found under ${UPLOADS_DIR} or ${SAMPLE_DATA_DIR} ` +
        `(expected ga4_export.csv + meta_ads_export.csv in a subfolder).`
    );
    process.exit(1);
  }

  for (const client of clients) {
    await parseClient(client);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[parse] failed:", err.message ?? err);
    process.exit(1);
  });
}
