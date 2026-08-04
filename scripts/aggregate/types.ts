import type { DataSources, ResultType } from "../normalize/types.ts";
import type { PeriodRange } from "./period.ts";

export interface PeriodTotals {
  period: PeriodRange;
  sessions: number; // GA4, all channels
  ga4KeyEvents: number; // GA4, all channels
  siteRevenue: number; // GA4, all channels
  spend: number; // Meta, paid campaigns only
  metaResults: number; // Meta, paid campaigns only
  metaRevenue: number; // Meta, platform-attributed
  costPerResult: number | null; // spend / metaResults
  roas: number | null; // metaRevenue / spend, purchase clients only
}

export interface CampaignRollup {
  campaign: string;
  spend: number;
  results: number;
  costPerResult: number | null;
  revenue: number;
  roas: number | null;
}

export interface PeriodDeltas {
  spendPct: number | null;
  metaResultsPct: number | null;
  costPerResultPct: number | null;
  sessionsPct: number | null;
  siteRevenuePct: number | null;
  roasPct: number | null;
}

export type PacingStatus = "under" | "on_track" | "over";

export interface Pacing {
  plan: number;
  actual: number;
  pct: number;
  status: PacingStatus;
}

export interface AggregateResult {
  client: string;
  aggregatedAt: string;
  resultType: ResultType;
  /**
   * Which exports backed these numbers. Totals for an absent source compute to
   * 0 arithmetically; consumers must read this to tell "$0 spent" apart from
   * "we were never told about spend".
   */
  sources: DataSources;
  currentPeriod: PeriodTotals;
  priorPeriod: PeriodTotals;
  deltas: PeriodDeltas;
  campaigns: CampaignRollup[]; // ranked best (lowest cost/result) to worst, current period
  priorCampaigns: CampaignRollup[]; // same ranking, prior period — lets Step 4 compute per-campaign trend
  /** Null when no approved monthly plan is known — the report omits pacing rather than inventing a budget. */
  pacing: Pacing | null;
}
