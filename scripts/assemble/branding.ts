import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Branding } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

/**
 * Sample prospect-agency brand kits for the outbound/demo use case
 * (docs/project.md: "generate a sample report for a prospect's own
 * featured case-study client from demo/public data"). The report's brand
 * is whichever agency it's being sent to — never TE's own brand, and not
 * tied to which demo client's data is inside it. Real agencies' logos/colors
 * will replace these once the ops form (build-plan.md Phase 6a) exists.
 *
 * logoPath is null on purpose: these agencies are fictional and have no logo
 * file. That renders the initial badge, which is the intended no-logo fallback.
 * Pointing at an asset that doesn't exist renders a broken image instead.
 */
const PROSPECT_AGENCY_BRANDS: Record<string, Omit<Branding, "agencySlug">> = {
  "northlight-digital": {
    agencyName: "Northlight Digital",
    logoPath: null,
    primaryColor: "#1B3A5C",
    secondaryColor: "#E8A33D",
  },
  "meridian-growth-partners": {
    agencyName: "Meridian Growth Partners",
    logoPath: null,
    primaryColor: "#0E7C61",
    secondaryColor: "#F4B942",
  },
};

export const DEFAULT_AGENCY_SLUG = "northlight-digital";

export function getBranding(agencySlug: string): Branding {
  const brand = PROSPECT_AGENCY_BRANDS[agencySlug];
  if (!brand) {
    throw new Error(
      `Unknown agencySlug "${agencySlug}". Configured: ${Object.keys(PROSPECT_AGENCY_BRANDS).join(", ")}`
    );
  }
  return { agencySlug, ...brand };
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Branding for one client, preferring what was extracted from their own
 * website at upload time (backend/uploads/<client>/branding.json) and falling
 * back to a preset demo kit for the built-in sample clients.
 *
 * The file is validated rather than trusted: its colors end up as inline CSS
 * custom properties on the report page, so a malformed value would break the
 * render — better to fall back to a preset than to ship a broken report.
 */
export async function resolveBrandingForClient(client: string): Promise<Branding> {
  const brandingPath = path.join(UPLOADS_DIR, client, "branding.json");

  try {
    const parsed = JSON.parse(await readFile(brandingPath, "utf-8")) as Record<string, unknown>;
    if (isHexColor(parsed.primaryColor) && isHexColor(parsed.secondaryColor) && typeof parsed.agencyName === "string") {
      return {
        agencySlug: typeof parsed.agencySlug === "string" ? parsed.agencySlug : client,
        agencyName: parsed.agencyName,
        logoPath: typeof parsed.logoPath === "string" ? parsed.logoPath : null,
        primaryColor: parsed.primaryColor,
        secondaryColor: parsed.secondaryColor,
        ...(typeof parsed.siteUrl === "string" ? { siteUrl: parsed.siteUrl } : {}),
      };
    }
    console.warn(`[assemble] ${brandingPath} exists but is malformed — falling back to a preset brand kit.`);
  } catch {
    // No extracted branding for this client (e.g. the built-in demo clients).
  }

  return getBranding(process.env.AGENCY_SLUG ?? DEFAULT_AGENCY_SLUG);
}
