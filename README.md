# backend

The HTTP API **and** the pipeline for the Sample Report Generator (see [`docs/pipeline-steps.md`](../docs/pipeline-steps.md) for the step-by-step design and [`docs/architecture.md`](../docs/architecture.md) for the system it belongs to).

The frontend has no filesystem, database, or browser access of its own — it calls this service. Start it first.

## Structure

```
backend/
  main.ts        ENTRYPOINT — verifies the database, then serves the API (default :4000)
  .env           secrets, gitignored (see .env.example)
  api/
    core/
      app.ts       Hono app: middleware, CORS, route mounting, the single onError
      errors.ts    the error taxonomy (ValidationError, NotFoundError, PipelineError, ...)
      catchAsync.ts  catchAsync / nonFatal / rethrowAs — so try/catch isn't repeated
    routes/      thin: validate input → call a service → shape the response
    services/    all real logic: upload, brand extraction, pipeline, report, pdf
    middleware/  request logging
  scripts/
    cli.ts       run the pipeline from the command line (npm run pipeline)
    parse/       Step 1 — raw GA4 + Meta CSVs into clean, typed rows
    normalize/   Step 2 — both sources into one unified metrics schema
    aggregate/   Step 3 — deterministic totals, deltas, campaign rankings, pacing
    brief/       Step 4 — the exact (small, bounded-size) LLM prompt payload
    narrative/   Step 5 — the ONLY step that calls an LLM
      providers/   one file per vendor, all implementing NarrativeProvider
    assemble/    Step 6 — narrative + numbers + branding into one report record
    pdf/         Step 8 — thin CLI over api/services/pdfService.ts
    lib/         CSV reading, checkpoint writer
  db/            Supabase client, health check, query helpers, writes, schema.sql
  lib/           headless-browser launcher, slug helpers
  uploads/       per client: the supplied CSVs, branding.json, logo.* (gitignored)
  output/        per client: checkpoint files (gitignored, regenerate anytime)

../frontend/     Step 7 — Next.js web view; talks to this API over HTTP
```

## API

| Route | Purpose |
|---|---|
| `GET /health` | liveness + database reachability |
| `GET /api/clients` | clients with an assembled report |
| `GET /api/clients/:client/report` | the assembled ReportRecord |
| `GET /api/clients/:client/logo` | logo extracted at upload (ETag-revalidated) |
| `GET /api/clients/:client/pdf` | Step 8, generated on demand |
| `POST /api/uploads` | multipart: `clientName`, `websiteUrl`, two `files` |
| `POST /api/pipeline/run` | `{ client }` → Steps 1-6, returns per-step timings |

Routes stay thin so the same logic serves both the API and the CLI; anything with substance lives in `api/services/`.

## Error handling

One taxonomy (`api/core/errors.ts`), one place errors become responses (`onError` in `api/core/app.ts`). Throw a typed error — `ValidationError` (400), `NotFoundError` (404), `PipelineError` (422, tagged with the step), `UpstreamError` (502) — and it reaches the client with its message intact. Anything unclassified is logged in full and returned as a generic 500, so internals never leak.

The helpers in `api/core/catchAsync.ts` exist so this isn't retyped: `catchAsync` wraps route handlers, `rethrowAs` classifies a low-level failure once, and `nonFatal` runs best-effort work whose failure must never mask the real error (recording a failed run must not replace the pipeline message the user needs to read). `db/query.ts` does the same job for Supabase calls — it owns the "skip when not configured" guard and the `{ data, error }` unwrap.

All 8 pipeline steps from `docs/pipeline-steps.md` are now built. Every step **reads the previous step's checkpoint file from disk** (not the previous step's in-memory result) and writes its own checkpoint (JSON + human-readable `.txt`) to `output/<client>/<step-number>_<name>.{json,txt}` before the next step is allowed to run. That means any single step can be re-run on its own against whatever is already on disk.

## Requirements

