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
  const startedAt = Date.now();
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return {
        state: "disabled",
        reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — running on local checkpoint files only.",
      };
    }

    const { error } = await supabase.from("reports").select("id", { count: "exact", head: true });
    if (error) return { state: "unreachable", reason: error.message };
    return { state: "connected", latencyMs: Date.now() - startedAt };
  } catch (err) {
    // getSupabase() itself can throw synchronously (e.g. a malformed
    // SUPABASE_URL) — that used to escape this function uncaught and reach
    // /health as a generic 500 with no `db` field, which crashed the frontend's
    // health-status render (it trusted `db.state` unconditionally).
    return { state: "unreachable", reason: (err as Error).message };
  }
}
