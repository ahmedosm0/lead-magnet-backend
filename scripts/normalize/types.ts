/** Output shape of Step 2 (Normalize) — see docs/pipeline-steps.md. One shape for both GA4 and Meta rows. */

import type { DataSources } from "../parse/types.ts";

export type { DataSources };

export type MetricSource = "ga4" | "meta";
export type MetricDimension = "channel" | "campaign";
export type ResultType = "purchase" | "lead";

export interface NormalizedMetricRow {
  date: string; // ISO "2026-05-31"
  source: MetricSource;
  dimension: MetricDimension; // "channel" for GA4 rows, "campaign" for Meta rows
  dimensionValue: string;
  sessions: number | null; // GA4 concept only; null for Meta rows
  spend: number; // 0 for GA4 rows (GA4 doesn't carry ad spend)
  results: number; // GA4 key events, or Meta purchases/leads
  resultType: ResultType; // client-level: is a "result" a purchase or a lead for this client
  revenue: number; // GA4's actual site revenue, or Meta's platform-attributed purchase value (0 for leads)
}

export interface NormalizedDataset {
  client: string;
  normalizedAt: string;
  resultType: ResultType;
  /** Carried through from Step 1 — which exports this client actually supplied. */
  sources: DataSources;
  rows: NormalizedMetricRow[];
}
