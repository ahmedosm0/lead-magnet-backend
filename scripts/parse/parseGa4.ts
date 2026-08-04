import { parseCsv, requireField, requireNumber } from "../lib/csv.ts";
import type { ParsedGa4Row } from "./types.ts";

/** "20260531" -> "2026-05-31" */
function toIsoDate(ga4Date: string, context: string): string {
  if (!/^\d{8}$/.test(ga4Date)) {
    throw new Error(`GA4 date "${ga4Date}" in ${context} is not in YYYYMMDD format`);
  }
  return `${ga4Date.slice(0, 4)}-${ga4Date.slice(4, 6)}-${ga4Date.slice(6, 8)}`;
}

export function parseGa4Csv(csvText: string, client: string): ParsedGa4Row[] {
  const context = `${client} GA4 export`;
  const records = parseCsv(csvText);

  return records.map((record, index) => {
    const rowContext = `${context} (row ${index + 2})`; // +2: 1-indexed + header row
    return {
      date: toIsoDate(requireField(record, "Date", rowContext), rowContext),
      channel: requireField(record, "Session default channel group", rowContext),
      sessions: requireNumber(record, "Sessions", rowContext),
      engagedSessions: requireNumber(record, "Engaged sessions", rowContext),
      engagementRate: requireNumber(record, "Engagement rate", rowContext),
      avgEngagementTimeSeconds: requireNumber(record, "Average engagement time per session", rowContext),
      eventCount: requireNumber(record, "Event count", rowContext),
      keyEvents: requireNumber(record, "Key events", rowContext),
      totalRevenue: requireNumber(record, "Total revenue", rowContext),
    };
  });
}
