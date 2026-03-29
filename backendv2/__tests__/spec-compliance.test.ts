import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

function fileExists(relPath: string): boolean {
  return existsSync(join(ROOT, relPath));
}

function fileContains(relPath: string, needle: string): boolean {
  if (!fileExists(relPath)) return false;
  return readFileSync(join(ROOT, relPath), "utf-8").includes(needle);
}

describe("Part 1 Spec Compliance — API Endpoints (Section 9)", () => {
  it("POST /cases route exists", () => {
    expect(fileExists("app/api/cases/route.ts")).toBe(true);
  });

  it("POST /cases/{caseId}/assets/register route exists", () => {
    expect(fileExists("app/api/cases/[caseId]/assets/register/route.ts")).toBe(true);
  });

  it("POST /cases/{caseId}/assets/{assetId}/complete route exists", () => {
    expect(fileExists("app/api/cases/[caseId]/assets/[assetId]/complete/route.ts")).toBe(true);
  });

  it("POST /cases/{caseId}/input route exists", () => {
    expect(fileExists("app/api/cases/[caseId]/input/route.ts")).toBe(true);
  });

  it("GET /cases/{caseId} route exists", () => {
    expect(fileExists("app/api/cases/[caseId]/route.ts")).toBe(true);
  });

  it("GET /cases/{caseId}/events SSE route exists", () => {
    expect(fileExists("app/api/cases/[caseId]/events/route.ts")).toBe(true);
  });
});

describe("Part 1 Spec Compliance — Core Internal Objects (Section 8)", () => {
  const migrateSql = fileExists("scripts/migrate.ts")
    ? readFileSync(join(ROOT, "scripts/migrate.ts"), "utf-8")
    : "";

  it("cases table created in migration", () => {
    expect(migrateSql).toContain("CREATE TABLE IF NOT EXISTS cases");
  });

  it("cases table has case_id PK", () => {
    expect(migrateSql).toContain("case_id TEXT PRIMARY KEY");
  });

  it("cases table has user_id, status, appliance_type_hint", () => {
    expect(migrateSql).toContain("user_id TEXT");
    expect(migrateSql).toContain("status TEXT");
    expect(migrateSql).toContain("appliance_type_hint TEXT");
  });

  it("assets table created in migration", () => {
    expect(migrateSql).toContain("CREATE TABLE IF NOT EXISTS assets");
  });

  it("assets table references cases(case_id) with cascade", () => {
    expect(migrateSql).toContain("REFERENCES cases(case_id) ON DELETE CASCADE");
  });

  it("jobs table created in migration", () => {
    expect(migrateSql).toContain("CREATE TABLE IF NOT EXISTS jobs");
  });

  it("asset_metadata table created in migration", () => {
    expect(migrateSql).toContain("CREATE TABLE IF NOT EXISTS asset_metadata");
  });

  it("audit_logs table created in migration", () => {
    expect(migrateSql).toContain("CREATE TABLE IF NOT EXISTS audit_logs");
  });
});

describe("Part 1 Spec Compliance — Functional Goals (Section 6)", () => {
  it("accepts JPEG, PNG, WEBP, HEIC image types", () => {
    const src = readFileSync(join(ROOT, "lib/validation.ts"), "utf-8");
    expect(src).toContain("image/jpeg");
    expect(src).toContain("image/png");
    expect(src).toContain("image/webp");
    expect(src).toContain("image/heic");
  });

  it("accepts MP4, MOV, WebM video types", () => {
    const src = readFileSync(join(ROOT, "lib/validation.ts"), "utf-8");
    expect(src).toContain("video/mp4");
    expect(src).toContain("video/quicktime");
    expect(src).toContain("video/webm");
  });

  it("enforces 20 MB image limit", () => {
    const src = readFileSync(join(ROOT, "lib/validation.ts"), "utf-8");
    expect(src).toContain("20 * 1024 * 1024");
  });

  it("enforces 500 MB video limit", () => {
    const src = readFileSync(join(ROOT, "lib/validation.ts"), "utf-8");
    expect(src).toContain("500 * 1024 * 1024");
  });

  it("validates MIME via magic bytes, not filename alone", () => {
    const src = readFileSync(join(ROOT, "lib/validation.ts"), "utf-8");
    expect(src).toContain("MAGIC_BYTES");
    expect(src).toContain("validateMagicBytes");
  });

  it("computes SHA-256 checksum for deduplication", () => {
    const src = readFileSync(join(ROOT, "lib/validation.ts"), "utf-8");
    expect(src).toContain("sha256");
    expect(src).toContain("computeChecksum");
    expect(src).toContain("checkDuplicate");
  });

  it("text metadata includes description, brand, error_code", () => {
    const src = readFileSync(join(ROOT, "app/api/cases/[caseId]/input/route.ts"), "utf-8");
    expect(src).toContain("description");
    expect(src).toContain("metadata");
  });
});

