/**
 * Pipeline CLI — runs the Sample Report Generator data pipeline end to
 * end for one or all demo clients. See docs/pipeline-steps.md for what each
 * step does and why it writes a checkpoint file before the next one runs.
 *
 * Usage (from backend/):
 *   node --experimental-strip-types scripts/cli.ts             # all clients
 *   node --experimental-strip-types scripts/cli.ts <client>    # one client
 *   npm run pipeline
 *   npm run pipeline -- <client>
 *
 * Each step also runs standalone (npm run parse, npm run normalize, ...) so
 * a single step can be re-run against its checkpoint input without
 * re-running everything before it.
 */

import { discoverClients, parseClient } from "./parse/run.ts";
import { normalizeClient } from "./normalize/run.ts";
import { aggregateClient } from "./aggregate/run.ts";
import { buildBriefForClient } from "./brief/run.ts";
import { generateNarrativeForClient } from "./narrative/run.ts";
import { assembleClient } from "./assemble/run.ts";

const STEPS: Array<{ name: string; run: (client: string) => Promise<void> }> = [
  { name: "parse", run: parseClient },
  { name: "normalize", run: normalizeClient },
  { name: "aggregate", run: aggregateClient },
  { name: "brief", run: buildBriefForClient },
  { name: "narrative", run: generateNarrativeForClient },
  { name: "assemble", run: assembleClient },
];

async function runPipelineForClient(client: string): Promise<void> {
  console.log(`\n=== ${client} ===`);
  for (const step of STEPS) {
    await step.run(client);
  }
}

async function main(): Promise<void> {
  const requestedClient = process.argv[2];
  const clients = requestedClient ? [requestedClient] : await discoverClients();

  if (clients.length === 0) {
    console.error("No clients found under sample-data/.");
    process.exit(1);
  }

  for (const client of clients) {
    await runPipelineForClient(client);
  }

  console.log(`\nDone. Checkpoint files are under output/<client>/.`);
}

main().catch((err) => {
  console.error("[pipeline] failed:", err.message ?? err);
  process.exit(1);
});
