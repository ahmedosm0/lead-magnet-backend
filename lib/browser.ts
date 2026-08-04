import { chromium, type Browser } from "playwright-core";

/**
 * Single place that knows how to get a headless browser. Two things need one:
 * brand extraction (reading a client's site) and PDF export (printing our own
 * report page).
 *
 * Locally (Windows dev) this reuses the OS's Edge install via Playwright's
 * "channel" option, so playwright-core never needs to bundle a browser of its
 * own. That install doesn't exist on a Linux host (e.g. Render) — there the
 * last rung, a bare `chromium.launch()` with no channel/path, picks up
 * whatever playwright-core downloaded itself. That download isn't automatic:
 * the deploy's build command must run
 *   npx playwright-core install --with-deps chromium
 * once, or this rung fails too. See backend/README.md "Deploying".
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
    try {
      return await chromium.launch({ headless: true });
    } catch (bareError) {
      throw new Error(
        `Could not launch a browser: no Edge install found (channel or known paths), and ` +
          `playwright-core's own managed browser isn't installed either. On a fresh host, run ` +
          `"npx playwright-core install --with-deps chromium" once. ` +
          `Channel error: ${(channelError as Error).message}. Bare launch error: ${(bareError as Error).message}`
      );
    }
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
