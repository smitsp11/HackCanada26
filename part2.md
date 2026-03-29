**OPERA**

Multimodal Understanding Layer

_Final Vision, Goal & Technical Plan_

**✓ Feasibility Verdict: Feasible - Strong Foundation, Phased Scope**

The current codebase already has case/asset ingestion, preprocessing (sharp, ffmpeg, frame extraction), OCR (lib/ocr.ts), product lookup (lib/lookup-product.ts), and Gemini-based identification. What is missing is a formal observation schema, fusion engine, confidence ranking, explicit fallback identity levels, and persisted structured output. This plan sequences those additions across three phases without disrupting the existing pipeline.

# **1\. Purpose of This Layer**

The multimodal understanding layer converts uploaded images, video frames, and text into structured, machine-readable appliance intelligence. It sits between the ingestion layer and the retrieval/reasoning layer, consuming normalized assets and producing a confidence-scored, evidence-backed interpretation of appliance identity and observed problem signals.

This layer does not produce a final repair answer. Its output is a ranked candidate set - appliance type, brand, model, error codes, and symptom tags - that makes downstream RAG and solution planning robust regardless of how much information the user provided.

**Design Constraint**

The multimodal understanding layer produces structured evidence packages. It does not reason about repair. Reasoning begins only after this layer has emitted its final output and the case has been handed to the retrieval and synthesis pipeline.

# **2\. Final Goal Statement**

**Goal**

_Build a multimodal analysis system - layered on top of the existing ingestion and preprocessing pipeline - that fuses image, video frame, OCR, and natural language signals to classify appliance type, detect brand and model evidence, extract structured identifiers, interpret user-described symptoms, aggregate all signals into a confidence-scored observation set, rank appliance identity candidates, determine a resolution level, and emit a structured understanding output that downstream retrieval and repair synthesis can consume directly. When exact identification fails, the system must degrade gracefully through a defined fallback hierarchy rather than failing or hallucinating._

# **3\. Current Codebase Inventory vs. Required Layer**

The feasibility check establishes a clear boundary between what already exists and what must be built. The table below is the authoritative gap analysis.

| **Existing Module**        | **What It Provides**                    | **What Is Missing**                                                |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| **lib/ocr.ts**             | OCR extraction exists                   | Not region-specialized; no label/display/panel passes              |
| **lib/parse-product.ts**   | Entity parsing exists                   | No formal observation schema with evidence IDs                     |
| **lib/lookup-product.ts**  | Product catalog lookup exists           | No fuzzy match, alias normalization, or family-level fallback      |
| **lib/identify-gemini.ts** | Gemini device ID exists                 | Single-call, no structured confidence scoring or candidate ranking |
| **lib/preprocessing.ts**   | Frame extraction + metadata exists      | No frame scoring, no multi-frame aggregation                       |
| **scripts/migrate.ts**     | cases/assets/jobs tables exist          | No observations, identity_candidates, or case_understanding tables |
| **events/route.ts SSE**    | Identification stage in pipeline exists | No explicit understanding stage or understanding SSE event type    |
| **-**                      | Appliance type classifier               | Missing - currently Gemini hint only                               |
| **-**                      | Logo/brand region detector              | Missing entirely                                                   |
| **-**                      | Symptom taxonomy extractor              | Missing - text used as freeform only                               |
| **-**                      | Evidence fusion engine                  | Missing - currently procedural ad hoc logic                        |
| **-**                      | Confidence ranking + fallback levels    | Missing - no explicit resolution levels                            |

# **4\. Phased Rollout**

Phases map directly to the feasibility tiers established in the feasibility check.

| **Phase**   | **Scope**                                                                                                                                                                        | **Feasibility**                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Phase 1** | Rule-based fusion, Gemini structured extraction, OCR entity normalization, explicit fallback levels, new DB tables, POST /understand endpoint, understanding SSE event type.     | High - builds on existing modules with no architectural changes.                    |
| **Phase 2** | Region-specific OCR passes (label / display / panel), symptom taxonomy extractor, multi-frame video aggregation, candidate ranking improvements, perceptual duplicate detection. | Medium - new processing modules, reuses existing preprocessing outputs.             |
| **Phase 3** | Custom CV detectors (logo, appliance type, panel-layout similarity), calibrated confidence with labeled data, learned fusion/ranking model, audio anomaly detection.             | Higher effort - requires training data, custom model pipeline, eval infrastructure. |

