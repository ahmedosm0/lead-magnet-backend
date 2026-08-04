import { getSupabase } from "./client.ts";

export type DbHealth =
  | { state: "disabled"; reason: string }
  | { state: "connected"; latencyMs: number }
  | { state: "unreachable"; reason: string };

/**
 * Round-trips a trivial query so the server can report — at startup and via
 * /health — whether the database is actually usable, rather than discovering it
 * on the first upload. A `head: true` count reads no rows but still exercises
 * auth, network, and RLS.
 */
export async function checkDbHealth(): Promise<DbHealth> {
  const supabase = getSupabase();
  if (!supabase) {
    return {
      state: "disabled",
      reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — running on local checkpoint files only.",
    };
  }

  const startedAt = Date.now();
  try {
    const { error } = await supabase.from("reports").select("id", { count: "exact", head: true });
    if (error) return { state: "unreachable", reason: error.message };
    return { state: "connected", latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { state: "unreachable", reason: (err as Error).message };
  }
}