- Node.js >= 22.6 (uses `--experimental-strip-types` to run TypeScript directly — no build step, no `ts-node`/`tsx` dependency).
- A `backend/.env` file (see [`.env.example`](./.env.example)) with `MISTRAL_API_KEY=...` for Step 5. Loaded via Node's built-in `--env-file-if-exists=.env` flag — no `dotenv` dependency needed. The `-if-exists` variant (not plain `--env-file`) matters once this deploys: a host like Render injects env vars directly into the process rather than writing a `.env` file, and `--env-file=.env` throws if the file is missing.
- Optionally `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — see the database section below.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `SESSION_SECRET` — see the Authentication section below.

## Database (optional)

`db/` holds the Supabase layer: [`schema.sql`](./db/schema.sql) (mirrored in `../supabase/migrations/`), [`client.ts`](./db/client.ts), [`health.ts`](./db/health.ts), [`query.ts`](./db/query.ts), and [`reports.ts`](./db/reports.ts).

Nine tables, one per durable artifact plus run tracking: `reports`, `raw_uploads`, `normalized_metrics`, `metric_aggregates`, `briefs`, `narratives`, `report_records`, `report_renders`, `pipeline_runs`.

**Persistence is optional.** Every write no-ops when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are unset — handled once in `runQuery`/`runScopedQuery`, not guarded at each call site — so a fresh clone works with no database, and an outage degrades the tool to "still generates reports, just doesn't record them."

Decisions worth keeping:

- **`narratives` is versioned and appended, never overwritten.** Step 5 is the only step that costs money; regenerating prose must not destroy what a client may already have been sent.
- **`briefs` is stored** even though it's derived — it's the exact payload the LLM saw, which is what makes a narrative's claims auditable later.
- **`report_records` holds the assembled report**, which is what lets the API serve the frontend without sharing a filesystem.
- **`pipeline_runs` gives failures a home**: which step broke, the message, and the duration — none of which survives in checkpoint files.
- **RLS is on with no policies.** v1 has no user accounts, so nothing is reachable via the publishable key; the service-role key bypasses RLS. Add policies when public mode (milestone 2) lands.

`SUPABASE_SERVICE_ROLE_KEY` is a full-access secret: server-side only, never `NEXT_PUBLIC_`-prefixed, never committed. It lives only here — the frontend holds no secrets.

## Authentication

v1 has exactly one account — see `docs/project.md`, no user table. `ADMIN_EMAIL`/`ADMIN_PASSWORD` (`api/core/session.ts`) gate `POST /api/uploads`, `POST /api/pipeline/run`, and `GET /api/clients` (the list) behind a signed session cookie (`api/middleware/requireAuth.ts`). `SESSION_SECRET` signs that cookie — set a real one before deploying anywhere reachable from outside your machine; it falls back to a fixed, publicly-known dev value otherwise (a startup warning says so).

**`GET /api/clients/:client/report`, `/logo`, and `/pdf` are deliberately left open.** `/reports/<client>` is the client-facing deliverable (see `docs/architecture.md`) — the point is to hand that link to someone with no login, the same "anyone with the link" model as a shared Google Doc. The slug is the access control for that one report; only the list (which would let a stranger enumerate every client) requires a session.

That model currently depends on the frontend and backend sharing a hostname (cookie scoping ignores port, not hostname) — see "Deploying" below for what changes once they're on two separate hosts.

## LLM provider (Step 5)

Today the narrative step calls **Mistral (`mistral-large-latest`)**. The step is written against a small `NarrativeProvider` interface (`scripts/narrative/providers/types.ts`), not against Mistral's SDK directly — swapping to Anthropic once a key is available means adding one file (`scripts/narrative/providers/anthropic.ts`) and a case in `providers/index.ts`, not touching the prompt, the validation, or `run.ts`. Set `LLM_PROVIDER=anthropic` in `.env` once that file exists; it defaults to `mistral`.

## Branding / white-label (Step 6)

Branding is resolved per client by `scripts/assemble/branding.ts`:

1. **`uploads/<client>/branding.json`** if present — written by the frontend's generate flow, which reads the client's own website (logo + two colors) at upload time. This is the real path for anything uploaded through the UI.
2. Otherwise a preset kit (`northlight-digital`, `meridian-growth-partners` — fictional, for the two demo clients), selectable via `AGENCY_SLUG` or a second CLI arg.

The extracted file is validated rather than trusted — its colors are injected as inline CSS custom properties on the report page, so a malformed value falls back to a preset instead of producing a broken render.

## Web view (Step 7) + PDF export (Step 8)

Step 7 is the Next.js app in `../frontend/`, which renders `/reports/<client>` from what this API returns. Step 8 (`api/services/pdfService.ts`, exposed as `GET /api/clients/:client/pdf` and as `npm run pdf`) drives a real headless browser against that **live URL** and prints it — rather than maintaining a second template, so the PDF can't drift from what a client sees on the link.

Both the PDF export and brand extraction use `lib/browser.ts`, which tries the Edge install already on Windows first (Playwright's `channel: "msedge"`, then two known install paths), and falls back to a bare `chromium.launch()` — which finds whatever playwright-core downloaded for itself. That download isn't automatic; on Linux (no Edge at all) it must be installed once during deploy: `npx playwright-core install --with-deps chromium`. `withBrowser()` guarantees the browser closes even when the callback throws — these leak processes otherwise.

**Prerequisite:** the frontend must be running (`FRONTEND_URL`, default `http://localhost:3000`) before a PDF can be generated — it's a real browser hitting a real URL, not a server-side render. Because of that cross-process dependency, PDF is **not** part of `npm run pipeline`.

