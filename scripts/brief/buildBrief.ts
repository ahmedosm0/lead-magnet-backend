import type { AggregateResult, CampaignRollup } from "../aggregate/types.ts";
import type { Brief, BriefCampaign, CampaignRank, CampaignTrend } from "./types.ts";

const TREND_THRESHOLD_PCT = 5; // below this, call it "flat" rather than reading noise as a trend

function rankOf(index: number, total: number): CampaignRank {
  if (index === 0) return "best";
  if (index === total - 1) return "worst";
  return "middle";
}

function trendOf(current: CampaignRollup, prior: CampaignRollup | undefined): CampaignTrend {
  if (!prior) return "new";
  if (current.costPerResult === null || prior.costPerResult === null) return "flat";
  if (prior.costPerResult === 0) return "flat";

  const pctChange = ((current.costPerResult - prior.costPerResult) / prior.costPerResult) * 100;
  if (pctChange <= -TREND_THRESHOLD_PCT) return "improving"; // cost/result went down
  if (pctChange >= TREND_THRESHOLD_PCT) return "worsening"; // cost/result went up
  return "flat";
}

function buildBriefCampaigns(current: CampaignRollup[], prior: CampaignRollup[]): BriefCampaign[] {
  const priorByName = new Map(prior.map((c) => [c.campaign, c]));

  return current.map((c, index) => ({
    name: c.campaign,
    spend: c.spend,
    results: c.results,
    costPerResult: c.costPerResult,
    revenue: c.revenue,
    roas: c.roas,
    rank: rankOf(index, current.length),
    trend: trendOf(c, priorByName.get(c.campaign)),
  }));
}

export function buildBrief(aggregate: AggregateResult): Brief {
  // Sources absent from the upload are nulled out, not passed through as the 0
  // the arithmetic produced. Telling the model "spend: 0, results: 0" invites a
  // confident sentence about a campaign that was never in the data.
  const { ga4, meta } = aggregate.sources;
  const onlyIf = <T,>(present: boolean, value: T): T | null => (present ? value : null);

  return {
    client: aggregate.client,
    resultType: aggregate.resultType,
    period: aggregate.currentPeriod.period,
    priorPeriod: aggregate.priorPeriod.period,
    sources: aggregate.sources,
    totals: {
      sessions: onlyIf(ga4, aggregate.currentPeriod.sessions),
      siteRevenue: onlyIf(ga4, aggregate.currentPeriod.siteRevenue),
      spend: onlyIf(meta, aggregate.currentPeriod.spend),
      results: onlyIf(meta, aggregate.currentPeriod.metaResults),
      costPerResult: onlyIf(meta, aggregate.currentPeriod.costPerResult),
      roas: onlyIf(meta, aggregate.currentPeriod.roas),
    },
    deltas: {
      sessionsPct: onlyIf(ga4, aggregate.deltas.sessionsPct),
      siteRevenuePct: onlyIf(ga4, aggregate.deltas.siteRevenuePct),
      spendPct: onlyIf(meta, aggregate.deltas.spendPct),
      resultsPct: onlyIf(meta, aggregate.deltas.metaResultsPct),
      costPerResultPct: onlyIf(meta, aggregate.deltas.costPerResultPct),
      roasPct: onlyIf(meta, aggregate.deltas.roasPct),
    },
    campaigns: meta ? buildBriefCampaigns(aggregate.campaigns, aggregate.priorCampaigns) : [],
    pacing: aggregate.pacing,
  };
}
