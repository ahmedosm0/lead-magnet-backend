import type { NormalizedMetricRow, ResultType } from "../normalize/types.ts";
import { filterByPeriod, type PeriodRange } from "./period.ts";
import type { CampaignRollup, PacingStatus, Pacing, PeriodDeltas, PeriodTotals } from "./types.ts";

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function safeDivide(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Percent change from `prior` to `current`. Null if there's no prior baseline to compare against. */
function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

export function computePeriodTotals(
  rows: NormalizedMetricRow[],
  period: PeriodRange,
  resultType: ResultType
): PeriodTotals {
  const periodRows = filterByPeriod(rows, period);
  const ga4Rows = periodRows.filter((r) => r.source === "ga4");
  const metaRows = periodRows.filter((r) => r.source === "meta");

  const sessions = sum(ga4Rows.map((r) => r.sessions ?? 0));
  const ga4KeyEvents = sum(ga4Rows.map((r) => r.results));
  const siteRevenue = sum(ga4Rows.map((r) => r.revenue));
  const spend = sum(metaRows.map((r) => r.spend));
  const metaResults = sum(metaRows.map((r) => r.results));
  const metaRevenue = sum(metaRows.map((r) => r.revenue));

  return {
    period,
    sessions,
    ga4KeyEvents,
    siteRevenue,
    spend,
    metaResults,
    metaRevenue,
    costPerResult: safeDivide(spend, metaResults),
    roas: resultType === "purchase" ? safeDivide(metaRevenue, spend) : null,
  };
}

export function computeDeltas(current: PeriodTotals, prior: PeriodTotals): PeriodDeltas {
  return {
    spendPct: pctChange(current.spend, prior.spend),
    metaResultsPct: pctChange(current.metaResults, prior.metaResults),
    costPerResultPct:
      current.costPerResult !== null && prior.costPerResult !== null
        ? pctChange(current.costPerResult, prior.costPerResult)
        : null,
    sessionsPct: pctChange(current.sessions, prior.sessions),
    siteRevenuePct: pctChange(current.siteRevenue, prior.siteRevenue),
    roasPct: current.roas !== null && prior.roas !== null ? pctChange(current.roas, prior.roas) : null,
  };
}

/** Per-campaign spend/results rollup for the current period, ranked best (lowest cost/result) to worst. */
export function computeCampaignRollup(rows: NormalizedMetricRow[], period: PeriodRange): CampaignRollup[] {
  const metaRows = filterByPeriod(rows, period).filter((r) => r.source === "meta");
  const byCampaign = new Map<string, NormalizedMetricRow[]>();

  for (const row of metaRows) {
    const existing = byCampaign.get(row.dimensionValue) ?? [];
    existing.push(row);
    byCampaign.set(row.dimensionValue, existing);
  }

  const rollups: CampaignRollup[] = [...byCampaign.entries()].map(([campaign, campaignRows]) => {
    const spend = sum(campaignRows.map((r) => r.spend));
    const results = sum(campaignRows.map((r) => r.results));
    const revenue = sum(campaignRows.map((r) => r.revenue));
    return {
      campaign,
      spend,
      results,
      costPerResult: safeDivide(spend, results),
      revenue,
      roas: revenue > 0 ? safeDivide(revenue, spend) : null,
    };
  });

  return rollups.sort((a, b) => {
    if (a.costPerResult === null) return 1;
    if (b.costPerResult === null) return -1;
    return a.costPerResult - b.costPerResult;
  });
}

/** Null plan (no approved budget on record) yields null pacing — see clientPlans.ts. */
export function computePacing(actualSpend: number, monthlyPlan: number | null): Pacing | null {
  if (monthlyPlan === null) return null;

  const pct = (actualSpend / monthlyPlan) * 100;
  let status: PacingStatus;
  if (pct < 90) status = "under";
  else if (pct > 110) status = "over";
  else status = "on_track";

  return { plan: monthlyPlan, actual: actualSpend, pct, status };
}
