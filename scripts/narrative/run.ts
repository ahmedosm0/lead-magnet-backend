/**
 * Step 5 (Narrative) — docs/pipeline-steps.md
 *
 * Reads the 04_brief checkpoint written by Step 4 — the ONLY thing that gets
 * sent to the LLM, never the raw client files — and asks it for a
 * structured narrative: executive summary, wins, concerns, recommended
 * actions, budget pacing. This is the one and only step in the whole
 * pipeline that calls an LLM (see docs/llm-context-strategy.md).
 *
 * Provider is Mistral (mistral-large-latest) today; swapping to Anthropic
 * later is a one-file change in providers/, not a change to this file.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types scripts/narrative/run.ts            # all clients
 *   node --env-file=.env --experimental-strip-types scripts/narrative/run.ts <client>    # one client
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getNarrativeProvider } from "./providers/index.ts";
import { writeCheckpoint } from "../lib/checkpoint.ts";
import { getReportIdBySlug, saveNarrative } from "../../db/reports.ts";
import type { Brief } from "../brief/types.ts";
import type { NarrativeResult } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives at <backend-root>/scripts/narrative/ — two levels down
// from the backend's own root, where output/ actually lives.
const BACKEND_ROOT = path.resolve(__dirname, "../../");
const OUTPUT_DIR = path.join(BACKEND_ROOT, "output");

async function discoverBriefedClients(): Promise<string[]> {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function buildNarrativeTextSummary(result: NarrativeResult): string {
  const { narrative } = result;
  const lines: string[] = [
    `Narrative — ${result.client}`,
    `Step 5 checkpoint: the only step that calls an LLM (see docs/pipeline-steps.md). Provider: ${result.provider}`,
    ``,
    `--- Executive summary ---`,
    narrative.executiveSummary,
    ``,
    `--- Wins ---`,
    ...narrative.wins.map((w) => `- ${w}`),
    ``,
    `--- Concerns ---`,
    ...narrative.concerns.map((c) => `- ${c}`),
    ``,
    `--- Recommended actions ---`,
    ...narrative.recommendedActions.map((a) => `- ${a}`),
    ``,
    `--- Budget pacing ---`,
    narrative.budgetPacingNarrative ?? `(omitted — no approved monthly plan on record for this client)`,
  ];
  return lines.join("\n") + "\n";
}

export async function generateNarrativeForClient(client: string): Promise<void> {
  const outputDir = path.join(OUTPUT_DIR, client);
  const briefPath = path.join(outputDir, "04_brief.json");

  let briefText: string;
  try {
    briefText = await readFile(briefPath, "utf-8");
  } catch {
    throw new Error(
      `${briefPath} not found. Run Step 4 (brief) for "${client}" first: ` + `npm run brief -- ${client}`
    );
  }

  const brief: Brief = JSON.parse(briefText);
  const provider = getNarrativeProvider();
  const narrative = await provider.generateNarrative(brief);

  const result: NarrativeResult = {
    client,
    generatedAt: new Date().toISOString(),
    provider: provider.id,
    narrative,
  };

  const { jsonPath } = await writeCheckpoint({
    outputDir,
    stepName: "05_narrative",
    data: result,
    textSummary: buildNarrativeTextSummary(result),
  });

  // Versioned insert, not an overwrite — see backend/db/reports.ts.
  await saveNarrative(await getReportIdBySlug(client), narrative, provider.id);

  console.log(`[narrative] ${client}: generated via ${provider.id} -> ${jsonPath}`);
}

async function main(): Promise<void> {
  const requestedClient = process.argv[2];
  const clients = requestedClient ? [requestedClient] : await discoverBriefedClients();

  if (clients.length === 0) {
    console.error(`No clients found under ${OUTPUT_DIR}. Run Step 4 (brief) first.`);
    process.exit(1);
  }

  for (const client of clients) {
    await generateNarrativeForClient(client);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[narrative] failed:", err.message ?? err);
    process.exit(1);
  });
}
