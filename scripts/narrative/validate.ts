import type { Narrative } from "./types.ts";

/**
 * The model is asked for JSON but nothing guarantees it complied, or that it
 * used the right field names/types. Fail loud here rather than let a
 * malformed narrative silently reach a client report.
 */
export function parseNarrative(rawText: string, providerId: string, expectPacing: boolean): Narrative {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(
      `${providerId}: response was not valid JSON. Got:\n${rawText.slice(0, 500)}`
    );
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj.executiveSummary !== "string" || obj.executiveSummary.trim() === "") {
    errors.push('"executiveSummary" must be a non-empty string');
  }
  if (expectPacing) {
    if (typeof obj.budgetPacingNarrative !== "string" || obj.budgetPacingNarrative.trim() === "") {
      errors.push('"budgetPacingNarrative" must be a non-empty string');
    }
  } else if (obj.budgetPacingNarrative !== undefined) {
    // The brief had no plan to pace against, so anything the model wrote here
    // is invented. Drop it rather than letting a made-up budget claim ship.
    delete obj.budgetPacingNarrative;
  }
  for (const field of ["wins", "concerns", "recommendedActions"] as const) {
    const value = obj[field];
    if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
      errors.push(`"${field}" must be a non-empty array of strings`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `${providerId}: response didn't match the expected Narrative shape:\n- ${errors.join("\n- ")}\n\nGot:\n${JSON.stringify(parsed, null, 2)}`
    );
  }

  return obj as unknown as Narrative;
}
