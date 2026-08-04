import type { NormalizedMetricRow } from "../normalize/types.ts";

export interface PeriodRange {
  start: string; // ISO, inclusive
  end: string; // ISO, inclusive
}

function parseIso(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = parseIso(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/**
 * Splits the data's date range into two back-to-back 30-day windows —
 * "current period" (most recent 30 days present) and "prior period" (the
 * 30 days before that) — so Step 3 can compute period-over-period deltas.
 */
export function computePeriods(rows: NormalizedMetricRow[]): { current: PeriodRange; prior: PeriodRange } {
  if (rows.length === 0) {
    throw new Error("Cannot compute periods: no normalized rows");
  }

  const currentEnd = rows.map((r) => r.date).sort().at(-1)!;
  const currentStart = addDays(currentEnd, -29);
  const priorEnd = addDays(currentStart, -1);
  const priorStart = addDays(priorEnd, -29);

  return {
    current: { start: currentStart, end: currentEnd },
    prior: { start: priorStart, end: priorEnd },
  };
}

export function filterByPeriod(rows: NormalizedMetricRow[], period: PeriodRange): NormalizedMetricRow[] {
  return rows.filter((r) => r.date >= period.start && r.date <= period.end);
}
