/**
 * Monthly Meta spend plan per client, used for budget pacing (Step 3).
 *
 * This is deliberately NOT derived from the data itself — pacing means
 * "spend vs. what was approved," and a plan number always comes from an
 * external source (the account's agreed monthly budget, e.g. an ops record
 * in Supabase in the real product). For the demo dataset these match the
 * figures already documented in each client's client-profile.md.
 */
export const CLIENT_MONTHLY_PLANS: Record<string, number> = {
  "ecommerce-solstice-skincare": 8500,
  "leadgen-crestline-roofing": 4900,
};

/**
 * Returns null when no approved plan is known for this client — which is the
 * normal case for anything uploaded through the frontend, since the upload
 * form deliberately doesn't ask for a budget.
 *
 * Null means "omit the pacing section," NOT "guess a plan." A plan inferred
 * from the client's own spend would make pacing tautological (always ~100%)
 * and would present a fabricated number as an agreed budget, so the report
 * simply leaves pacing out rather than inventing it. A plan can still be
 * supplied out-of-band via MONTHLY_PLAN_OVERRIDE, and the two demo clients
 * keep their documented figures above.
 */
export function getMonthlyPlan(client: string): number | null {
  const plan = CLIENT_MONTHLY_PLANS[client];
  if (plan !== undefined) return plan;

  const override = process.env.MONTHLY_PLAN_OVERRIDE;
  if (override !== undefined && override !== "") {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    throw new Error(`MONTHLY_PLAN_OVERRIDE="${override}" is not a valid positive number.`);
  }

  return null;
}