## Running the API

```bash
cd backend
npm install       # first time only
npm run dev       # watch mode, http://localhost:4000
npm run start     # no watch
```

`main.ts` checks the database before it accepts traffic. A configured-but-unreachable database is fatal (credentials are set and silently not working — every write would be dropped); an unconfigured one just logs a warning and runs on checkpoint files.

## Running the whole pipeline from the CLI

```bash
cd backend
npm run pipeline                                  # all clients
npm run pipeline -- ecommerce-solstice-skincare   # one client
```

This runs [`scripts/cli.ts`](./scripts/cli.ts), which calls the same step functions the API's `pipelineService` calls (parse → normalize → aggregate → brief → narrative → assemble). Neither path duplicates the other's logic.

## Running one step at a time

```bash
cd backend
npm run parse                                     # Step 1 — all clients
npm run parse -- ecommerce-solstice-skincare         # Step 1 — one client
npm run normalize                                 # Step 2 — all clients (reads 01_parsed.json)
npm run normalize -- leadgen-crestline-roofing       # Step 2 — one client
npm run aggregate                                 # Step 3 — all clients (reads 02_normalized.json)
npm run aggregate -- ecommerce-solstice-skincare     # Step 3 — one client
npm run brief                                     # Step 4 — all clients (reads 03_aggregates.json)
npm run brief -- leadgen-crestline-roofing           # Step 4 — one client
npm run narrative                                 # Step 5 — all clients (reads 04_brief.json, calls the LLM)
npm run narrative -- ecommerce-solstice-skincare     # Step 5 — one client
npm run assemble                                  # Step 6 — all clients, default agency branding
npm run assemble -- leadgen-crestline-roofing meridian-growth-partners  # Step 6 — one client, one agency
npm run pdf                                       # Step 8 — all clients (needs frontend dev server running)
npm run pdf -- ecommerce-solstice-skincare           # Step 8 — one client
```

Useful when you've only changed one step's logic and don't want to re-run everything before it.

## Output

