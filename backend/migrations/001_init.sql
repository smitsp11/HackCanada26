-- Opera AI backend - initial schema.
--
-- Six tables. Postgres holds state and facts; object storage holds bytes.
-- stage_runs is the load-bearing one: it is simultaneously the work queue,
-- the retry ledger, the idempotency key, and the permanent result store.
-- The old backend's fatal flaw was that results existed only inside an SSE
-- stream; here every stage output is persisted the moment it completes.

-- ---------------------------------------------------------------------------
-- Knowledge base (populated offline by the manual ingestion CLI)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS manuals (
    manual_id      TEXT PRIMARY KEY,
    brand          TEXT NOT NULL,
    title          TEXT,
    -- Local path or storage key for the PDF itself.
    pdf_path       TEXT NOT NULL,
    -- Makes re-ingesting the same file a no-op.
    pdf_sha256     TEXT UNIQUE NOT NULL,
    page_count     INTEGER,
    -- Quoted scope language ("only qualified personnel may...") used by the
    -- safety gate, so the DIY/technician line is sourced from the OEM.
    scope_note     TEXT,
    scope_pages    INTEGER[],
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The catalog identification validates against. A model number that is not in
-- here is a signal to re-prompt or ask the user, which is a better reliability
-- check than asking a second model whether the first one was right.
CREATE TABLE IF NOT EXISTS appliances (
    id                SERIAL PRIMARY KEY,
    brand             TEXT NOT NULL,
    model_number      TEXT NOT NULL,
    model_normalized  TEXT NOT NULL,
    series            TEXT,
    appliance_type    TEXT,
    -- Decoded from the model nomenclature table, e.g. capacity/width/airflow.
    attributes        JSONB NOT NULL DEFAULT '{}'::jsonb,
    manual_id         TEXT REFERENCES manuals(manual_id) ON DELETE SET NULL,
    UNIQUE (brand, model_normalized)
);

CREATE INDEX IF NOT EXISTS idx_appliances_normalized ON appliances (model_normalized);
CREATE INDEX IF NOT EXISTS idx_appliances_series ON appliances (series);

-- ---------------------------------------------------------------------------
-- Live case state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cases (
    case_id             TEXT PRIMARY KEY,
    user_id             TEXT,
    status              TEXT NOT NULL DEFAULT 'created',
    symptom             TEXT,
    error_code          TEXT,
    appliance_type_hint TEXT,
    brand_hint          TEXT,
    model_hint          TEXT,
    -- Set once identification is confirmed; pins which manual we reason over.
    manual_id           TEXT REFERENCES manuals(manual_id) ON DELETE SET NULL,
    confirmed_model     TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cases_user ON cases (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assets (
    asset_id      TEXT PRIMARY KEY,
    case_id       TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
    role          TEXT NOT NULL,              -- nameplate | interior | video | other
    mime_type     TEXT NOT NULL,
    size_bytes    BIGINT,
    filename      TEXT,
    checksum      TEXT,
    -- Postgres holds the pointer; object storage holds the bytes.
    storage_key_raw        TEXT,
    storage_key_normalized TEXT,
    storage_key_thumb      TEXT,
    status        TEXT NOT NULL DEFAULT 'awaiting_upload',
    width         INTEGER,
    height        INTEGER,
    duration_sec  NUMERIC,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assets_case ON assets (case_id);

-- Queue + retry ledger + idempotency key + permanent result store.
CREATE TABLE IF NOT EXISTS stage_runs (
    stage_run_id  TEXT PRIMARY KEY,
    case_id       TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
    stage         TEXT NOT NULL,              -- preprocess|identify|diagnose|parts|instruct
    status        TEXT NOT NULL DEFAULT 'queued',
    -- Hash of this stage's actual inputs. Same hash means the stored output is
    -- still valid, so we skip the call instead of paying for it again.
    input_hash    TEXT,
    output        JSONB,
    usage         JSONB NOT NULL DEFAULT '{}'::jsonb,
    error         TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    -- Lease timestamp. A row stuck in 'running' past a timeout is reclaimable,
    -- which is what keeps a process restart from stranding work forever.
    claimed_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    UNIQUE (case_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_stage_runs_claimable
    ON stage_runs (status, claimed_at);

-- Append-only progress log. The SSE endpoint replays from here, so a client
-- reconnect reads rows instead of re-running a multi-minute AI pipeline.
CREATE TABLE IF NOT EXISTS pipeline_events (
    id        BIGSERIAL PRIMARY KEY,
    case_id   TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
    seq       INTEGER NOT NULL,
    type      TEXT NOT NULL,
    payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
    ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (case_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_case_seq ON pipeline_events (case_id, seq);
