import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Single place that knows how to reach Supabase.
 *
 * Persistence is OPTIONAL and off unless credentials are present: the pipeline
 * still runs end-to-end on local checkpoint files alone (see backend/README.md).
 * That keeps `npm run pipeline` working for anyone who's just cloned the repo,
 * and means a Supabase outage degrades the tool to "still generates reports,
 * just doesn't record them" instead of taking it down.
 *
 * Uses the SERVICE ROLE key, not the anon key — this runs server-side only and
 * writes to RLS-enabled tables that grant no anon policies (see schema.sql).
 * Never expose this key to the browser or prefix it with NEXT_PUBLIC_.
 */

let cached: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    cached = null;
    return cached;
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return getSupabase() !== null;
}

/** One-line reason persistence is off, for logging. */
export const SUPABASE_DISABLED_REASON =
  "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in backend/.env — running on local checkpoint files only.";
