import { chromium, type Browser } from "playwright-core";

/**
 * Single place that knows how to get a headless browser. Two things need one:
 * brand extraction (reading a client's site) and PDF export (printing our own
 * report page).
 *
 * Uses the Edge install that already exists on Windows via Playwright's
 * "channel" option instead of downloading a bundled Chromium — that keeps
 * playwright-core the only browser dependency.
 */
const EDGE_FALLBACK_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "msedge", headless: true });
  } catch (channelError) {
    for (const executablePath of EDGE_FALLBACK_PATHS) {
      try {
        return await chromium.launch({ executablePath, headless: true });
      } catch {
        // try the next known path
      }
    }
    throw new Error(
      `Could not launch Edge via Playwright's "msedge" channel, and none of the fallback install ` +
        `paths worked either. Original error: ${(channelError as Error).message}`
    );
  }
}

/** Guarantees the browser is closed even if the callback throws — these leak processes otherwise. */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {
      /* already gone — nothing useful to do */
    });
  }
}
