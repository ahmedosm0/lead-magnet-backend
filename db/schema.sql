-- Supabase schema for the Sample Report Generator.
-- Mirrors the data model in docs/architecture.md.
--
-- Apply with either:
--   supabase db push            (if using the Supabase CLI with this file linked as a migration)
--   or paste into the SQL editor at https://supabase.com/dashboard/project/<ref>/sql
--
-- Design notes:
--  * NARRATIVES is versioned and keyed separately from REPORTS on purpose —
--    re-rendering with different branding must never require a new (paid) LLM
--    call against aggregates that haven't changed.
--  * NORMALIZED_METRICS is the reusable "clean data" layer; aggregation can
--    eventually become a SQL query over it instead of re-reading JSON.
--  * Raw CSVs live in Supabase Storage, not in a column — only the path is here.

create extension if not exists "pgcrypto";

-- One row per generated report -------------------------------------------------
create table if not exists reports (
  id            uuid primary key default gen_random_uuid(),
  -- UNIQUE because every write path upserts on client_slug (onConflict).
  client_slug   text        not null unique,
  client_name   text        not null,
  website_url   text,
  mode          text        not null default 'internal'
                            check (mode in ('internal', 'outbound', 'public')),
  branding      jsonb       not null default '{}'::jsonb,  -- agencyName, logoPath, primaryColor, secondaryColor, siteUrl
  monthly_plan  numeric,                                    -- null = no approved budget; pacing section is omitted
  status        text        not null default 'pending'
                            check (status in ('pending', 'parsing', 'narrating', 'ready', 'failed')),
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists reports_created_at_idx on reports (created_at desc);

-- The uploaded CSVs (file bytes live in Storage; this is the pointer) ----------
create table if not exists raw_uploads (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid        not null references reports (id) on delete cascade,
  source       text        not null check (source in ('ga4', 'meta')),
  file_name    text        not null,
  storage_path text        not null,
  row_count    integer,
  uploaded_at  timestamptz not null default now(),
  unique (report_id, source)
);

-- Step 2 output: the unified metrics schema -----------------------------------
create table if not exists normalized_metrics (
  id              bigserial primary key,
  report_id       uuid    not null references reports (id) on delete cascade,
  metric_date     date    not null,
  source          text    not null check (source in ('ga4', 'meta')),
  dimension       text    not null,               -- 'channel' | 'campaign'
  dimension_value text    not null,
  sessions        integer,
  spend           numeric not null default 0,
  results         integer not null default 0,
  result_type     text    check (result_type in ('purchase', 'lead')),
  revenue         numeric not null default 0
);

-- The single index that matters: every read is "this report, by date".
create index if not exists normalized_metrics_report_date_idx
  on normalized_metrics (report_id, metric_date);

-- Step 3 output: cached so a branding change never recomputes it ---------------
create table if not exists metric_aggregates (
  id         uuid primary key default gen_random_uuid(),
  report_id  uuid        not null references reports (id) on delete cascade,
  payload    jsonb       not null,   -- the whole AggregateResult
  created_at timestamptz not null default now(),
  unique (report_id)
);

-- Step 5 output: versioned, because this is the step that costs money ---------
create table if not exists narratives (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid        not null references reports (id) on delete cascade,
  version           integer     not null default 1,
  content           jsonb       not null,  -- executiveSummary, wins, concerns, recommendedActions, budgetPacingNarrative?
  model             text        not null,
  prompt_tokens     integer,
  completion_tokens integer,
  created_at        timestamptz not null default now(),
  unique (report_id, version)
);

-- Steps 7/8: where the rendered artifacts ended up ----------------------------
create table if not exists report_renders (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid        not null references reports (id) on delete cascade,
  web_view_url text,
  pdf_url      text,
  rendered_at  timestamptz not null default now()
);

-- Row Level Security ----------------------------------------------------------
-- v1 has no user accounts (docs/project.md non-goals) and is reached only via a
-- token-protected internal route, so no anon policies are granted here. RLS is
-- enabled so that the anon/public key cannot read anything by default; the
-- pipeline connects with the service-role key, which bypasses RLS. Add explicit
-- policies here when public mode (milestone 2) lands.
alter table reports            enable row level security;
alter table raw_uploads        enable row level security;
alter table normalized_metrics enable row level security;
alter table metric_aggregates  enable row level security;
alter table narratives         enable row level security;
alter table report_renders     enable row level security;