# **5\. Target Output Schema**

The structured output of this layer is the contract consumed by downstream retrieval and repair synthesis. It must be emitted regardless of how much information was available - with fallback_status reflecting the resolution level achieved.

{

"case_id": "case_123",

"appliance_type": {

"top_prediction": "dishwasher",

"confidence": 0.96,

"alternatives": \[{ "label": "washer", "confidence": 0.02 }\]

},

"brand_candidates": \[{

"brand": "Bosch", "confidence": 0.92,

"evidence": \["logo_detection", "ocr_text_match"\]

}\],

"model_candidates": \[

{ "model": "SHEM63W55N", "confidence": 0.81, "rank": 1, "evidence": \["obs_11","obs_15"\] },

{ "model": "SHXM63W55N", "confidence": 0.43, "rank": 2, "evidence": \["obs_11"\] }

\],

"error_codes": \[{ "value": "E24", "confidence": 0.94, "source": "display_ocr" }\],

"symptoms": \[

{ "tag": "not_draining", "confidence": 0.91, "source": "text_parse" },

{ "tag": "standing_water", "confidence": 0.79, "source": "text_parse" }

\],

"fallback_status": {

"resolved_identity_level": "series_level",

"exact_model_resolved": false,

"recommended_retrieval_scope": \["brand", "appliance_type", "error_code", "symptoms"\]

}

}

# **6\. Functional Goals**

The multimodal understanding layer must:

- Classify appliance category from one or more images or video frames, using multi-image score aggregation.
- Detect visible brand/logo evidence from front panels, badges, stickers, and control panel typography.
- Run OCR on model plates, serial stickers, LED/LCD displays, and control panel text - with region-specific preprocessing passes in Phase 2.
- Extract and normalize structured identifiers: brand, model number, serial number, error code, SKU, revision suffix.
- Apply domain-aware post-processing: regex templates, catalog lookup, OCR substitution correction (e.g. O/0, I/1 confusion).
- Parse user text into structured symptom tags using a canonical symptom taxonomy (e.g. not_draining, grinding_noise, no_power).
- Emit all extracted signals as typed observations in a shared evidence schema with asset_id, region, confidence, and source.
- Fuse evidence across modalities: aggregate corroborating signals, penalize contradictions, resolve brand/model conflicts.
- Score confidence for appliance type, brand, model, error code, and each symptom tag separately.
- Rank model candidates by weighted evidence score.
- Determine resolution level: exact model, series/family, brand + appliance type, or appliance type only.
- Emit a fallback_status object with resolution level and recommended_retrieval_scope for downstream use.
- Persist raw observations, ranked candidates, and final fused output to the database.
- Integrate with the existing SSE pipeline as a new understanding stage event before diagnosis begins.

# **7\. Module Decomposition**

All new modules live under backendv2/lib/multimodal/. Each module has a single responsibility and emits observations in the shared evidence schema.

| **Module**              | **Responsibility**                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **classify.ts**         | Appliance type inference from images and frames. Multi-image score aggregation. Fuses vision result with text hint.                                                   |
| **ocr-regions.ts**      | Region proposal (label, display, panel) and region-specific OCR preprocessing passes. Wraps existing lib/ocr.ts.                                                      |
| **extract-entities.ts** | Brand, model, serial, error code normalization. Regex templates, catalog lookup, OCR substitution correction. Extends lib/parse-product.ts and lib/lookup-product.ts. |
| **symptom-nlp.ts**      | Text symptom extraction against canonical taxonomy. Maps freeform phrases to structured symptom tags with confidence.                                                 |
| **fusion.ts**           | Evidence aggregation. Groups by field, scores corroboration, penalizes contradiction, promotes consistent candidates.                                                 |
| **rank.ts**             | Candidate ranking. Weighted score across OCR quality, catalog match, brand consistency, visual similarity, cross-modal agreement, minus ambiguity penalty.            |

# **8\. New API Endpoint**

### **POST /api/cases/{caseId}/understand**

Consumes normalized assets and text from ingestion. Runs the full understanding pipeline. Persists observations, candidates, and final output. Returns the structured understanding result.

// Request (auto-populated from case record, no body required)

POST /api/cases/{caseId}/understand

