**OPERA**

Input Ingestion Layer

_Final Vision, Goal & Technical Plan_

**✓ Feasibility Verdict: High - No Major Frontend Rewrite Required**

The existing frontend already supports media capture/upload, text submission, async SSE pipeline updates, and progressive states. The ingestion architecture is sound. Rollout is sequenced to align with what the current repo already does well: UI contract upgrade first, proper ingestion second, production hardening third.

# **1\. Purpose of This Layer**

The input ingestion layer is the system entry point for all user-submitted appliance data. Its job is to reliably accept uploads, validate and normalize them, extract useful metadata, and prepare them for downstream multimodal analysis.

This layer does not solve the appliance problem itself. Its purpose is to produce a clean, secure, traceable, machine-ready input package for downstream services: OCR, model identification, retrieval, and troubleshooting generation.

**Design Constraint**

The ingestion layer produces packages - it does not reason about them. Reasoning begins only after a case is marked ready_for_analysis.

# **2\. Final Goal Statement**

**Goal**

_Design and build a backend ingestion system that accepts images, videos, and textual descriptions about a home appliance; validates and standardizes all inputs; attaches session, user, and case context; extracts low-level file metadata; and stores everything in a structured, traceable format for downstream multimodal processing - integrated with the existing frontend upload and SSE pipeline through an explicit case_id / asset_id / job_id contract._

# **3\. Frontend Connection Points & Gaps**

The current frontend already provides strong anchors for the ingestion contract. The table below maps what exists to what must be added.

| **What Already Exists**                               | **Ingestion Contract Needed**                                                 | **Change Required**                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| Media upload flow (Cloudinary direct widget)          | Backend-issued signed upload URL + asset_id returned                          | Replace widget with signed URL flow in Phase B          |
| sessionStorage payload: { urls, symptom }             | case_id + asset_ids + text payload                                            | Replace sessionStorage with case_id in Phase A          |
| SSE: /api/diagnose?urls=…                             | SSE: /api/cases/{case_id}/events                                              | Update SSE source URL in Phase A                        |
| Progress states: ingesting → analyzing → synthesizing | Backend statuses: uploading → validating → preprocessing → ready_for_analysis | Map existing visual phases to backend status in Phase A |
| Product identification: POST /api/identify-product    | makeModel stored as case metadata server-side                                 | Pass case_id into identify call in Phase A              |
| No case/asset/job model                               | Explicit case_id, asset_id, job_id on every request                           | Core addition across all phases                         |

# **4\. Adjusted Rollout - Three Phases**

The architecture is correct and unchanged. Only the sequencing is adjusted: establish the UI contract before building full backend infrastructure, to avoid stalling on backend complexity.

| **Phase**   | **Scope**                                                                                                                                                                                                   | **Frontend Contract Change**                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Phase A** | UI Contract Upgrade: POST /cases, POST /cases/{id}/input, return case_id + asset_ids to frontend, keep Cloudinary upload, update SSE source to /api/cases/{id}/events, replace sessionStorage with case_id. | Replace sessionStorage. Update SSE URL. Map visual phases to backend status codes. Minimal UI change. |
| **Phase B** | Proper Ingestion: POST /cases/{id}/assets/register + /complete, async validation and preprocessing, real case status endpoint, backend-issued signed upload URLs, job tracking.                             | Wire upload flow to signed URLs. Show real preprocessing states from backend.                         |
| **Phase C** | Production Hardening: malware scanning, retry orchestration, deduplication, quota management, retention controls, observability, audit logging.                                                             | No additional frontend changes expected. Infra and ops layer only.                                    |

# **5\. Ingestion Data Flow**

The flow separates fast synchronous operations from heavy asynchronous work to prevent upload APIs from timing out.

- Client calls POST /cases - backend returns case_id and upload instructions.
- Client uploads image/video assets (Cloudinary in Phase A; signed URLs from Phase B onward).
- Client calls POST /cases/{case_id}/assets/complete for each uploaded asset (Phase B).
- Client calls POST /cases/{case_id}/input to submit text description and structured metadata.
- Backend validates each file: MIME type, magic bytes, size, duration, decoder parse, and content safety.
- Backend stores raw assets in object storage under raw/{case_id}/{asset_id}/.
- Backend enqueues preprocessing jobs: transcode, thumbnail, frame extract, metadata parse, quality score.
- Preprocessing workers produce normalized derivatives and extracted metadata.
- Ingestion layer marks case ready_for_analysis and emits a case.ready_for_multimodal_analysis event.
- Frontend SSE stream /api/cases/{case_id}/events reflects each state transition in real time.

