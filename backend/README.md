# Opera AI: backend

FastAPI service that turns appliance photos and a symptom into a diagnosis
grounded in the service manual, with a parts list and next steps. The
[project README](../README.md) covers the overall architecture, design
decisions and evaluation results. This file covers running and working on the
service.

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill it in; .env is gitignored
```

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | All model calls (Gemini 2.5 Pro / Flash / Flash-Lite, embeddings) |
| `DATABASE_URL` | Postgres with `pgvector`. On Supabase, use the session pooler URI |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET` | Private bucket for uploads, manuals and cached page text |
| `API_BEARER_TOKEN` | Shared secret the Next.js proxy sends. Generate it with `openssl rand -hex 32` |

```bash
python -m app.ingestion.cli migrate                     # apply migrations/*.sql
python -m app.ingestion.cli add manuals/opera-manual.pdf
python -m app.ingestion.cli index manuals/opera-manual.pdf   # only needed for retrieval
uvicorn app.main:app --reload --port 8000
curl localhost:8000/health | python3 -m json.tool
```

`/health` reports each dependency as `configured` (a value is present in
`.env`) and `reachable` (the service actually answered). A wrong
`DATABASE_URL` therefore shows up there instead of as a stack trace later.

## Ingesting a manual

`cli add` runs offline, once per manual. It is idempotent on the PDF's
sha256, and only a few pages go to the model. It:

1. Uploads the PDF to S3 and registers it in `manuals`.
2. Extracts the manufacturer's **service-scope statement** verbatim, with its
   page number. The safety gate quotes this statement.
3. Decodes the **model nomenclature** and size tables into `appliances` rows.
   `identify` validates plate reads against these rows.
4. Stores per-page text in S3. The citation verifier and parts checker read
   it, which saves 24 s of PDF extraction on every cold start.

`cli index` builds the retrieval index in `manual_pages`. For each page it
stores:
- the page text with running headers stripped;
- a vision-model summary and a description of any diagram on the page;
- the status codes and components the page covers;
- an embedding.

## API

Every `/api/cases` route requires `Authorization: Bearer $API_BEARER_TOKEN`.

| Route | |
|---|---|
| `POST /api/cases` | Create a case |
| `POST /api/cases/{id}/assets/register` | Get an asset id and a presigned S3 PUT URL |
| `POST /api/cases/{id}/assets/{asset_id}/complete` | Verify the uploaded object: magic bytes, size, checksum |
| `POST /api/cases/{id}/input` | Submit the symptom, optional code and brand/model hints |
| `POST /api/cases/{id}/run-async` | Start the pipeline. Refused if a run is already in flight |
| `GET  /api/cases/{id}/events?after=N` | SSE stream: replays stored events, then tails new ones |
| `GET  /api/cases/{id}/ui-events` | The same stream translated to the frontend's event vocabulary. It also starts the run |
| `GET  /api/cases/{id}` | The case, its assets (with signed URLs) and every stage's output and usage |
| `POST /api/cases/{id}/run` | Synchronous pipeline run, for scripts and tests |

Interactive docs are served at `/docs`.

## Configuration flags

Defaults reproduce the measured, best-accuracy behavior. Every flag is off
until the eval says otherwise.

| Setting | Default | Effect |
|---|---|---|
| `RETRIEVAL_ENABLED` | `false` | Diagnose reads only the top-k retrieved pages. Twice as fast, but citations are weaker for now (see the eval) |
| `RETRIEVAL_TOP_K` | `8` | Pages passed to diagnose when retrieval is on |
| `DIAGNOSE_MANUAL_VIA_URL` | `false` | Send a presigned URL instead of inlining the PDF |
| `DIAGNOSE_REASONING_EFFORT` | unset | `low` / `medium` / `high` reasoning budget. OpenRouter does not reliably honor it for Gemini Pro |
| `DIAGNOSE_TIMEOUT_S` | `300` | Must be well above the slowest normal diagnosis, because a timeout restarts the call from zero |
| `DIAGNOSE_MAX_TOKENS` | `24000` | Reasoning tokens count against this cap, so it must leave room for the answer |
| `MODEL_DIAGNOSE`, `MODEL_DEFAULT`, `MODEL_CHEAP` | Gemini 2.5 Pro / Flash / Flash-Lite | Model per stage group |

## Data model

| Table | Holds |
|---|---|
| `manuals` | One row per ingested PDF: S3 key, sha256, page count, scope statement and pages |
| `appliances` | The model catalog decoded from each manual, with hazard classes |
| `cases` | One diagnosis request: symptom, code, hints, status, resolved manual |
| `assets` | Uploaded files: role, MIME type, size, checksum, S3 key, upload status |
| `stage_runs` | Per-stage lease, attempt count, input hash, output and usage (tokens, cost, latency) |
| `pipeline_events` | An append-only event log per case, with a monotonic `seq`. SSE replays it |
| `manual_pages` | The page-level retrieval index: text, summaries, codes, `tsvector`, `vector(1536)` |

Hybrid search is a single SQL function, `match_manual_pages`. It runs
full-text and vector ranking and merges them with Reciprocal Rank Fusion in
one round trip.

## Tests

```bash
pytest -q                          # 145 tests, offline, uses recorded golden outputs
python -m tests.smoke              # real S3 + Postgres + one model call
python -m tests.e2e_frontend       # through the Next.js proxy (needs :3000 and :8000)
python -m tests.browser_e2e        # real UI in headless Chrome via Playwright
python -m tests.record             # re-record golden outputs (~$0.07/case)
```

## Evaluation

```bash
python -m app.eval.bench retrieval                 # hit@k, recall@k, MRR; no generation
python -m app.eval.bench diagnose --path full      # or --path retrieval
python -m app.eval.configs                         # latency/accuracy across diagnose setups
python -m app.eval.live_compare                    # the same case through two running backends
```

The test cases are in `eval/cases.json` and results are written to
`eval/results/`. A full `configs` run makes 96 diagnoses and costs about $5.

## Layout

```
app/
  main.py                FastAPI app, /health
  config.py              settings from .env
  schemas/contracts.py   the typed contract every stage and route codes against
  api/                   cases, assets (presigned uploads), events (SSE), ui_compat
  pipeline/
    runner.py            leased, idempotent, resumable stage execution
    safety.py            deterministic DIY/technician gate
    verify.py            citation verifier (VERIFIED / UNVERIFIABLE / NOT_FOUND)
    stages/              identify, retrieve, diagnose, parts, instruct
  core/                  db (asyncpg), storage (S3), llm (OpenRouter), pdf, manuals, embeddings
  ingestion/             cli (add/index/text/migrate/list), pages (retrieval index)
  eval/                  bench, configs, live_compare
migrations/              001 schema, 002 pgvector page index + hybrid search
eval/                    cases and recorded results
tests/                   unit, golden, integration, e2e, browser
manuals/, fixtures/      PDFs and test photos (gitignored)
```
