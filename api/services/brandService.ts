import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../lib/browser.ts";
import { contentTypeForLogoExt } from "../../lib/logo.ts";

/**
 * Derives a client's visual identity from their live website so the report
 * carries THEIR brand (docs/project.md: "white-label means THEIR brand").
 *
 * Uses a real headless browser rather than fetching + regexing HTML, because
 * the two things worth extracting are only knowable after CSS applies:
 * computed colors of rendered elements, and which <img> actually renders as
 * the header logo. Reuses the same Edge-channel launcher as the PDF route.
 */

export interface ExtractedBrand {
  agencyName: string;
  siteUrl: string;
  logoPath: string | null; // API path served by this backend, or null if no logo was found
  primaryColor: string;
  secondaryColor: string;
  /** True when colors came from the site; false when we fell back to neutral defaults. */
  colorsFromSite: boolean;
}

/** The logo's actual bytes, kept separate from ExtractedBrand so they never end up serialized into branding.json. */
export interface ExtractedLogoFile {
  data: Buffer;
  contentType: string;
}

export interface BrandExtractionResult {
  brand: ExtractedBrand;
  /** Null when no logo was found — same "cosmetic, fall back to an initial badge" case as ExtractedBrand.logoPath. */
  logoFile: ExtractedLogoFile | null;
}

/** Used when a site yields nothing usable — a neutral, contrast-safe pair, not a guess at their brand. */
const FALLBACK_PRIMARY = "#1F2937";
const FALLBACK_SECONDARY = "#6B7280";

const BRANDING_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../uploads");

