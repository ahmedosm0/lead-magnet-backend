/**
 * The one mapping used everywhere a logo's file extension needs a Content-Type
 * — extracting it (brandService.ts) and serving it, whether from disk or the
 * Supabase fallback (reportService.ts). Kept in one place so a logo served
 * from the DB reports the same Content-Type it would have from disk.
 */
export function contentTypeForLogoExt(ext: string): string {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  switch (normalized) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}