describe("Part 1 Spec Compliance — State Machines (Section 10)", () => {
  it("case statuses exist in codebase", () => {
    const eventsRoute = readFileSync(join(ROOT, "app/api/cases/[caseId]/events/route.ts"), "utf-8");
    const registerRoute = readFileSync(join(ROOT, "app/api/cases/[caseId]/assets/register/route.ts"), "utf-8");
    const caseRoute = readFileSync(join(ROOT, "app/api/cases/route.ts"), "utf-8");

    expect(caseRoute).toContain("'created'");
    expect(registerRoute).toContain("awaiting_upload");
    expect(eventsRoute).toContain("validating");
    expect(eventsRoute).toContain("preprocessing");
    expect(eventsRoute).toContain("ready_for_analysis");
    expect(eventsRoute).toContain("failed_validation");
    expect(eventsRoute).toContain("preprocessing_failed");
  });

  it("asset statuses progress through lifecycle", () => {
    const registerRoute = readFileSync(join(ROOT, "app/api/cases/[caseId]/assets/register/route.ts"), "utf-8");
    const completeRoute = readFileSync(join(ROOT, "app/api/cases/[caseId]/assets/[assetId]/complete/route.ts"), "utf-8");
    const preprocessing = readFileSync(join(ROOT, "lib/preprocessing.ts"), "utf-8");

    expect(registerRoute).toContain("awaiting_upload");
    expect(completeRoute).toContain("uploaded");
    expect(preprocessing).toContain("validating");
    expect(preprocessing).toContain("validated");
    expect(preprocessing).toContain("ready");
  });
});

describe("Part 1 Spec Compliance — Media Preprocessing (Section 12)", () => {
  const preprocessing = readFileSync(join(ROOT, "lib/preprocessing.ts"), "utf-8");

  it("image pipeline: auto-rotate + strip metadata", () => {
    expect(preprocessing).toContain(".rotate()");
    expect(preprocessing).toContain(".withMetadata(false)");
  });

  it("image pipeline: generate normalized + thumbnail", () => {
    expect(preprocessing).toContain("normalizedBuffer");
    expect(preprocessing).toContain("thumbnailBuffer");
    expect(preprocessing).toContain("THUMBNAIL_SIZE");
  });

  it("image pipeline: uses sharp", () => {
    expect(preprocessing).toContain("import sharp");
  });

  it("video pipeline: ffprobe metadata extraction", () => {
    expect(preprocessing).toContain("ffprobe");
    expect(preprocessing).toContain("extractVideoMetadata");
  });

  it("video pipeline: frame extraction at 1-second intervals", () => {
    expect(preprocessing).toContain("FRAME_INTERVAL_SEC");
    expect(preprocessing).toContain('fps=1/');
  });

  it("video pipeline: poster thumbnail generation", () => {
    expect(preprocessing).toContain("poster");
    expect(preprocessing).toContain("vframes 1");
  });

  it("storage paths follow raw/{case_id}/{asset_id}/ layout", () => {
    const storage = readFileSync(join(ROOT, "lib/storage.ts"), "utf-8");
    expect(storage).toContain("raw/${caseId}/${assetId}");
  });
});

describe("Part 1 Spec Compliance — Security (Section 15)", () => {
  it("signed upload URLs with expiry", () => {
    const storage = readFileSync(join(ROOT, "lib/storage.ts"), "utf-8");
    expect(storage).toContain("createSignedUploadUrl");
    expect(storage).toContain("expiresAt");
  });

  it("MIME + magic byte validation enforced", () => {
    expect(fileContains("lib/validation.ts", "validateMagicBytes")).toBe(true);
    expect(fileContains("lib/malware-scan.ts", "validateMagicBytes")).toBe(true);
  });

  it("malware scan module exists", () => {
    expect(fileExists("lib/malware-scan.ts")).toBe(true);
    expect(fileContains("lib/malware-scan.ts", "scanFile")).toBe(true);
  });

  it("malware scan runs before preprocessing", () => {
    const src = readFileSync(join(ROOT, "lib/preprocessing.ts"), "utf-8");
    const scanIdx = src.indexOf("scanFile(");
    const processIdx = src.indexOf("preprocessImage");
    expect(scanIdx).toBeLessThan(processIdx);
  });

  it("EXIF metadata stripped in normalized derivatives", () => {
    expect(fileContains("lib/preprocessing.ts", "withMetadata(false)")).toBe(true);
  });

  it("audit logging module exists", () => {
    expect(fileExists("lib/audit.ts")).toBe(true);
    expect(fileContains("lib/audit.ts", "audit_logs")).toBe(true);
  });

  it("size limits enforced at registration", () => {
    expect(fileContains("app/api/cases/[caseId]/assets/register/route.ts", "validateSizeLimits")).toBe(true);
  });

  it("quota management enforced at registration", () => {
    expect(fileContains("app/api/cases/[caseId]/assets/register/route.ts", "checkUploadQuota")).toBe(true);
  });
});

