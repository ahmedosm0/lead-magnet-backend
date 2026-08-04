import { Hono } from "hono";

import { ValidationError } from "../core/errors.ts";
import { catchAsync, rethrowAs } from "../core/catchAsync.ts";
import { handleUpload } from "../services/uploadService.ts";

export const uploadRoutes = new Hono();

uploadRoutes.post(
  "/uploads",
  catchAsync(async (c) => {
    const form = await rethrowAs(
      () => c.req.formData(),
      () => new ValidationError("Expected a multipart/form-data body with clientName, websiteUrl and files.")
    );

    const clientName = form.get("clientName");
    const websiteUrl = form.get("websiteUrl");
    const files = form.getAll("files").filter((f): f is File => f instanceof File);

    const result = await handleUpload({
      clientName: typeof clientName === "string" ? clientName : "",
      websiteUrl: typeof websiteUrl === "string" ? websiteUrl : "",
      files,
    });

    return c.json(result, 201);
  })
);