export function normalizeSiteUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  // Throws on malformed input — the caller turns that into a 400.
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol "${url.protocol}"`);
  }
  return url.toString();
}

/** Relative luminance (WCAG). Used to reject colors too close to white/black to read as a brand color. */
function luminance(r: number, g: number, b: number): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Saturation in HSL terms — near-zero means grey, which is chrome, not brand. */
function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

interface RawColorCount {
  rgb: [number, number, number];
  weight: number;
}

/**
 * Keeps colors that could plausibly be a brand color: saturated enough to not
 * be grey, and not so light/dark they're really background or body text.
 */
function isBrandCandidate([r, g, b]: [number, number, number]): boolean {
  const lum = luminance(r, g, b);
  return saturation(r, g, b) >= 0.18 && lum > 0.03 && lum < 0.85;
}

/** Rejects a second color that's visually the same as the first. */
function isDistinct(a: [number, number, number], b: [number, number, number]): boolean {
  const dist = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
  return dist > 60;
}

/** Dark ink for resolving `currentColor`, since the report header is light. */
const LOGO_INK = "#111827";

/**
 * An inline <svg> lifted off someone else's page carries that page's context
 * with it, and both parts break once it's served standalone:
 *
 *  - `fill="currentColor"` inherits the *source* page's text colour. Sites with
 *    a dark header set `color="white"`, so the mark renders white-on-white and
 *    looks like no logo at all (this is exactly what vercel.com produces).
 *  - framework `class` attributes (`absolute left-1/2 -translate-x-1/2 …`)
 *    reference CSS we don't ship.
 *
 * Strip both and pin a dark ink so the mark is visible on the report.
 */
function sanitizeSvg(markup: string): string {
  return (
    markup
      .replace(/\sclass="[^"]*"/gi, "")
      .replace(/\scolor="[^"]*"/gi, "")
      .replace(/\sstyle="[^"]*"/gi, "")
      // Substitute the literal colour rather than setting `color` and letting
      // currentColor resolve: served through an <img>, the SVG renders in its
      // own isolated document where that inheritance is unreliable, and the
      // failure mode is a silently invisible logo.
      .replace(/currentColor/g, LOGO_INK)
      .replace(/<svg\b/i, `<svg color="${LOGO_INK}"`)
  );
}

export async function extractBrandFromSite(siteUrl: string, clientSlug: string): Promise<BrandExtractionResult> {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // Let webfonts/CSS settle so computed styles reflect the real design.
    await page.waitForTimeout(1500);

    const harvest = await page.evaluate(() => {
      const parseRgb = (value: string): [number, number, number] | null => {
        const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
        if (!m) return null;
        const alpha = m[4] === undefined ? 1 : Number(m[4]);
        if (alpha < 0.5) return null; // effectively transparent — not a visible brand color
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      };

      // Weight by how much screen area the element occupies and how "brand-ish"
      // its role is — a header background says more than one link in a footer.
      const weightFor = (el: Element, area: number, isBackground: boolean): number => {
        const tag = el.tagName.toLowerCase();
        let w = isBackground ? Math.min(area, 200_000) / 1000 : 12;
        if (["header", "nav"].includes(tag)) w *= 3;
        if (["button", "a"].includes(tag)) w *= 1.5;
        const cls = (el.getAttribute("class") ?? "").toLowerCase();
        if (/(btn|button|cta|primary|brand|header|nav)/.test(cls)) w *= 1.8;
        return w;
      };

      const counts: Record<string, { rgb: [number, number, number]; weight: number }> = {};
      const add = (rgb: [number, number, number] | null, weight: number) => {
        if (!rgb) return;
        const key = rgb.join(",");
        counts[key] ??= { rgb, weight: 0 };
        counts[key].weight += weight;
      };

      const elements = Array.from(document.querySelectorAll("body *")).slice(0, 3000);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const area = rect.width * rect.height;
        const style = getComputedStyle(el);
        add(parseRgb(style.backgroundColor), weightFor(el, area, true));
        add(parseRgb(style.color), weightFor(el, area, false));
      }

      // theme-color is an explicit brand declaration — trust it above sampling.
      const themeColor =
        document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null;

      // Logo detection. Position alone is NOT enough — a hero photo sits in the
      // header too. A candidate must either self-identify as a logo, or be a
      // small mark inside the header's home link. Anything photo-sized is
      // rejected outright; a wrong logo looks worse than none at all.
      const MAX_LOGO_AREA = 90_000; // ~300x300 — real logos are small
      const logoCandidates = Array.from(document.querySelectorAll("img, svg"))
        .map((el) => {
          const isSvg = el.tagName.toLowerCase() === "svg";
          const img = el as HTMLImageElement;
          const haystack = `${el.getAttribute("src") ?? ""} ${el.getAttribute("alt") ?? ""} ${
            el.getAttribute("class") ?? ""
          } ${el.getAttribute("aria-label") ?? ""} ${el.closest("a")?.getAttribute("aria-label") ?? ""} ${
            el.closest("a,header,nav")?.getAttribute("class") ?? ""
          }`.toLowerCase();

          const rect = el.getBoundingClientRect();
          const area = rect.width * rect.height;
          const identifiesAsLogo = /logo|brand|wordmark/.test(haystack);

          // A link pointing at the site root, inside the header — the classic
          // "logo links home" pattern.
          const link = el.closest("a");
          const href = link?.getAttribute("href") ?? "";
          const isHomeLink = href === "/" || href === "" || /^https?:\/\/[^/]+\/?$/.test(href);
          const inHeader = Boolean(el.closest("header, nav"));

          let score = 0;
          if (identifiesAsLogo) score += 100;
          if (inHeader && isHomeLink) score += 60;
          if (rect.top < 200) score += 10;

          // Photos are large; marks are not. Only trust a big image if it
          // explicitly calls itself a logo.
          if (area > MAX_LOGO_AREA && !identifiesAsLogo) score = 0;
          if (area < 64) score = 0; // tracking pixel / invisible

          return {
            src: isSvg ? null : img.currentSrc || img.src,
            isSvg,
            score,
            area,
          };
        })
        // 60 = the weakest signal we'll still trust (header home-link mark).
        .filter((c) => c.score >= 60)
        .sort((a, b) => b.score - a.score || a.area - b.area);

      // Inline <svg> logos can't be fetched by URL — serialize the markup instead.
      const bestSvgEl = (() => {
        const svgs = Array.from(document.querySelectorAll("svg"));
        for (const svg of svgs) {
          const haystack = `${svg.getAttribute("class") ?? ""} ${svg.getAttribute("aria-label") ?? ""} ${
            svg.closest("a")?.getAttribute("aria-label") ?? ""
          } ${svg.closest("a,header,nav")?.getAttribute("class") ?? ""}`.toLowerCase();
          if (/logo|brand|wordmark/.test(haystack)) return new XMLSerializer().serializeToString(svg);
        }
        return null;
      })();

      // Deliberately NOT falling back to og:image — that's a social share card
      // (usually a screenshot or marketing banner), not a logo.
      const iconHref =
        document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") ??
        document.querySelector('link[rel~="icon"]')?.getAttribute("href") ??
        null;

      return {
        colors: Object.values(counts),
        themeColor,
        logoSrc: logoCandidates.find((c) => c.src)?.src ?? null,
        inlineSvg: bestSvgEl,
        iconHref,
        title: document.title ?? "",
        siteName:
          document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") ?? null,
      };
    });

    // --- colors -------------------------------------------------------------
    const candidates: RawColorCount[] = (harvest.colors as RawColorCount[])
      .filter((c) => isBrandCandidate(c.rgb))
      .sort((a, b) => b.weight - a.weight);

    let primaryRgb: [number, number, number] | null = null;
    let secondaryRgb: [number, number, number] | null = null;

    if (harvest.themeColor) {
      const m = harvest.themeColor.trim().match(/^#?([0-9a-f]{6})$/i);
      if (m) {
        const int = parseInt(m[1], 16);
        const rgb: [number, number, number] = [(int >> 16) & 255, (int >> 8) & 255, int & 255];
        if (isBrandCandidate(rgb)) primaryRgb = rgb;
      }
    }

    for (const c of candidates) {
      if (!primaryRgb) {
        primaryRgb = c.rgb;
        continue;
      }
      if (!secondaryRgb && isDistinct(primaryRgb, c.rgb)) {
        secondaryRgb = c.rgb;
        break;
      }
    }

    const colorsFromSite = primaryRgb !== null;
    const primaryColor = primaryRgb ? toHex(...primaryRgb) : FALLBACK_PRIMARY;
    const secondaryColor = secondaryRgb ? toHex(...secondaryRgb) : FALLBACK_SECONDARY;

    // --- logo ---------------------------------------------------------------
    let logoPath: string | null = null;
    let logoFile: ExtractedLogoFile | null = null;

    // An inline <svg> logo has no URL to fetch — write the serialized markup.
    if (harvest.inlineSvg) {
      const dir = path.join(BRANDING_ROOT, clientSlug);
      await mkdir(dir, { recursive: true });
      const data = Buffer.from(sanitizeSvg(harvest.inlineSvg), "utf-8");
      await writeFile(path.join(dir, "logo.svg"), data);
      logoPath = `/api/clients/${clientSlug}/logo`;
      logoFile = { data, contentType: contentTypeForLogoExt("svg") };
    }

    // Falls back to the site icon (a real brand mark) rather than og:image.
    const logoSource = harvest.logoSrc ?? harvest.iconHref;

    if (!logoPath && logoSource) {
      try {
        const absolute = new URL(logoSource, siteUrl).toString();
        // Fetch through the page's context so same-origin/referer rules apply.
        const response = await page.request.get(absolute, { timeout: 10_000 });
        if (response.ok()) {
          const body = await response.body();
          const contentTypeHeader = response.headers()["content-type"] ?? "";
          const ext =
            contentTypeHeader.includes("svg") ? "svg"
            : contentTypeHeader.includes("png") ? "png"
            : contentTypeHeader.includes("webp") ? "webp"
            : contentTypeHeader.includes("jpeg") || contentTypeHeader.includes("jpg") ? "jpg"
            : contentTypeHeader.includes("x-icon") || contentTypeHeader.includes("vnd.microsoft.icon") ? "ico"
            : path.extname(new URL(absolute).pathname).replace(".", "") || "png";

          if (body.length > 0 && body.length < 3 * 1024 * 1024) {
            const dir = path.join(BRANDING_ROOT, clientSlug);
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, `logo.${ext}`), body);
            logoPath = `/api/clients/${clientSlug}/logo`;
            // Derived from the extension, not the origin's raw header, so this
            // matches exactly what a disk-served logo would report — see lib/logo.ts.
            logoFile = { data: body, contentType: contentTypeForLogoExt(ext) };
          }
        }
      } catch {
        // A missing logo is cosmetic — the report falls back to an initial badge.
        logoPath = null;
      }
    }

    // --- name ---------------------------------------------------------------
    const hostname = new URL(siteUrl).hostname.replace(/^www\./, "");
    const agencyName =
      harvest.siteName?.trim() ||
      harvest.title?.split(/[|\-–—:]/)[0]?.trim() ||
      hostname;

    return {
      brand: {
        agencyName: agencyName.slice(0, 80),
        siteUrl,
        logoPath,
        primaryColor,
        secondaryColor,
        colorsFromSite,
      },
      logoFile,
    };
  } finally {
    await browser.close();
  }
}
