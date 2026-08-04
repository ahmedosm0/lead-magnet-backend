import type { NarrativeProvider } from "./types.ts";
import { MistralProvider } from "./mistral.ts";

/**
 * Single place that decides which LLM backs the narrative step.
 * Today: Mistral (mistral-large-latest). Once an Anthropic key is
 * provided, add `backend/scripts/narrative/providers/anthropic.ts`
 * implementing NarrativeProvider and a case below — nothing else in
 * the pipeline needs to change.
 */
export function getNarrativeProvider(): NarrativeProvider {
  const requested = (process.env.LLM_PROVIDER ?? "mistral").toLowerCase();

  switch (requested) {
    case "mistral":
      return new MistralProvider();
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${requested}". Supported: mistral. ` +
          `(Set LLM_PROVIDER=anthropic once backend/scripts/narrative/providers/anthropic.ts exists.)`
      );
  }
}
