import type { DataSources, ResultType } from "../normalize/types.ts";
import type { PacingStatus } from "../aggregate/types.ts";

export type CampaignRank = "best" | "middle" | "worst";
export type CampaignTrend = "improving" | "worsening" | "flat" | "new";

export interface BriefCampaign {
  name: string;
  spend: number;
  results: number;
  costPerResult: number | null;
  revenue: number;
  roas: number | null;
  rank: CampaignRank;
  trend: CampaignTrend; // vs. the prior period, by cost/result
}

/**
 * The ENTIRE payload that will ever be sent to Claude for the narrative pass
 * (Step 5). Nothing else — no raw rows, no full row-by-row history. Its size
 * is designed to stay roughly constant regardless of how much raw data came
 * in upstream. See docs/llm-context-strategy.md.
 */
export interface Brief {
  client: string;
  resultType: ResultType;
  period: { start: string; end: string };
  priorPeriod: { start: string; end: string };
  /**
   * Which exports the client supplied. Every figure belonging to an absent
   * source is null below rather than 0, so the model cannot read "we weren't
   * given this" as "this was zero" — the same reasoning as `pacing`.
   */
  sources: DataSources;
  totals: {
    sessions: number | null;
    spend: number | null;
    results: number | null;
    costPerResult: number | null;
    siteRevenue: number | null;
    roas: number | null;
  };
  deltas: {
    spendPct: number | null;
    resultsPct: number | null;
    costPerResultPct: number | null;
    sessionsPct: number | null;
    siteRevenuePct: number | null;
    roasPct: number | null;
  };
  campaigns: BriefCampaign[];
  /** Null when no approved monthly plan exists — the model is then told not to write about pacing at all. */
  pacing: {
    plan: number;
    actual: number;
    pct: number;
    status: PacingStatus;
  } | null;
}
