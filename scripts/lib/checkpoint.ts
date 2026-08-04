import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a pipeline checkpoint as both machine-readable JSON and a
 * human-readable .txt summary, per docs/pipeline-steps.md — every step
 * writes a file someone can open and eyeball before the next step runs.
 */
export async function writeCheckpoint(options: {
  outputDir: string;
  stepName: string; // e.g. "01_parsed"
  data: unknown;
  textSummary: string;
}): Promise<{ jsonPath: string; txtPath: string }> {
  await mkdir(options.outputDir, { recursive: true });

  const jsonPath = path.join(options.outputDir, `${options.stepName}.json`);
  const txtPath = path.join(options.outputDir, `${options.stepName}.txt`);

  await writeFile(jsonPath, JSON.stringify(options.data, null, 2), "utf-8");
  await writeFile(txtPath, options.textSummary, "utf-8");

  return { jsonPath, txtPath };
}
