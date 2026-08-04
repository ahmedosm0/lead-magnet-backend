import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ValidationError, UpstreamError } from "../core/errors.ts";
import { rethrowAs } from "../core/catchAsync.ts";
import { isValidClientSlug, slugify } from "../../lib/slug.ts";
import { extractBrandFromSite, normalizeSiteUrl, type ExtractedBrand } from "./brandService.ts";
import { saveRawUpload, upsertReport } from "../../db/reports.ts";

const UPLOADS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../uploads");

const MAX_FILE_BYTES = 10 * 1024 * 1024; // a 60-day daily export is a few hundred KB

/**
 * The form takes one file picker, not one per source — users shouldn't have to
 * know which slot each export belongs in. Which file is which is decided from
 * the header row, since GA4 and Meta exports have entirely distinct column
 * names (see sample-data/README.md).
 *
 * Either export alone is accepted. Both together is the fullest report, but a
 * client who only runs Meta ads, or who only has analytics, still gets one —
 * the pipeline records which sources were supplied and omits what it can't
 * compute (see DataSources in scripts/parse/types.ts).
 */
export type CsvKind = "ga4" | "meta";

export function detectCsvKind(headerLine: string): CsvKind | null {
  const header = headerLine.toLowerCase();
  if (header.includes("session default channel group") || header.includes("engaged sessions")) return "ga4";
  if (header.includes("campaign name") || header.includes("amount spent")) return "meta";
  return null;
}

interface ClassifiedFile {
  kind: CsvKind;
  name: string;
  text: string;
  bytes: number;
}

async function classify(file: File): Promise<ClassifiedFile> {
  if (file.size === 0) throw new ValidationError(`"${file.name}" is empty`);
  if (file.size > MAX_FILE_BYTES) {
    throw new ValidationError(
      `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)}MB, max 10MB)`
    );
  }
  if (!file.name.toLowerCase().endsWith(".csv")) {
    throw new ValidationError(`"${file.name}" must be a .csv file`);
  }

  const text = await file.text();
  const newlineAt = text.indexOf("\n");
  const kind = detectCsvKind(text.slice(0, newlineAt === -1 ? text.length : newlineAt));
  if (!kind) {
    throw new ValidationError(
      `Couldn't tell whether "${file.name}" is a GA4 or a Meta Ads export — its header row matched neither. ` +
        `Expected a GA4 export (with a "Session default channel group" column) and a Meta Ads Manager ` +
        `export (with "Campaign name" / "Amount spent").`,
      { fileName: file.name }
    );
  }

  return { kind, name: file.name, text, bytes: file.size };
}

export interface UploadResult {
  client: string;
  reportId: string | null;
  /** File name per detected source, or null where that export wasn't supplied. */
  detected: { ga4: string | null; meta: string | null };
  branding: ExtractedBrand;
}

export async function handleUpload(input: {
  clientName: string;
  websiteUrl: string;
  files: File[];
}): Promise<UploadResult> {
  const { clientName, websiteUrl, files } = input;

  if (!clientName?.trim()) throw new ValidationError("Client name is required", { field: "clientName" });

  const slug = slugify(clientName);
  if (!isValidClientSlug(slug)) {
    throw new ValidationError(
      `"${clientName}" doesn't produce a usable client id — use letters, numbers, and spaces`,
      { field: "clientName" }
    );
  }

  if (!websiteUrl?.trim()) {
    throw new ValidationError("Client website URL is required", { field: "websiteUrl" });
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeSiteUrl(websiteUrl);
  } catch {
    throw new ValidationError(`"${websiteUrl}" isn't a valid website URL`, { field: "websiteUrl" });
  }

  if (files.length === 0) {
    throw new ValidationError(
      `Select at least one CSV — a GA4 export, a Meta Ads Manager export, or both.`,
      { field: "files", received: 0 }
    );
  }
  if (files.length > 2) {
    throw new ValidationError(
      `Select at most 2 CSV files — one GA4 export and one Meta Ads Manager export (got ${files.length}).`,
      { field: "files", received: files.length }
    );
  }

  const classified = await Promise.all(files.map(classify));
  const ga4 = classified.find((c) => c.kind === "ga4");
  const meta = classified.find((c) => c.kind === "meta");
  // Two files of the same kind is still an error: one of them would be silently
  // discarded, and we can't know which one the user meant to keep.
  if (classified.length === 2 && (!ga4 || !meta)) {
    throw new ValidationError(
      `Both files look like the same source ` +
        `(${classified.map((c) => `"${c.name}" → ${c.kind.toUpperCase()}`).join(", ")}). ` +
        `Upload one GA4 export and one Meta export, or just one file on its own.`,
      { field: "files" }
    );
  }

  // Reading someone else's website can fail for reasons that aren't our bug
  // (DNS, TLS, timeouts, bot walls) — surface that as an upstream failure with
  // the site named, not as a generic 500.
  const branding: ExtractedBrand = await rethrowAs(
    () => extractBrandFromSite(normalizedUrl, slug),
    (cause) =>
      new UpstreamError(
        `Couldn't read branding from ${normalizedUrl}. Check the URL is reachable.`,
        { websiteUrl: normalizedUrl },
        cause
      )
  );

  const clientDir = path.join(UPLOADS_DIR, slug);
  await mkdir(clientDir, { recursive: true });

  const ga4Path = path.join(clientDir, "ga4_export.csv");
  const metaPath = path.join(clientDir, "meta_ads_export.csv");

  // A source that wasn't supplied this time has its file removed, not left
  // behind. Re-uploading the same client with only a GA4 export would otherwise
  // silently pair it with the previous upload's Meta CSV.
  await Promise.all([
    ga4 ? writeFile(ga4Path, ga4.text, "utf-8") : rm(ga4Path, { force: true }),
    meta ? writeFile(metaPath, meta.text, "utf-8") : rm(metaPath, { force: true }),
    // Step 6 reads this instead of the hardcoded demo agency kits.
    writeFile(path.join(clientDir, "branding.json"), JSON.stringify({ agencySlug: slug, ...branding }, null, 2), "utf-8"),
  ]);

  const reportId = await upsertReport({
    clientSlug: slug,
    clientName: clientName.trim(),
    websiteUrl: normalizedUrl,
    branding: { ...branding },
    monthlyPlan: null, // the form deliberately doesn't collect a budget — see clientPlans.ts
  });

  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  await Promise.all(
    [
      ga4 ? { file: ga4, source: "ga4" as const, storagePath: ga4Path } : null,
      meta ? { file: meta, source: "meta" as const, storagePath: metaPath } : null,
    ]
      .filter((entry) => entry !== null)
      .map(({ file, source, storagePath }) =>
        saveRawUpload(reportId, {
          source,
          fileName: file.name,
          storagePath,
          byteSize: file.bytes,
          contentHash: hash(file.text),
        })
      )
  );

  return {
    client: slug,
    reportId,
    detected: { ga4: ga4?.name ?? null, meta: meta?.name ?? null },
    branding,
  };
}