// Response

{

"case_id": "case_123",

"understanding_id": "und_456",

"status": "complete",

"appliance_type": { ... },

"brand_candidates": \[ ... \],

"model_candidates": \[ ... \],

"error_codes": \[ ... \],

"symptoms": \[ ... \],

"fallback_status": { ... }

}

The SSE events/route.ts is extended with a new understanding stage before diagnosis begins:

// New SSE event types added to lib/events.ts

{ type: "understanding_start" }

{ type: "understanding_progress", payload: { stage: "ocr" | "classify" | "fusion" | "rank" } }

{ type: "understanding_complete", payload: UnderstandingOutput }

# **9\. New Database Tables**

### **observations - raw evidence from each submodule**

observation_id TEXT PRIMARY KEY

case_id TEXT REFERENCES cases(case_id)

asset_id TEXT REFERENCES assets(asset_id) -- nullable for text sources

source_type TEXT -- ocr | logo_detector | classifier | text_parse | gemini

field TEXT -- appliance_type | brand | model | error_code | symptom

value TEXT

confidence FLOAT

region_type TEXT -- model_plate | display | panel | label | null

metadata JSONB -- raw detector boxes, OCR region coords, etc.

created_at TIMESTAMPTZ

### **identity_candidates - ranked brand and model candidates**

candidate_id TEXT PRIMARY KEY

case_id TEXT REFERENCES cases(case_id)

candidate_type TEXT -- brand | model | appliance_type | error_code | symptom

value TEXT

rank INT

confidence FLOAT

supporting_obs_ids TEXT\[\] -- observation_id references

created_at TIMESTAMPTZ

### **case_understanding - final fused output per case**

understanding_id TEXT PRIMARY KEY

case_id TEXT REFERENCES cases(case_id)

appliance_type_json JSONB

brand_candidates_json JSONB

model_candidates_json JSONB

error_codes_json JSONB

symptoms_json JSONB

fallback_status_json JSONB

resolved_identity_level TEXT -- exact | series | brand_plus_type | type_only

created_at TIMESTAMPTZ

# **10\. Intermediate Schemas**

### **Observation - shared evidence format emitted by every submodule**

{

"observation_id": "obs_01",

"source_type": "ocr",

"asset_id": "asset_003",

"field": "model_number",

"value": "SHEM63W55N",

"confidence": 0.91,

"region_type": "model_plate",

"metadata": { "raw_text": "SHEM63W55N/2O", "correction_applied": true }

}

### **Candidate - fusion output per brand/model**

{

"candidate_type": "model",

"value": "SHEM63W55N",

"rank": 1,

"confidence": 0.81,

"supporting_observations": \["obs_11", "obs_15"\]

}

# **11\. Confidence Scoring & Fallback Hierarchy**

### **Confidence bands**

| **Band**        | **Operational Meaning**                                         |
| --------------- | --------------------------------------------------------------- |
| **0.90 - 1.00** | High confidence exact match - proceed with exact retrieval      |
| **0.70 - 0.89** | Probable match - proceed, flag as probable                      |
| **0.40 - 0.69** | Weak candidate - broaden retrieval scope to series/family       |
| **< 0.40**      | Insufficient - fall back to brand + appliance type or type only |

### **Fallback resolution hierarchy**

- Attempt exact model match via OCR + catalog lookup.
- If confidence < 0.70, resolve to product series/family.
- If series uncertain, resolve to brand + appliance type.
- If brand uncertain, resolve to appliance type only.
- Emit fallback_status with resolved_identity_level and recommended_retrieval_scope at every level.

A case that cannot determine Bosch SHEM63W55N vs SHXM63W55N can still retrieve Bosch dishwasher E24 troubleshooting and Bosch 500 Series drain guidance - the system never fails completely.

# **12\. End-to-End Processing Flow**

- Receive normalized images, frames, and text from ingestion (storage_uri_normalized, frames/, asset_metadata).
- Score and select best frames from video extractions for classification and OCR.
- Run appliance type classifier on selected images and frames; aggregate scores across inputs.
- Detect logo and brand regions; run OCR on detected regions and known label areas.
- Run region-specific OCR passes on model plate, display, and panel areas.
- Parse OCR output through entity normalization: regex templates, catalog lookup, OCR substitution correction.
- Parse user symptom text through taxonomy extractor; map to canonical symptom tags.
- Emit all extracted signals as typed observations (persisted to observations table).
- Fuse observations: group by field, score corroboration, penalize contradiction, resolve conflicts.
- Rank brand and model candidates by weighted evidence score.
- Determine resolution level; construct fallback_status.
- Persist ranked candidates (identity_candidates) and final output (case_understanding).
- Emit understanding_complete SSE event; advance case to ready_for_diagnosis.

