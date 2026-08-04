import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabase } from "./client.ts";

/**
 * Removes the two shapes that were repeated in every db function:
 *
 *   1. "bail out if Supabase isn't configured" — persistence is optional, so
 *      every write started with the same null guard.
 *   2. "if (error) throw new Error(`Supabase X failed: ...`)" — supabase-js
 *      returns errors in the result rather than rejecting, so each call needed
 *      the same unwrap.
 *
 * `runQuery` does both: skips when disabled, and converts a returned error into
 * a throw naming the operation.
 */

/** Supabase returns `{ data, error }` rather than rejecting — this is that shape. */
type QueryResult<T> = { data: T; error: { message: string } | null };

/**
 * Runs a query when the database is configured.
 * Returns `undefined` when it isn't — callers treat that as "not persisted".
 */
export async function runQuery<T>(
  operation: string,
  fn: (supabase: SupabaseClient) => PromiseLike<QueryResult<T>>
): Promise<T | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;

  const { data, error } = await fn(supabase);
  if (error) throw new Error(`Supabase ${operation} failed: ${error.message}`);
  return data;
}

/**
 * Same, but also skips when the report id is null — the common case for a
 * client that was never registered in the database (e.g. the built-in demo
 * clients, which are generated from the CLI and have no `reports` row).
 */
export async function runScopedQuery<T>(
  operation: string,
  reportId: string | null,
  fn: (supabase: SupabaseClient, reportId: string) => PromiseLike<QueryResult<T>>
): Promise<T | undefined> {
  if (!reportId) return undefined;
  return runQuery(operation, (supabase) => fn(supabase, reportId));
}
