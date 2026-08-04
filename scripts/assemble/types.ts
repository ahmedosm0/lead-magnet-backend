import type { AggregateResult } from "../aggregate/types.ts";
import type { Narrative } from "../narrative/types.ts";

/**
 * White-label branding for whichever client/agency the report is being
 * generated for — THEIR brand, never TE's, per docs/project.md.
 *
 * For uploaded clients this is derived from their live website at upload time
 * (logo downloaded to frontend/public/branding/<client>/, colors sampled from
 * the rendered page) and written to backend/uploads/<client>/branding.json.
 * The two demo clients still use the hardcoded kits in branding.ts.
 *
 * logoPath is a local, already-downloaded asset path served by the frontend —
 * never a hotlinked remote URL, so reports don't break when a site changes.
 */
export interface Branding {
  agencySlug: string;
  agencyName: string;
  logoPath: string | null;
  primaryColor: string; // hex
  secondaryColor: string; // hex
  /** Present when branding was derived from a real site rather than a preset kit. */
  siteUrl?: string;
}

export interface ChartPoint {
  date: string; // ISO
  sessions: number;
  spend: number;
  results: number;
  revenue: number;
}

/**
 * The complete, self-contained thing Steps 7 (web render) and 8 (PDF) will
 * consume. Everything a report needs to be drawn lives in this one object —
 * numbers (from Step 3), narrative (from Step 5), a day-by-day series for
 * charts (rolled up from Step 2's normalized rows), and branding.
 */
export interface ReportRecord {
  client: string;
  assembledAt: string;
  branding: Branding;
  narrative: Narrative;
  metrics: AggregateResult;
  chartSeries: ChartPoint[];
}
