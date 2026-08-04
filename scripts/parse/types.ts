/** Output shape of Step 1 (Parse) — see docs/pipeline-steps.md. Cleaned + typed, not yet normalized into one schema. */

export interface ParsedGa4Row {
  date: string; // ISO "2026-05-31", converted from GA4's "20260531"
  channel: string; // "Session default channel group"
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  avgEngagementTimeSeconds: number;
  eventCount: number;
  keyEvents: number;
  totalRevenue: number;
}

export type MetaResultType = "purchase" | "lead";

export interface ParsedMetaRow {
  reportingStart: string; // ISO "2026-05-31"
  reportingEnd: string;
  campaignName: string;
  objective: string;
  deliveryStatus: string;
  attributionSetting: string;
  amountSpent: number;
  impressions: number;
  cpm: number;
  reach: number;
  frequency: number;
  linkClicks: number;
  cpc: number;
  ctr: number;
  results: number;
  resultIndicator: string;
  costPerResult: number;
  resultType: MetaResultType;
  purchaseValue: number | null;
  roas: number | null;
  costPerLead: number | null;
}

/**
 * Which of the two exports this client actually supplied.
 *
 * Both is the richest report, but either one alone is a valid report — a client
 * may only run Meta ads, or may only have analytics. Every downstream step reads
 * this instead of assuming both sides are present, so an absent source produces
 * an omitted section rather than a row of confident zeroes.
 */
export interface DataSources {
  ga4: boolean;
  meta: boolean;
}

export interface ParsedDataset {
  client: string;
  parsedAt: string;
  sources: DataSources;
  ga4: ParsedGa4Row[];
  meta: ParsedMetaRow[];
}