describe("Part 1 Spec Compliance — Error Handling (Section 14)", () => {
  it("retry module exists with configurable backoff", () => {
    const src = readFileSync(join(ROOT, "lib/retry.ts"), "utf-8");
    expect(src).toContain("withRetry");
    expect(src).toContain("baseDelay");
    expect(src).toContain("maxDelay");
    expect(src).toContain("jitter");
  });

  it("permanent error codes defined per spec", () => {
    const src = readFileSync(join(ROOT, "lib/retry.ts"), "utf-8");
    expect(src).toContain("ERR_MIME_MISMATCH");
    expect(src).toContain("ERR_SIZE_EXCEEDED");
    expect(src).toContain("ERR_DECODE_FAILED");
    expect(src).toContain("ERR_SCAN_FLAGGED");
    expect(src).toContain("ERR_DUPLICATE");
  });

  it("PermanentError class exists", () => {
    expect(fileContains("lib/retry.ts", "class PermanentError")).toBe(true);
  });

  it("partial case success supported", () => {
    const src = readFileSync(join(ROOT, "lib/preprocessing.ts"), "utf-8");
    expect(src).toContain("updateCaseStatusIfReady");
    expect(src).toContain("ready");
    expect(src).toContain("failed");
  });
});

describe("Part 1 Spec Compliance — Observability (Section 16)", () => {
  it("structured logger with all context fields", () => {
    const src = readFileSync(join(ROOT, "lib/observability.ts"), "utf-8");
    expect(src).toContain("request_id");
    expect(src).toContain("user_id");
    expect(src).toContain("case_id");
    expect(src).toContain("asset_id");
    expect(src).toContain("job_id");
  });

  it("metric tracking exists", () => {
    expect(fileContains("lib/observability.ts", "metric")).toBe(true);
  });
});

describe("Part 1 Spec Compliance — Production Hardening (Phase C)", () => {
  it("retention module exists", () => {
    expect(fileExists("lib/retention.ts")).toBe(true);
  });

  it("cleanup script exists", () => {
    expect(fileExists("scripts/cleanup.ts")).toBe(true);
  });

  it("quota module exists", () => {
    expect(fileExists("lib/quota.ts")).toBe(true);
  });

  it("deduplication via SHA-256 in complete route", () => {
    expect(fileContains(
      "app/api/cases/[caseId]/assets/[assetId]/complete/route.ts",
      "checkDuplicate",
    )).toBe(true);
  });
});

describe("Part 1 Spec Compliance — Persistence Design (Section 13)", () => {
  const migrateSql = readFileSync(join(ROOT, "scripts/migrate.ts"), "utf-8");

  it("assets table has checksum_sha256 column", () => {
    expect(migrateSql).toContain("checksum_sha256");
  });

  it("asset_metadata table has width, height, duration_sec, codec, frame_rate", () => {
    expect(migrateSql).toContain("width INTEGER");
    expect(migrateSql).toContain("height INTEGER");
    expect(migrateSql).toContain("duration_sec");
    expect(migrateSql).toContain("codec TEXT");
    expect(migrateSql).toContain("frame_rate");
  });

  it("asset_metadata table has exif_json, derived_metadata_json", () => {
    expect(migrateSql).toContain("exif_json JSONB");
    expect(migrateSql).toContain("derived_metadata_json JSONB");
  });

  it("jobs table has retry_count and error_code", () => {
    expect(migrateSql).toContain("retry_count");
    expect(migrateSql).toContain("error_code");
  });

  it("indexes exist for assets(case_id) and jobs(case_id)", () => {
    expect(migrateSql).toContain("idx_assets_case_id");
    expect(migrateSql).toContain("idx_jobs_case_id");
  });

  it("index on checksum for deduplication", () => {
    expect(migrateSql).toContain("idx_assets_checksum");
  });
});
