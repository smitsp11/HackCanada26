import { describe, it, expect } from "vitest";
import {
  isAllowedMime,
  validateMagicBytes,
  validateSizeLimits,
  computeChecksum,
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
  SIZE_LIMITS,
} from "../lib/validation";

describe("isAllowedMime", () => {
  it("accepts valid image MIME types", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(isAllowedMime(mime, "image")).toBe(true);
    }
  });

  it("rejects invalid image MIME types", () => {
    expect(isAllowedMime("image/gif", "image")).toBe(false);
    expect(isAllowedMime("image/bmp", "image")).toBe(false);
    expect(isAllowedMime("application/pdf", "image")).toBe(false);
  });

  it("accepts valid video MIME types", () => {
    for (const mime of ["video/mp4", "video/quicktime", "video/webm"]) {
      expect(isAllowedMime(mime, "video")).toBe(true);
    }
  });

  it("rejects invalid video MIME types", () => {
    expect(isAllowedMime("video/avi", "video")).toBe(false);
    expect(isAllowedMime("video/x-msvideo", "video")).toBe(false);
  });

  it("rejects unknown asset types", () => {
    expect(isAllowedMime("image/jpeg", "document")).toBe(false);
    expect(isAllowedMime("text/plain", "text")).toBe(false);
  });

  it("covers all spec-mandated image formats (JPEG, PNG, WEBP, HEIC)", () => {
    expect(ALLOWED_IMAGE_MIMES.has("image/jpeg")).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has("image/png")).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has("image/webp")).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has("image/heic")).toBe(true);
  });

  it("covers all spec-mandated video formats (MP4, MOV, WebM)", () => {
    expect(ALLOWED_VIDEO_MIMES.has("video/mp4")).toBe(true);
    expect(ALLOWED_VIDEO_MIMES.has("video/quicktime")).toBe(true);
    expect(ALLOWED_VIDEO_MIMES.has("video/webm")).toBe(true);
  });
});

describe("validateMagicBytes", () => {
  it("detects JPEG magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const result = validateMagicBytes(buf, "image/jpeg");
    expect(result.valid).toBe(true);
    expect(result.detectedMime).toBe("image/jpeg");
  });

  it("detects PNG magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const result = validateMagicBytes(buf, "image/png");
    expect(result.valid).toBe(true);
    expect(result.detectedMime).toBe("image/png");
  });

  it("detects WebP magic bytes (RIFF header)", () => {
    const buf = Buffer.alloc(16);
    buf.write("RIFF", 0);
    const result = validateMagicBytes(buf, "image/webp");
    expect(result.valid).toBe(true);
    expect(result.detectedMime).toBe("image/webp");
  });

  it("detects MP4/ftyp magic bytes at offset 4", () => {
    const buf = Buffer.alloc(16);
    buf.write("ftyp", 4);
    const result = validateMagicBytes(buf, "video/mp4");
    expect(result.valid).toBe(true);
  });

  it("allows MOV with ftyp magic bytes (cross-compatible)", () => {
    const buf = Buffer.alloc(16);
    buf.write("ftyp", 4);
    const result = validateMagicBytes(buf, "video/quicktime");
    expect(result.valid).toBe(true);
  });

  it("detects WebM magic bytes", () => {
    const buf = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
    const result = validateMagicBytes(buf, "video/webm");
    expect(result.valid).toBe(true);
    expect(result.detectedMime).toBe("video/webm");
  });

  it("flags MIME mismatch (JPEG bytes declared as PNG)", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const result = validateMagicBytes(buf, "image/png");
    expect(result.valid).toBe(false);
    expect(result.detectedMime).toBe("image/jpeg");
  });

  it("returns invalid for unrecognized magic bytes", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = validateMagicBytes(buf, "image/jpeg");
    expect(result.valid).toBe(false);
    expect(result.detectedMime).toBeNull();
  });

  it("handles buffer smaller than any signature", () => {
    const buf = Buffer.from([0xff]);
    const result = validateMagicBytes(buf, "image/jpeg");
    expect(result.valid).toBe(false);
  });

  it("handles empty buffer", () => {
    const buf = Buffer.alloc(0);
    const result = validateMagicBytes(buf, "image/jpeg");
    expect(result.valid).toBe(false);
  });
});

describe("validateSizeLimits", () => {
  it("allows images under 20 MB", () => {
    const result = validateSizeLimits(10 * 1024 * 1024, "image");
    expect(result.valid).toBe(true);
    expect(result.limit).toBe(20 * 1024 * 1024);
  });

  it("allows images exactly at 20 MB", () => {
    const result = validateSizeLimits(20 * 1024 * 1024, "image");
    expect(result.valid).toBe(true);
  });

  it("rejects images over 20 MB", () => {
    const result = validateSizeLimits(20 * 1024 * 1024 + 1, "image");
    expect(result.valid).toBe(false);
  });

  it("allows videos under 500 MB", () => {
    const result = validateSizeLimits(100 * 1024 * 1024, "video");
    expect(result.valid).toBe(true);
    expect(result.limit).toBe(500 * 1024 * 1024);
  });

  it("rejects videos over 500 MB", () => {
    const result = validateSizeLimits(500 * 1024 * 1024 + 1, "video");
    expect(result.valid).toBe(false);
  });

  it("matches spec limits exactly", () => {
    expect(SIZE_LIMITS.image).toBe(20 * 1024 * 1024);
    expect(SIZE_LIMITS.video).toBe(500 * 1024 * 1024);
  });

  it("defaults to image limit for unknown asset types", () => {
    const result = validateSizeLimits(21 * 1024 * 1024, "document");
    expect(result.valid).toBe(false);
    expect(result.limit).toBe(20 * 1024 * 1024);
  });
});

describe("computeChecksum", () => {
  it("returns a 64-character hex SHA-256 hash", () => {
    const buf = Buffer.from("hello world");
    const hash = computeChecksum(buf);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent output for the same input", () => {
    const buf = Buffer.from("deterministic test");
    expect(computeChecksum(buf)).toBe(computeChecksum(buf));
  });

  it("produces different output for different input", () => {
    const a = computeChecksum(Buffer.from("file-a"));
    const b = computeChecksum(Buffer.from("file-b"));
    expect(a).not.toBe(b);
  });

  it("known SHA-256 vector", () => {
    const hash = computeChecksum(Buffer.from(""));
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
