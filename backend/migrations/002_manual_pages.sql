-- Opera AI backend - page-level retrieval index.
--
-- The unit of retrieval is the manual PAGE, not an arbitrary text chunk:
-- every downstream stage cites page numbers, verify.py checks quotes per page,
-- and diagnose reads the pages as rendered images (flowcharts and status-code
-- tables are pixels, not text). A chunk that straddles two pages, or loses its
-- page number, silently breaks all of that.
--
-- Search is always scoped to one manual_id. Retrieving a status-code table from
-- a different model is a confident wrong answer, which is worse than none.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS manual_pages (
    manual_id     TEXT NOT NULL REFERENCES manuals(manual_id) ON DELETE CASCADE,
    page          INTEGER NOT NULL,
    -- pypdf text with the running header stripped.
    text          TEXT NOT NULL DEFAULT '',
    -- Model-written, from the rendered page. For diagram-only pages (the
    -- troubleshooting flowcharts) this is the only searchable content.
    summary       TEXT NOT NULL DEFAULT '',
    visual_description TEXT NOT NULL DEFAULT '',
    -- Structured facts pulled at ingestion. `status_codes` makes a displayed
    -- code an exact lookup instead of a similarity guess.
    status_codes  TEXT[] NOT NULL DEFAULT '{}',
    components    TEXT[] NOT NULL DEFAULT '{}',
    image_heavy   BOOLEAN NOT NULL DEFAULT FALSE,
    fts           TSVECTOR GENERATED ALWAYS AS (
                      setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
                      setweight(to_tsvector('english', coalesce(visual_description, '')), 'A') ||
                      setweight(to_tsvector('english', coalesce(text, '')), 'B')
                  ) STORED,
    embedding     VECTOR(1536),
    -- Re-embedding is required whenever this changes; mixed models in one
    -- index return garbage distances.
    embedding_model TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (manual_id, page)
);

CREATE INDEX IF NOT EXISTS idx_manual_pages_fts ON manual_pages USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_manual_pages_codes ON manual_pages USING GIN (status_codes);
-- No ANN index: a manual is ~75 rows and the manual_id filter runs first, so an
-- exact scan is faster and exact. Add HNSW when a single filter returns thousands.

-- Hybrid search: full-text and vector rankings fused with Reciprocal Rank
-- Fusion in one round trip. RRF uses ranks, not scores, so ts_rank and cosine
-- distance never have to be put on the same scale.
--
-- The text query is OR-ed rather than AND-ed: a symptom sentence AND-ed
-- together matches almost nothing.
CREATE OR REPLACE FUNCTION match_manual_pages(
    p_manual_id TEXT,
    p_query     TEXT,
    p_embedding VECTOR(1536),
    p_count     INTEGER DEFAULT 8,
    p_rrf_k     INTEGER DEFAULT 60
)
RETURNS TABLE (page INTEGER, score DOUBLE PRECISION, fts_rank BIGINT, vec_rank BIGINT)
LANGUAGE sql STABLE
AS $$
WITH q AS (
    SELECT to_tsquery(
               'english',
               NULLIF(replace(plainto_tsquery('english', p_query)::text, ' & ', ' | '), '')
           ) AS tsq
),
full_text AS (
    SELECT mp.page,
           row_number() OVER (ORDER BY ts_rank_cd(mp.fts, q.tsq) DESC) AS rank_ix
      FROM manual_pages mp, q
     WHERE mp.manual_id = p_manual_id
       AND q.tsq IS NOT NULL
       AND mp.fts @@ q.tsq
     ORDER BY rank_ix
     LIMIT p_count * 3
),
semantic AS (
    SELECT mp.page,
           row_number() OVER (ORDER BY mp.embedding <=> p_embedding) AS rank_ix
      FROM manual_pages mp
     WHERE mp.manual_id = p_manual_id
       AND mp.embedding IS NOT NULL
     ORDER BY rank_ix
     LIMIT p_count * 3
)
SELECT coalesce(f.page, s.page) AS page,
       coalesce(1.0 / (p_rrf_k + f.rank_ix), 0.0) +
       coalesce(1.0 / (p_rrf_k + s.rank_ix), 0.0) AS score,
       f.rank_ix AS fts_rank,
       s.rank_ix AS vec_rank
  FROM full_text f
  FULL OUTER JOIN semantic s ON f.page = s.page
 ORDER BY score DESC
 LIMIT p_count;
$$;
