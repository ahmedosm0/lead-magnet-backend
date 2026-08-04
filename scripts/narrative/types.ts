/** Output shape of Step 5 (Narrative) — see docs/pipeline-steps.md. The only step in the pipeline that calls an LLM. */
export interface Narrative {
  executiveSummary: string;
  wins: string[];
  concerns: string[];
  recommendedActions: string[];
  /** Absent when the brief had no pacing data (no approved monthly plan on record). */
  budgetPacingNarrative?: string;
}

export interface NarrativeResult {
  client: string;
  generatedAt: string;
  provider: string; // e.g. "mistral:mistral-large-latest"
  narrative: Narrative;
}