**Sync vs. Async Boundary**

Steps 1-4 are synchronous: authentication, case creation, upload token issuance, metadata receipt, registration. Steps 5-10 are asynchronous: virus scan, transcode, thumbnail, frame extraction, EXIF parse, quality analysis, OCR candidate detection, normalized asset creation.

# **6\. Functional Goals**

The ingestion layer must:

- Accept image files (JPEG, PNG, WEBP, HEIC) and video files (MP4, MOV, WebM).
- Accept text descriptions, error codes, symptom tags, and typed appliance metadata.
- Accept optional structured metadata: brand, model, serial, age, error code, urgency, region.
- Validate file type via MIME header and magic bytes - not filename extension alone.
- Enforce hard size limits: images ≤ 20 MB, videos ≤ 500 MB, text ≤ 20 000 characters.
- Enforce video duration limits (≤ 2 minutes for MVP).
- Detect corruption by attempting decode and stream probe.
- Scan for malicious content (antivirus, zip bomb protection).
- Detect exact duplicates via SHA-256; optionally perceptual hash for images.
- Preprocess images: auto-rotate, strip dangerous EXIF, generate normalized + OCR + thumbnail derivatives.
- Preprocess video: transcode to H.264/MP4, extract frames at fixed interval, generate poster thumbnail.
- Extract technical metadata: dimensions, duration, codec, frame rate, orientation, bitrate.
- Run lightweight text parsing: extract brand candidates, error codes, appliance type hints, symptom tags.
- Associate all assets with a case_id, asset_id, and job_id.
- Emit a ready-for-analysis event upon successful ingestion of all valid inputs.
- Allow partial case success: a case may proceed if at least one image and text are valid, even if one asset fails.

# **7\. Non-Functional Goals**

| **Property**       | **Requirement**                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Secure**         | Authenticated uploads, signed URLs, MIME + magic-byte validation, malware scan, size/rate limits, encryption at rest and in transit, strict access control, audit logs.                  |
| **Scalable**       | Async preprocessing workers handle concurrent uploads independently of the API tier.                                                                                                     |
| **Fault tolerant** | Resumable uploads (Phase B), separate raw-upload success from preprocessing success, automatic retry for transient failures, explicit permanent-failure codes.                           |
| **Observable**     | Structured logs on every upload and preprocessing event, tagged with request_id / user_id / case_id / asset_id / job_id. Track upload rate, latency, per-format failure rate, queue lag. |
| **Traceable**      | Every asset maps to a request, user, case, and job ID. No orphaned objects in storage.                                                                                                   |
| **Idempotent**     | Repeated upload requests do not create duplicate assets or inconsistent case state. SHA-256 hash guards exact duplicates.                                                                |
| **Extensible**     | New media types added without changes to case/job model or downstream contracts.                                                                                                         |
| **Privacy-safe**   | EXIF GPS stripped. No retention of raw uploads beyond policy window. Secure deletion path defined.                                                                                       |

# **8\. Core Internal Objects**

Four objects form the backbone of the ingestion model.

### **Case - one appliance issue or support thread**

{

"case_id": "case_123",

"user_id": "user_456",

"status": "ingestion_in_progress",

"appliance_type_hint": "dishwasher",

"created_at": "2026-03-29T15:10:00Z"

}

### **Asset - each uploaded file**

{

"asset_id": "asset_img_001",

"case_id": "case_123",

"asset_type": "image",

"storage_uri": "s3://bucket/raw/case_123/front.jpg",

"mime_type": "image/jpeg",

"upload_status": "uploaded",

"validation_status": "pending"

}

### **Input Payload - text and structured metadata**

{

"case_id": "case_123",

"description": "Dishwasher shows E24 and will not drain.",

"metadata": {

"brand": "Bosch",

"error_code": "E24",

"approximate_age_years": 5

}

}

### **Processing Job - tracks async work**

{

"job_id": "job_ingest_001",

"case_id": "case_123",

"job_type": "media_preprocessing",

"status": "queued"

}

# **9\. API Design**

### **POST /cases - create a new case**

Initialize an appliance issue case and return the identifiers needed for asset association.

// Request

{ "appliance_type_hint": "dishwasher" }

// Response

{ "case_id": "case_123", "status": "created" }

### **POST /cases/{case_id}/assets/register - declare a file before upload**

// Request

