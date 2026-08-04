import type { NormalizedMetricRow } from "../normalize/types.ts";
import type { AggregateResult } from "../aggregate/types.ts";
import type { Narrative } from "../narrative/types.ts";
import type { Branding, ChartPoint, ReportRecord } from "./types.ts";

/** Rolls the per-channel/per-campaign normalized rows up into one point per day, for a trend chart. */
export function buildDailyChartSeries(rows: NormalizedMetricRow[]): ChartPoint[] {
  const byDate = new Map<string, ChartPoint>();

  for (const row of rows) {
    const point = byDate.get(row.date) ?? { date: row.date, sessions: 0, spend: 0, results: 0, revenue: 0 };

    if (row.source === "ga4") {
      point.sessions += row.sessions ?? 0;
      point.revenue += row.revenue; // site revenue
    } else {
      point.spend += row.spend;
      point.results += row.results;
    }

    byDate.set(row.date, point);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function assembleReport(params: {
  client: string;
  branding: Branding;
  narrative: Narrative;
  aggregate: AggregateResult;
  normalizedRows: NormalizedMetricRow[];
}): ReportRecord {
  return {
    client: params.client,
    assembledAt: new Date().toISOString(),
    branding: params.branding,
    narrative: params.narrative,
    metrics: params.aggregate,
    chartSeries: buildDailyChartSeries(params.normalizedRows),
  };
}
