import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NotFoundError } from "../core/errors.ts";
import { getReportRecordBySlug, getStoredLogo, listReadyClientSlugs } from "../../db/reports.ts";
import { isSupabaseConfigured } from "../../db/client.ts";
import { contentTypeForLogoExt } from "../../lib/logo.ts";
import type { ReportRecord } from "../../scripts/assemble/types.ts";

const OUTPUT_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../output");
const UPLOADS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../uploads");

/**
 * Reads the assembled report, preferring Supabase and falling back to the
 * 06_report.json checkpoint on disk.
 *
 * The DB path is what will let the frontend be deployed separately (serverless
 * instances share no filesystem). The disk path keeps the tool working with no
 * database at all, which is the same "persistence is optional" contract the
 * rest of the backend follows.
 */
export async function getReport(client: string): Promise<ReportRecord> {
  if (isSupabaseConfigured()) {
    const record = await getReportRecordBySlug(client);
    if (record) return record as ReportRecord;
  }

  const filePath = path.join(OUTPUT_DIR, client, "06_report.json");
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as ReportRecord;
  } catch {
    throw new NotFoundError(
      `No assembled report for "${client}". Run the pipeline for it first.`,
      { client }
    );
  }
}

/**
 * Union of both sources, not one or the other.
 *
 * Reports created through the upload flow have a `reports` row; the built-in
 * demo clients are generated from the CLI and only exist as checkpoint files.
 * Preferring the database would silently hide the demo clients (and vice
 * versa), so both are listed.
 */
export async function listClients(): Promise<string[]> {
  const [fromDb, fromDisk] = await Promise.all([
    isSupabaseConfigured() ? listReadyClientSlugs() : Promise.resolve([]),
    listClientsOnDisk(),
  ]);
  return [...new Set([...fromDb, ...fromDisk])].sort();
}

async function listClientsOnDisk(): Promise<string[]> {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  const clients: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(OUTPUT_DIR, entry.name, "06_report.json"), "utf-8");
      clients.push(entry.name);
    } catch {
      // no assembled report for this client yet
    }
  }
  return clients;
}

export interface LogoAsset {
  data: Uint8Array;
  contentType: string;
  etag: string;
}

/**
 * Locates the logo downloaded at upload time. The extension varies by what the
 * client's site served (svg/png/ico/...), so the file is found by prefix rather
 * than assumed.
 *
 * Disk is preferred (cheap, and correct immediately after upload in the same
 * container) but isn't durable — an ephemeral host (Render) wipes it on every
 * restart/redeploy/idle spin-down. When it's gone, this falls back to the copy
 * `saveLogo` persisted to Supabase at upload time (see db/reports.ts).
 */
export async function getLogo(client: string): Promise<LogoAsset> {
  const dir = path.join(UPLOADS_DIR, client);
  const entries = await readdir(dir).catch(() => []);
  const logo = entries.find((name) => name.startsWith("logo."));

  if (logo) {
    const filePath = path.join(dir, logo);
    const contentType = contentTypeForLogoExt(path.extname(logo));

    // The URL is stable per client but the file behind it changes on
    // re-upload, so the response must be revalidated rather than cached by
    // time — otherwise a client who re-uploads keeps seeing their previous
    // logo. mtime+size is enough to detect a replacement.
    const { mtimeMs, size } = await stat(filePath);
    const etag = `"${Math.round(mtimeMs).toString(36)}-${size.toString(36)}"`;

    return { data: await readFile(filePath), contentType, etag };
  }

  if (isSupabaseConfigured()) {
    const stored = await getStoredLogo(client);
    if (stored) {
      // No mtime to key off here — hash the bytes instead, still cheap enough
      // to compute per request for something this small.
      const etag = `"${createHash("sha1").update(stored.data).digest("hex").slice(0, 16)}"`;
      return { data: stored.data, contentType: stored.contentType, etag };
    }
  }

  throw new NotFoundError(`No logo stored for "${client}"`, { client });
}