{

"filename": "panel.jpg",

"mime_type": "image/jpeg",

"asset_type": "image",

"size_bytes": 2849382

}

// Response

{

"asset_id": "asset_001",

"upload_url": "<https://storage.example.com/signed/>...",

"expires_at": "2026-03-29T15:20:00Z"

}

### **POST /cases/{case_id}/assets/{asset_id}/complete - confirm upload finished**

Triggers server-side validation and enqueues preprocessing jobs for this asset.

### **POST /cases/{case_id}/input - submit text and metadata**

{

"description": "The dishwasher is not draining and shows E24.",

"metadata": {

"brand": "Bosch",

"error_code": "E24",

"serial_number": "SN12345"

}

}

### **GET /cases/{case_id} - poll case and asset status**

Returns current case status and per-asset validation and processing state. Also drives the SSE stream at /api/cases/{case_id}/events.

# **10\. State Machines**

### **Case lifecycle**

| **Status**               | **Description**                           | **Next Step**                      |
| ------------------------ | ----------------------------------------- | ---------------------------------- |
| **created**              | Case initialized, awaiting uploads        | Client begins uploading assets     |
| **awaiting_upload**      | Upload instructions issued                | Client uploads files               |
| **uploading**            | Assets in flight                          | Wait for completion notifications  |
| **validating**           | Files being scanned and checked           | Async workers processing           |
| **preprocessing**        | Normalization and extraction in progress  | Async workers active               |
| **ready_for_analysis**   | All valid inputs normalized               | Downstream pipeline starts         |
| **failed_validation**    | One or more assets failed hard validation | Client notified; retry or resubmit |
| **preprocessing_failed** | Normalization error on one or more assets | Retry or mark partial case         |

### **Per-asset lifecycle**

registered → uploaded → scan_pending → validated → normalized → metadata_extracted → ready

# **11\. File Validation**

- File type: check MIME header, magic bytes, and decoder-level parse - never trust filename extension alone.
- Size limits: images ≤ 20 MB, videos ≤ 500 MB, text ≤ 20 000 characters.
- Video duration: ≤ 2 minutes for MVP; checked via ffprobe stream probe.
- Resolution: reject or downscale images above practical threshold; reject videos above 4K unless required.
- Corruption: image decode test via Pillow/libvips; video stream probe via ffprobe.
- Malware: antivirus scan (ClamAV or equivalent); zip bomb protection if archives are ever permitted.
- Duplicate detection: SHA-256 hash for exact duplicates; perceptual hash for visually similar images (Phase B).

# **12\. Media Preprocessing**

### **Image pipeline**

- Decode, auto-rotate from EXIF, strip dangerous metadata.
- Preserve original raw file separately.
- Generate: normalized display image, OCR-optimized derivative, thumbnail.
- Detect blur and exposure quality for routing signal.

"derivatives": {

"raw": "s3://.../raw/front.heic",

"normalized": "s3://.../normalized/front.jpg",

"ocr_variant":"s3://.../derived/front_ocr.jpg",

"thumbnail": "s3://.../thumb/front_256.jpg"

}

### **Video pipeline**

- Inspect container with ffprobe; transcode to H.264/MP4 if required.
- Extract frames at fixed interval (e.g., every 1 second) for MVP; keyframe-based in Phase B.
- Generate poster thumbnail, preview clip, and extracted audio track.
- Produce normalized video, frame sequence, key frames, and extracted metadata.

### **Text normalization**

- Trim whitespace, standardize to UTF-8, remove harmful control characters.
- Run lightweight parser to extract: brand candidates, error codes, appliance type hints, symptom tags.

// Input: "my bosch dishwasher says e24 and there's standing water"

{

"brand_candidates": \["Bosch"\],

"appliance_type": \["dishwasher"\],

"error_codes": \["E24"\],

"symptom_tags": \["not_draining", "standing_water"\]

}

# **13\. Persistence Design**

### **Object storage layout**

raw/{case_id}/{asset_id}/...

normalized/{case_id}/{asset_id}/...

frames/{case_id}/{asset_id}/...

thumbs/{case_id}/{asset_id}/...

### **Relational database - key tables**

- cases: case_id, user_id, status, appliance_type_hint, description_raw, description_normalized, created_at, updated_at
- assets: asset_id, case_id, asset_type, original_filename, mime_type, size_bytes, checksum_sha256, storage_uri_raw, storage_uri_normalized, validation_status, processing_status, created_at
- asset_metadata: asset_id, width, height, duration_sec, codec, frame_rate, orientation, exif_json, derived_metadata_json
- jobs: job_id, case_id, asset_id (nullable), job_type, status, retry_count, error_code, error_message, created_at, completed_at

