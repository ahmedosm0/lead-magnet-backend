import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NotFoundError } from "../core/errors.ts";
import { getReportRecordBySlug, listReadyClientSlugs } from "../../db/reports.ts";
import { isSupabaseConfigured } from "../../db/client.ts";
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

/**
 * Locates the logo downloaded at upload time. The extension varies by what the
 * client's site served (svg/png/ico/...), so the file is found by prefix rather
 * than assumed.
 */
export async function findLogoFile(
  client: string
): Promise<{ filePath: string; contentType: string; etag: string }> {
  const dir = path.join(UPLOADS_DIR, client);
  const entries = await readdir(dir).catch(() => []);
  const logo = entries.find((name) => name.startsWith("logo."));
  if (!logo) throw new NotFoundError(`No logo stored for "${client}"`, { client });

  const ext = path.extname(logo).toLowerCase();
  const contentType =
    ext === ".svg" ? "image/svg+xml"
    : ext === ".png" ? "image/png"
    : ext === ".webp" ? "image/webp"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".ico" ? "image/x-icon"
    : "application/octet-stream";

  const filePath = path.join(dir, logo);

  // The URL is stable per client but the file behind it changes on re-upload,
  // so the response must be revalidated rather than cached by time — otherwise
  // a client who re-uploads keeps seeing their previous logo. mtime+size is
  // enough to detect a replacement.
  const { mtimeMs, size } = await stat(filePath);
  const etag = `"${Math.round(mtimeMs).toString(36)}-${size.toString(36)}"`;

  return { filePath, contentType, etag };
}
