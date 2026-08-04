import type { Brief } from "../../brief/types.ts";
import type { Narrative } from "../types.ts";
import type { NarrativeProvider } from "./types.ts";
import { NARRATIVE_SYSTEM_PROMPT, buildUserPrompt } from "../prompt.ts";
import { parseNarrative } from "../validate.ts";

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const MODEL = "mistral-large-latest";

interface MistralChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class MistralProvider implements NarrativeProvider {
  readonly id = `mistral:${MODEL}`;

  async generateNarrative(brief: Brief): Promise<Narrative> {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new Error(
        "MISTRAL_API_KEY is not set. Add it to backend/.env and run with `node --env-file=.env` " +
          "(or `npm run narrative`, which already passes that flag)."
      );
    }

    const response = await fetch(MISTRAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(brief) },
        ],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `${this.id}: request failed with ${response.status} ${response.statusText}. ${bodyText.slice(0, 500)}`
      );
    }

    const data = (await response.json()) as MistralChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${this.id}: response had no message content. Got: ${JSON.stringify(data).slice(0, 500)}`);
    }

    return parseNarrative(content, this.id, brief.pacing !== null);
  }
}