### **Queue / message broker**

Async jobs dispatched per-asset: media_preprocessing, antivirus_scan, thumbnail_generation, frame_extraction, metadata_extraction. Use SQS / RabbitMQ / Kafka depending on scale. Message includes case_id, asset_id, job_id, and storage URI.

# **14\. Error Handling & Retries**

The ingestion layer must assume uploads fail often. Common failures: interrupted upload, invalid format, transcode timeout, corrupted media, antivirus failure, metadata parse error, queue delivery failure.

- Separate raw upload success from preprocessing success.
- Machine-readable error codes on every failure (e.g., ERR_MIME_MISMATCH, ERR_SIZE_EXCEEDED, ERR_DECODE_FAILED).
- Automatic retry for transient failures (configurable backoff).
- Explicit permanent-failure marking; do not retry indefinitely.
- Allow partial case success: a case with 2 of 3 valid assets may still proceed.
- Resumable uploads (Phase B): preserve partial progress across network interruptions.

# **15\. Security Requirements**

- All upload requests must be authenticated.
- Upload URLs must be backend-issued and signed with short expiry.
- MIME type and magic-byte validation on every file.
- Malware scan before any preprocessing or storage promotion.
- Strict file size and upload rate limits per user/session.
- All stored files encrypted at rest; all transfers encrypted in transit.
- Strict access control: assets readable only by owning user and authorized backend services.
- Full audit log for every upload, validation, and preprocessing event.
- EXIF GPS coordinates stripped. Raw uploads subject to retention and secure deletion policy.

# **16\. Observability**

Every log entry must include: request_id, user_id, case_id, asset_id, job_id.

Track as metrics: upload success rate, average upload size, preprocessing latency, per-format failure rate, transcode failure rate, OCR-prep success rate, case completion rate, queue lag, storage usage growth.

# **17\. Technology Stack**

| **Layer**            | **Recommended Options**                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **API tier**         | FastAPI, Node.js/Express, or Go - REST initially                                            |
| **Object storage**   | S3 / GCS / Azure Blob - signed URL uploads from Phase B                                     |
| **Database**         | PostgreSQL for transactional records                                                        |
| **Queue**            | SQS / RabbitMQ / Kafka depending on scale                                                   |
| **Image processing** | Pillow, OpenCV, libvips                                                                     |
| **Video processing** | FFmpeg / ffprobe                                                                            |
| **Security scan**    | ClamAV or equivalent antivirus                                                              |
| **Infra**            | Containerized services on Kubernetes, ECS, or equivalent; background workers for async jobs |

# **18\. Key Technical Decisions to Lock Before Building**

The following must be explicitly decided before implementation begins:

- Direct-to-object-storage uploads via Cloudinary (Phase A) vs backend-issued signed URLs (Phase B) - sequencing confirmed.
- Max file sizes: images 20 MB, videos 500 MB for MVP.
- Accepted formats: JPEG, PNG, WEBP, HEIC for images; MP4, MOV, WebM for video. AVI normalized on ingest.
- Sync/async boundary: case creation + upload token = sync; validation + preprocessing = async.
- Resumable uploads: Phase B, not MVP.
- HEIC and MOV: accept at launch, transcode to JPEG/MP4 as part of normalization.
- Raw upload retention: define policy window and secure deletion path before Phase C.
- Partial ingestion: allowed - a case may proceed with a subset of valid assets.
- Case status representation: string enum (created / awaiting_upload / validating / preprocessing / ready_for_analysis / failed).
- Frame extraction strategy: fixed interval (every 1 second) for MVP; keyframe-based in Phase B.

# **Summary**

**Net Assessment**

High feasibility. No major frontend rewrite. Architecture is correct. Sequence the rollout: UI contract upgrade first (Phase A), proper ingestion infrastructure second (Phase B), production hardening third (Phase C). The ingestion layer will serve as a clean, secure, traceable entry point that produces structured case packages ready for downstream multimodal reasoning.

**MVP Recommendation**

Phase A MVP: direct Cloudinary upload, case_id + asset_id returned to frontend, sessionStorage replaced by case_id, SSE source updated to /api/cases/{id}/events, text + metadata via POST /cases/{id}/input. This is enough to support the rest of the platform without overengineering the first layer.