- Step 1: `01_parsed.json`, `01_parsed_ga4.{json,txt}`, `01_parsed_meta.{json,txt}`
- Step 2: `02_normalized.{json,txt}`
- Step 3: `03_aggregates.{json,txt}` — period totals (current 30 days vs. prior 30 days), deltas, campaigns ranked best-to-worst by cost/result (current AND prior period, so Step 4 can compute trend), and budget pacing vs. each client's approved monthly plan (`scripts/aggregate/clientPlans.ts` — a plan number always has to come from outside the data itself; pacing against nothing isn't meaningful)
- Step 4: `04_brief.{json,txt}` — the entire Step 5 prompt payload, nothing more. Ran against the demo data it comes out to ~400 tokens regardless of client — for the ecommerce client that's about **135x smaller** than the raw parsed data (`01_parsed.json`), which is the whole point: the brief's size doesn't grow with the input's size, it only ever reflects the number of campaigns/metrics, so cost and latency stay flat no matter how much history a real client sends.
- Step 5: `05_narrative.{json,txt}` — executive summary, wins, concerns, recommended actions, budget pacing narrative. Validated (`scripts/narrative/validate.ts`) against the expected shape before it's written — a malformed or non-JSON model response fails loudly instead of reaching a client report.
- Step 6: `06_report.{json,txt}` — the complete, self-contained thing Steps 7-8 render: narrative + full metrics (`03_aggregates`) + a day-by-day chart series rolled up from `02_normalized` + branding. Re-running Step 6 alone with a different agency slug reproduces the identical numbers and narrative under a different brand — proof branding is genuinely data-driven, not hardcoded into a template.
- Step 8: `08_report.pdf` + `08_report_meta.{json,txt}` — the PDF (~100-110KB for the demo clients) and a small sidecar recording the source URL, generation time, and file size.

Open the `.txt` files first — they're the fast way to sanity-check the data at each stage (right columns, right row counts, nothing silently coerced to `NaN`/`null`, numbers that hand-check against the raw CSV, and for Step 5, every number in the prose actually traces back to `04_brief.json`). Every step fails loudly (throws, naming the exact row/column/reason) rather than producing bad data quietly — a missing/renamed column, a client whose Meta data mixes purchase and lead campaigns, a client with no configured spend plan, or an LLM response that doesn't match the Narrative shape should all stop the pipeline, not flow through it.

No LLM is involved anywhere in Steps 1-4 — everything through `04_brief` is plain, deterministic code. Step 5 is the first and only step that calls an LLM, and it will only ever see the brief, never raw client files. That's on purpose; see [`docs/llm-context-strategy.md`](../docs/llm-context-strategy.md).

## Deploying (e.g. Render)

As a Web Service, Node environment:

- **Build Command:** `npm install && npx playwright-core install --with-deps chromium` — the install step is required; without it, `/pdf` and website-branding extraction fail on first use (there's no Edge on Linux, see "Web view + PDF export" above).
- **Start Command:** `npm start`
- **Port:** don't set one. `main.ts` reads `process.env.PORT`, which Render sets itself, and `@hono/node-server`'s `serve()` already binds to all interfaces (no explicit `hostname` is passed) — both are required for Render's health checks to reach the service, and both already work with no config.

**Environment variables to set on the service** (`.env` isn't deployed — see `.env.example`):

| Var | Value on Render |
|---|---|
| `MISTRAL_API_KEY` | your key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | your project's, if persistence is wanted |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | your real login, not the dev defaults |
| `SESSION_SECRET` | a long random string — required here; the dev fallback is fine only on your own machine |
| `CORS_ORIGINS` | the deployed frontend's public URL |
| `FRONTEND_URL` | the deployed frontend's public URL (used by the PDF step's headless browser) |

**The cross-domain cookie gap.** Everything above gets the pipeline working; sign-in is a separate concern. The frontend's login gate and this backend's session cookie currently work together only because local dev has them on the same hostname (`localhost`) — cookie scoping ignores port, not hostname. Render gives each service its own distinct `*.onrender.com` hostname, so **as deployed, no cookie set by this API will ever reach the frontend**, and the login gate effectively can't pass. This needs one deliberate fix before relying on the login in production — see `docs/architecture.md` "Known gaps" for the options.
