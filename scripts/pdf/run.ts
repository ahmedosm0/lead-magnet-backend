/**
 * Step 8 (PDF export) — CLI wrapper.
 *
 * The logic lives in api/services/pdfService.ts so the HTTP route and this
 * command share one implementation; this file only handles argv and exit codes.
 *
 * Prerequisite: the frontend must be running (`cd frontend && npm run dev`) —
 * the export drives a real browser against the live report URL rather than
 * rendering a second template, so the PDF can't drift from the web view.
 *
 * Usage:
 *   node --experimental-strip-types scripts/pdf/run.ts            # all clients
 *   node --experimental-strip-types scripts/pdf/run.ts <client>   # one client
 */

import { pathToFileURL } from "node:url";

import { generatePdf } from "../../api/services/pdfService.ts";
import { listClients } from "../../api/services/reportService.ts";

async function main(): Promise<void> {
  const requested = process.argv[2];
  const clients = requested ? [requested] : await listClients();

  if (clients.length === 0) {
    console.error("No assembled reports found. Run the pipeline first (npm run pipeline).");
    process.exit(1);
  }

  for (const client of clients) {
    const pdf = await generatePdf(client);
    console.log(`[pdf] ${client}: ${pdf.length.toLocaleString()} bytes -> output/${client}/08_report.pdf`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[pdf] failed:", err.message ?? err);
    process.exit(1);
  });
}
