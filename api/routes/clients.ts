import { readFile } from "node:fs/promises";
import { Hono } from "hono";

import { ValidationError } from "../core/errors.ts";
import { catchAsync } from "../core/catchAsync.ts";
import { isValidClientSlug } from "../../lib/slug.ts";
import { findLogoFile, getReport, listClients } from "../services/reportService.ts";
import { generatePdf } from "../services/pdfService.ts";

export const clientRoutes = new Hono();

/**
 * Every :client segment lands in a filesystem path or a SQL filter — validate
 * before use. Accepts undefined because wrapping a handler in catchAsync widens
 * Hono's param typing; a missing segment is just another invalid id here.
 */
function requireSlug(raw: string | undefined): string {
  if (!raw || !isValidClientSlug(raw)) {
    throw new ValidationError(`Invalid client id "${raw ?? ""}"`, { field: "client" });
  }
  return raw;
}

clientRoutes.get(
  "/clients",
  catchAsync(async (c) => c.json({ clients: await listClients() }))
);

clientRoutes.get(
  "/clients/:client/report",
  catchAsync(async (c) => {
    const client = requireSlug(c.req.param("client"));
    return c.json({ report: await getReport(client) });
  })
);

clientRoutes.get(
  "/clients/:client/logo",
  catchAsync(async (c) => {
    const client = requireSlug(c.req.param("client"));
    const { filePath, contentType, etag } = await findLogoFile(client);

    // The logo URL is stable per client but its content changes on re-upload,
    // so revalidate rather than cache by age — a time-based cache would serve
    // the previous logo for its whole lifetime.
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);

    const body = await readFile(filePath);
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      ETag: etag,
    });
  })
);

clientRoutes.get(
  "/clients/:client/pdf",
  catchAsync(async (c) => {
    const client = requireSlug(c.req.param("client"));
    const pdf = await generatePdf(client);

    return c.body(new Uint8Array(pdf), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${client}-report.pdf"`,
      "Content-Length": String(pdf.length),
    });
  })
);
