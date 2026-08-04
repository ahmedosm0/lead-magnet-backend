import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UpstreamError } from "../core/errors.ts";
import { nonFatal, rethrowAs } from "../core/catchAsync.ts";
import { withBrowser } from "../../lib/browser.ts";
import { getReport } from "./reportService.ts";
import { getReportIdBySlug, saveRender } from "../../db/reports.ts";

const OUTPUT_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../output");
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

/**
 * Step 8 — prints the live Step 7 web view to PDF.
 *
 * Deliberately drives a real browser against the real URL rather than
 * rendering a second template, so the PDF cannot drift from what a client sees
 * on the link. That means the frontend must be running; when it isn't, this is
 * an upstream failure with a fix-it message, not a 500.
 */
export async function generatePdf(client: string): Promise<Buffer> {
  // 404s early (and consistently with the rest of the API) if there's no report.
  await getReport(client);

  const url = `${FRONTEND_URL}/reports/${client}`;

  const pdfBuffer = await withBrowser(async (browser) => {
    const page = await browser.newPage();

    // /reports/<client> is deliberately public (see frontend/src/proxy.ts and
    // api/core/app.ts) — this headless browser needs no session for the same
    // reason a prospect clicking the shared link needs none.
    await rethrowAs(
      () => page.goto(url, { waitUntil: "networkidle", timeout: 20_000 }),
      (cause) =>
        new UpstreamError(
          `Could not reach ${url}. Is the frontend running (cd frontend && npm run dev)?`,
          { url },
          cause
        )
    );

    await page.waitForSelector('[data-report-ready="true"]', { timeout: 10_000 });
    // Reports must print identically regardless of the machine's colour scheme.
    await page.emulateMedia({ media: "print", colorScheme: "light" });

    return page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "24px", bottom: "24px", left: "0px", right: "0px" },
    });
  });

  // Keep the on-disk artifact too — it's the Step 8 checkpoint.
  const outputDir = path.join(OUTPUT_DIR, client);
  await mkdir(outputDir, { recursive: true });
  const pdfPath = path.join(outputDir, "08_report.pdf");
  await writeFile(pdfPath, pdfBuffer);

  await nonFatal(saveRender(await getReportIdBySlug(client), { webViewUrl: url, pdfUrl: pdfPath }), "record pdf render");

  return pdfBuffer;
}
