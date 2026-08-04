/**
 * Error taxonomy for the API.
 *
 * The pipeline's existing convention is to throw plain Errors with a specific,
 * human-readable message naming the exact row/column/reason (see backend/README).
 * Those messages are genuinely useful to whoever is generating a report, so the
 * API surfaces them — but only for errors we deliberately classified. An
 * unclassified error is treated as a bug: logged in full server-side, reduced to
 * a generic message on the wire, so an unexpected stack trace or a connection
 * string can never leak to a client.
 */

export type ErrorCode =
  | "validation_error"
  | "not_found"
  | "conflict"
  | "upstream_error"
  | "pipeline_error"
  | "internal_error";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Structured extras for the client (which field, which step). Never raw internals. */
  readonly details?: Record<string, unknown>;
  /** Original error, for server-side logging only — never serialized to a response. */
  readonly cause?: unknown;

  constructor(
    message: string,
    opts: { status: number; code: ErrorCode; details?: Record<string, unknown>; cause?: unknown }
  ) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.cause = opts.cause;
  }
}

/** 400 — the caller sent something wrong and can fix it. */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { status: 400, code: "validation_error", details });
  }
}

/** 404 */
export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { status: 404, code: "not_found", details });
  }
}

/** 409 — the request is valid but conflicts with current state. */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { status: 409, code: "conflict", details });
  }
}

/** 502 — a third party we depend on (client website, LLM provider, Supabase) failed. */
export class UpstreamError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, { status: 502, code: "upstream_error", details, cause });
  }
}

/**
 * 422 — a pipeline step threw. The step's own message is preserved because the
 * pipeline is written to fail loudly with actionable text ("column X missing in
 * row 12"), which is exactly what the person uploading needs to see.
 */
export class PipelineError extends AppError {
  constructor(message: string, step: string, cause?: unknown) {
    super(message, { status: 422, code: "pipeline_error", details: { step }, cause });
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

const GENERIC_MESSAGE = "Something went wrong on our end. Check the server logs for details.";

/** Maps any thrown value to a safe status + response body. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
    };
  }

  // Unclassified: assume it may contain internals. Log it, don't echo it.
  return { status: 500, body: { error: { code: "internal_error", message: GENERIC_MESSAGE } } };
}
