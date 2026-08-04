import type { ParsedGa4Row, ParsedMetaRow } from "../parse/types.ts";
import type { NormalizedMetricRow, ResultType } from "./types.ts";

/**
 * GA4 doesn't label a "key event" as a purchase or a lead — that's a
 * client-level fact, not a per-row one. We infer it from the Meta data,
 * which does label every row explicitly.
 *
 * With no Meta export at all, GA4 revenue is the only signal available: a site
 * booking real revenue against its key events is transacting, one booking none
 * is collecting leads. That is a genuine inference from the client's own data,
 * not an invented figure — and it only picks a label, it never produces a
 * number. A Meta export present but empty is still an error, since that means
 * a file was supplied and yielded nothing.
 */
export function inferResultType(meta: ParsedMetaRow[], ga4: ParsedGa4Row[], client: string): ResultType {
  if (meta.length === 0) {
    if (ga4.length === 0) {
      throw new Error(`Cannot infer result type for ${client}: no GA4 rows and no Meta rows`);
    }
    return ga4.some((r) => r.totalRevenue > 0) ? "purchase" : "lead";
  }
  const types = new Set(meta.map((r) => r.resultType));
  if (types.size > 1) {
    throw new Error(
      `${client}: Meta data mixes result types (${[...types].join(", ")}) — ` +
        `the "one resultType per client" assumption in Step 2 doesn't hold, needs per-campaign handling`
    );
  }
  return meta[0].resultType;
}

export function normalizeGa4Rows(rows: ParsedGa4Row[], resultType: ResultType): NormalizedMetricRow[] {
  return rows.map((r) => ({
    date: r.date,
    source: "ga4",
    dimension: "channel",
    dimensionValue: r.channel,
    sessions: r.sessions,
    spend: 0,
    results: r.keyEvents,
    resultType,
    revenue: r.totalRevenue,
  }));
}

export function normalizeMetaRows(rows: ParsedMetaRow[]): NormalizedMetricRow[] {
  return rows.map((r) => ({
    date: r.reportingStart,
    source: "meta",
    dimension: "campaign",
    dimensionValue: r.campaignName,
    sessions: null,
    spend: r.amountSpent,
    results: r.results,
    resultType: r.resultType,
    revenue: r.resultType === "purchase" ? r.purchaseValue ?? 0 : 0,
  }));
}