# **13\. Integration With Existing Pipeline**

The understanding layer inserts as a new stage in the SSE event pipeline at backendv2/app/api/cases/\[caseId\]/events/route.ts, before the existing diagnosis and synthesis stages.

// Existing pipeline order

slot_processing → slot_complete → device_identified → manual_found →

symptom_sections_found → parts_check_complete → synthesis_progress → synthesis_complete

// Updated pipeline order (Phase 1)

slot_processing → slot_complete →

understanding_start → understanding_progress (ocr/classify/fusion/rank) →

understanding_complete →

device_identified → manual_found → symptom_sections_found →

parts_check_complete → synthesis_progress → synthesis_complete

The existing identifyWithGemini call in the SSE route is augmented to consume the understanding output rather than re-running identification from scratch. In Phase 1, Gemini serves as a structured-extraction fallback within the understanding pipeline itself (via classify.ts and extract-entities.ts).

# **14\. Key Technical Risks**

| **Risk**                          | **Mitigation**                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OCR noise on model numbers**    | Model number suffix characters are OCR-error prone (O/0, I/1, S/5). Catalog lookup + regex correction is the primary mitigation; confidence must reflect correction uncertainty. |
| **Overconfident candidates**      | Raw neural model scores are often overconfident. Confidence bands must be validated against real cases before being exposed to downstream retrieval logic.                       |
| **Near-identical model variants** | Appliance series often differ by one or two suffix characters. The ranking system must surface both candidates rather than picking one blindly.                                  |
| **Incomplete product catalog**    | If lib/lookup-product.ts has sparse coverage, exact model ranking degrades. The fallback hierarchy is the primary mitigation - the system must degrade gracefully, not silently. |
| **Cross-modal conflict**          | Text may say washer while images show a dishwasher. The fusion layer must represent this conflict explicitly in confidence rather than silently resolving it.                    |
| **SSE latency budget**            | Adding an understanding stage increases time-to-first-synthesis-event. Each submodule must be profiled; Gemini calls must be parallelized where possible.                        |

# **15\. Key Decisions to Lock Before Building**

- Which appliance type taxonomy to use as the canonical class list (determines classifier output space and downstream retrieval indexing).
- Which symptom taxonomy to canonicalize first - defines the NLP extractor contract and retrieval tag vocabulary.
- Whether Phase 1 Gemini structured extraction uses a single multi-modal prompt or chained calls per submodule - affects latency budget and token cost.
- Whether the understanding endpoint is called explicitly (POST /understand) or triggered automatically on case status reaching ready_for_analysis.
- Whether confidence bands are hard-coded thresholds for Phase 1 or configurable per deployment.
- Catalog coverage scope for Phase 1 - which brands and model families are supported at launch.
- Whether partial understanding is allowed - can a case proceed to retrieval if only appliance type and symptom tags were resolved, with no model candidate?

# **Summary**

**Net Assessment**

High feasibility for Phase 1. The existing codebase provides OCR, preprocessing, Gemini identification, and a case/asset pipeline that maps directly onto the proposed architecture. What is added is structure: a formal observation schema, a fusion engine, confidence scoring, explicit fallback levels, three new DB tables, and one new endpoint. No existing routes are broken. The understanding stage slots cleanly into the SSE pipeline before diagnosis.

**Phase 1 MVP Scope**

New module group backendv2/lib/multimodal/ (classify, ocr-regions, extract-entities, symptom-nlp, fusion, rank). New endpoint POST /api/cases/{id}/understand. Three new DB tables (observations, identity_candidates, case_understanding). New SSE event types (understanding_start, understanding_progress, understanding_complete). Gemini structured extraction as Phase 1 inference backend across all submodules. Rule-based fusion. Explicit fallback hierarchy. This is enough to produce a structured, confidence-scored output that makes downstream retrieval and repair synthesis substantially more robust.