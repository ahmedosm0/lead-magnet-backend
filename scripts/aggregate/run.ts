/**
 * Step 3 (Aggregate) — docs/pipeline-steps.md
 *
 * Reads the 02_normalized checkpoint written by Step 2 (does NOT re-parse or
 * re-normalize) and computes everything a human analyst would compute with a
 * calculator: period totals, period-over-period deltas, campaign rankings by
 * cost-per-result, and spend pacing vs. the approved monthly plan. No LLM
 * involved in this step at all — see docs/llm-context-strategy.md for why
 * that matters. Writes the 03_aggregates checkpoint.
 *
 * Usage:
 *   node --experimental-strip-types scripts/aggregate/run.ts            # all clients
 *   node --experimental-strip-types scripts/aggregate/run.ts <client>   # one client
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeCampaignRollup, computeDeltas, computePacing, computePeriodTotals } from "./aggregate.ts";
import { computePeriods } from "./period.ts";
import { getMonthlyPlan } from "./clientPlans.ts";
import { writeCheckpoint } from "../lib/checkpoint.ts";
import { getReportIdBySlug, saveAggregates } from "../../db/reports.ts";
import type { NormalizedDataset } from "../normalize/types.ts";
import type { AggregateResult } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const OUTPUT_DIR = path.join(REPO_ROOT, "backend", "output");

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtNullableMoney(n: number | null): string {
  return n === null ? "n/a" : fmtMoney(n);
}

async function discoverNormalizedClients(): Promise<string[]> {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function buildAggregateTextSummary(client: string, result: AggregateResult): string {
  const { currentPeriod, priorPeriod, deltas, campaigns, pacing, sources } = result;

  const supplied = [sources.ga4 ? "GA4" : null, sources.meta ? "Meta" : null].filter(Boolean).join(" + ");

  const lines: string[] = [
    `Aggregates — ${client}`,
    `Step 3 checkpoint: deterministic totals/deltas/rankings/pacing, no LLM involved (see docs/pipeline-steps.md)`,
    `Client-level result type: ${result.resultType}`,
    `Sources supplied: ${supplied}`,
    ``,
    `Current period: ${currentPeriod.period.start} to ${currentPeriod.period.end}`,
    `Prior period:   ${priorPeriod.period.start} to ${priorPeriod.period.end}`,
    ``,
    `--- Totals (current vs. prior) ---`,
  ];

  if (sources.ga4) {
    lines.push(
      `Sessions:        ${currentPeriod.sessions} vs ${priorPeriod.sessions}  (${fmtPct(deltas.sessionsPct)})`,
      `GA4 key events:  ${currentPeriod.ga4KeyEvents} vs ${priorPeriod.ga4KeyEvents}`,
      `Site revenue:    ${fmtMoney(currentPeriod.siteRevenue)} vs ${fmtMoney(priorPeriod.siteRevenue)}  (${fmtPct(deltas.siteRevenuePct)})`
    );
  } else {
    lines.push(`Sessions / site revenue: no GA4 export supplied — omitted rather than reported as 0.`);
  }

  if (sources.meta) {
    lines.push(
      `Meta spend:      ${fmtMoney(currentPeriod.spend)} vs ${fmtMoney(priorPeriod.spend)}  (${fmtPct(deltas.spendPct)})`,
      `Meta results:    ${currentPeriod.metaResults} vs ${priorPeriod.metaResults}  (${fmtPct(deltas.metaResultsPct)})`,
      `Cost/result:     ${fmtNullableMoney(currentPeriod.costPerResult)} vs ${fmtNullableMoney(priorPeriod.costPerResult)}  (${fmtPct(deltas.costPerResultPct)})`
    );
    if (result.resultType === "purchase") {
      lines.push(
        `ROAS:            ${currentPeriod.roas?.toFixed(2) ?? "n/a"}x vs ${priorPeriod.roas?.toFixed(2) ?? "n/a"}x  (${fmtPct(deltas.roasPct)})`
      );
    }
  } else {
    lines.push(`Spend / results / cost-per-result: no Meta export supplied — omitted rather than reported as 0.`);
  }

  if (sources.meta) {
    const campaignRow = (c: (typeof campaigns)[number]) =>
      pad(c.campaign.slice(0, 42), 44) +
      pad(fmtMoney(c.spend), 10) +
      pad(c.results, 9) +
      pad(fmtNullableMoney(c.costPerResult), 12) +
      pad(fmtMoney(c.revenue), 10);

    lines.push(
      ``,
      `--- Campaigns, current period, ranked best to worst by cost/result ---`,
      pad("Campaign", 44) + pad("Spend", 10) + pad("Results", 9) + pad("Cost/Result", 12) + pad("Revenue", 10),
      "-".repeat(85),
      ...campaigns.map(campaignRow),
      ``,
      `--- Same campaigns, prior period (for trend comparison in Step 4) ---`,
      ...result.priorCampaigns.map(campaignRow)
    );
  }

  lines.push(``, `--- Budget pacing (current period vs. approved monthly plan) ---`);
  if (pacing === null) {
    lines.push(
      sources.meta
        ? `No approved monthly plan on record for this client — pacing omitted.`
        : `No Meta export supplied, so there is no spend figure to pace — pacing omitted.`,
      `(Deliberate: a plan number has to come from outside the data. See clientPlans.ts.)`
    );
  } else {
    lines.push(
      `Plan:   ${fmtMoney(pacing.plan)}`,
      `Actual: ${fmtMoney(pacing.actual)}`,
      `Pacing: ${pacing.pct.toFixed(1)}% of plan — ${pacing.status}`
    );
  }

  return lines.join("\n") + "\n";
}

export async function aggregateClient(client: string): Promise<void> {
  const outputDir = path.join(OUTPUT_DIR, client);
  const normalizedPath = path.join(outputDir, "02_normalized.json");

  let normalizedText: string;
  try {
    normalizedText = await readFile(normalizedPath, "utf-8");
  } catch {
    throw new Error(
      `${normalizedPath} not found. Run Step 2 (normalize) for "${client}" first: ` + `npm run normalize -- ${client}`
    );
  }

  const normalized: NormalizedDataset = JSON.parse(normalizedText);
  const { rows, resultType } = normalized;
  const sources = normalized.sources ?? {
    ga4: rows.some((r) => r.source === "ga4"),
    meta: rows.some((r) => r.source === "meta"),
  };

  const { current, prior } = computePeriods(rows);
  const currentPeriod = computePeriodTotals(rows, current, resultType);
  const priorPeriod = computePeriodTotals(rows, prior, resultType);
  const deltas = computeDeltas(currentPeriod, priorPeriod);
  const campaigns = computeCampaignRollup(rows, current);
  const priorCampaigns = computeCampaignRollup(rows, prior);
  // No Meta export means no spend figure at all — pacing a known plan against a
  // structural 0 would report "0% of budget spent", which is a claim about the
  // client's account we have no data for.
  const pacing = sources.meta ? computePacing(currentPeriod.spend, getMonthlyPlan(client)) : null;

  const result: AggregateResult = {
    client,
    aggregatedAt: new Date().toISOString(),
    resultType,
    sources,
    currentPeriod,
    priorPeriod,
    deltas,
    campaigns,
    priorCampaigns,
    pacing,
  };

  const { jsonPath } = await writeCheckpoint({
    outputDir,
    stepName: "03_aggregates",
    data: result,
    textSummary: buildAggregateTextSummary(client, result),
  });

  await saveAggregates(await getReportIdBySlug(client), result);

  const pacingLabel = pacing === null ? "pacing n/a" : `pacing ${pacing.pct.toFixed(0)}% (${pacing.status})`;
  const totalsLabel = sources.meta
    ? `${fmtMoney(currentPeriod.spend)} spend, ${currentPeriod.metaResults} results`
    : `${currentPeriod.sessions} sessions (GA4 only)`;
  console.log(`[aggregate] ${client}: ${totalsLabel}, ${pacingLabel} -> ${jsonPath}`);
}

async function main(): Promise<void> {
  const requestedClient = process.argv[2];
  const clients = requestedClient ? [requestedClient] : await discoverNormalizedClients();

  if (clients.length === 0) {
    console.error(`No normalized clients found under ${OUTPUT_DIR}. Run Step 2 (normalize) first.`);
    process.exit(1);
  }

  for (const client of clients) {
    await aggregateClient(client);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[aggregate] failed:", err.message ?? err);
    process.exit(1);
  });
}
