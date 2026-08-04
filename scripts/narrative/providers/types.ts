import type { Brief } from "../../brief/types.ts";
import type { Narrative } from "../types.ts";

/**
 * Every LLM provider the narrative step can call implements this one method.
 * The pipeline is written against this interface, not against any one
 * vendor's SDK — swapping the provider (e.g. Mistral now, Anthropic once a
 * key is provided) means adding one new file under providers/, not touching
 * prompt.ts, run.ts, or the Narrative shape.
 */
export interface NarrativeProvider {
  /** e.g. "mistral:mistral-large-latest" — recorded on the checkpoint for traceability. */
  readonly id: string;
  generateNarrative(brief: Brief): Promise<Narrative>;
}
