/**
 * Step 4 (Brief builder) — docs/pipeline-steps.md
 *
 * Reads the 03_aggregates checkpoint written by Step 3 and repackages it
 * into the Brief shape — the ENTIRE payload Step 5 will send to Claude.
 * No new math happens here, only selection/renaming into the exact prompt
 * shape. Writes the 04_brief checkpoint, and reports how small it is
 * relative to the raw parsed input, since staying small regardless of input
 * size is the entire point (docs/llm-context-strategy.md).
 *
 * Usage:
 *   node --experimental-strip-types scripts/brief/run.ts            # all clients
 *   node --experimental-strip-types scripts/brief/run.ts <client>   # one client
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildBrief } from "./buildBrief.ts";
import { writeCheckpoint } from "../lib/checkpoint.ts";
import { getReportIdBySlug, saveBrief } from "../../db/reports.ts";
import type { AggregateResult } from "../aggregate/types.ts";
import type { Brief } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const OUTPUT_DIR = path.join(REPO_ROOT, "backend", "output");

/** Rough token estimate — good enough to prove "this stays small," not a billing figure. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtNullableMoney(n: number | null): string {
  return n === null ? "n/a" : fmtMoney(n);
}

function fmtNullableNumber(n: number | null): string {
  return n === null ? "n/a" : String(n);
}

function fmtPct(n: number | null): string {
  if (n === null) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

async function discoverAggregatedClients(): Promise<string[]> {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function buildBriefTextSummary(brief: Brief, sizeNote: string): string {
  const lines: string[] = [
    `Brief — ${brief.client}`,
    `Step 4 checkpoint: this .txt/.json IS the entire Claude prompt payload for Step 5 (see docs/pipeline-steps.md)`,
    ``,
    sizeNote,
    ``,
    `Period: ${brief.period.start} to ${brief.period.end} (prior: ${brief.priorPeriod.start} to ${brief.priorPeriod.end})`,
    `Result type: ${brief.resultType}`,
    `Sources: ${[brief.sources.ga4 ? "GA4" : null, brief.sources.meta ? "Meta" : null].filter(Boolean).join(" + ")}`,
    ``,
    `--- Totals ---`,
  ];

  if (brief.sources.ga4) {
    lines.push(
      `Sessions:     ${fmtNullableNumber(brief.totals.sessions)}  (${fmtPct(brief.deltas.sessionsPct)} vs prior)`,
      `Site revenue: ${fmtNullableMoney(brief.totals.siteRevenue)}  (${fmtPct(brief.deltas.siteRevenuePct)} vs prior)`
    );
  } else {
    lines.push(`Sessions / site revenue: null in the brief — no GA4 export, so the model is told they're unknown.`);
  }

  if (brief.sources.meta) {
    lines.push(
      `Spend:        ${fmtNullableMoney(brief.totals.spend)}  (${fmtPct(brief.deltas.spendPct)} vs prior)`,
      `Results:      ${fmtNullableNumber(brief.totals.results)}  (${fmtPct(brief.deltas.resultsPct)} vs prior)`,
      `Cost/result:  ${fmtNullableMoney(brief.totals.costPerResult)}  (${fmtPct(brief.deltas.costPerResultPct)} vs prior)`
    );
    if (brief.resultType === "purchase") {
      lines.push(`ROAS:         ${brief.totals.roas?.toFixed(2) ?? "n/a"}x  (${fmtPct(brief.deltas.roasPct)} vs prior)`);
    }
  } else {
    lines.push(`Spend / results / cost-per-result: null in the brief — no Meta export, so the model is told they're unknown.`);
  }

  if (brief.sources.meta) {
    lines.push(
      ``,
      `--- Campaigns ---`,
      pad("Campaign", 44) + pad("Rank", 8) + pad("Trend", 11) + pad("Cost/Result", 12) + pad("Spend", 10),
      "-".repeat(85),
      ...brief.campaigns.map(
        (c) =>
          pad(c.name.slice(0, 42), 44) +
          pad(c.rank, 8) +
          pad(c.trend, 11) +
          pad(fmtNullableMoney(c.costPerResult), 12) +
          pad(fmtMoney(c.spend), 10)
      )
    );
  }

  lines.push(
    ``,
    `--- Pacing ---`,
    brief.pacing === null
      ? `No approved monthly plan on record — pacing omitted from the brief, and the model is told not to write about it.`
      : `${fmtMoney(brief.pacing.actual)} of ${fmtMoney(brief.pacing.plan)} plan (${brief.pacing.pct.toFixed(1)}%) — ${brief.pacing.status}`
  );

  return lines.join("\n") + "\n";
}

export async function buildBriefForClient(client: string): Promise<void> {
  const outputDir = path.join(OUTPUT_DIR, client);
  const aggregatesPath = path.join(outputDir, "03_aggregates.json");

  let aggregatesText: string;
  try {
    aggregatesText = await readFile(aggregatesPath, "utf-8");
  } catch {
    throw new Error(
      `${aggregatesPath} not found. Run Step 3 (aggregate) for "${client}" first: ` +
        `npm run aggregate -- ${client}`
    );
  }

  const aggregate: AggregateResult = JSON.parse(aggregatesText);
  const brief = buildBrief(aggregate);
  const briefJson = JSON.stringify(brief, null, 2);
  const estimatedTokens = estimateTokens(briefJson);

  let sizeNote = `Brief size: ${briefJson.length} chars, ~${estimatedTokens} tokens — this is the full Step 5 prompt payload, and it stays roughly this size no matter how many raw CSV rows the client sends.`;

  const parsedPath = path.join(outputDir, "01_parsed.json");
  try {
    const parsedStat = await stat(parsedPath);
    const shrinkFactor = (parsedStat.size / briefJson.length).toFixed(1);
    sizeNote += `\nFor comparison: 01_parsed.json (raw parsed rows) is ${parsedStat.size} bytes — the brief is ~${shrinkFactor}x smaller.`;
  } catch {
    // 01_parsed.json not present; skip the comparison, not fatal.
  }

  const { jsonPath } = await writeCheckpoint({
    outputDir,
    stepName: "04_brief",
    data: brief,
    textSummary: buildBriefTextSummary(brief, sizeNote),
  });

  await saveBrief(await getReportIdBySlug(client), brief, estimatedTokens);

  console.log(`[brief] ${client}: ~${estimatedTokens} tokens -> ${jsonPath}`);
}

async function main(): Promise<void> {
  const requestedClient = process.argv[2];
  const clients = requestedClient ? [requestedClient] : await discoverAggregatedClients();

  if (clients.length === 0) {
    console.error(`No aggregated clients found under ${OUTPUT_DIR}. Run Step 3 (aggregate) first.`);
    process.exit(1);
  }

  for (const client of clients) {
    await buildBriefForClient(client);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[brief] failed:", err.message ?? err);
    process.exit(1);
  });
}
