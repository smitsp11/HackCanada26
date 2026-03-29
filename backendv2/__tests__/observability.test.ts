import { describe, it, expect, vi, beforeEach } from "vitest";
import { logger } from "../lib/observability";

describe("logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("info() outputs structured JSON with level=info", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("test message", { case_id: "c1", asset_id: "a1" });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("test message");
    expect(parsed.case_id).toBe("c1");
    expect(parsed.asset_id).toBe("a1");
    expect(parsed.ts).toBeDefined();
  });

  it("warn() outputs structured JSON with level=warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logger.warn("caution", { job_id: "j1" });

    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("caution");
    expect(parsed.job_id).toBe("j1");
  });

  it("error() outputs structured JSON with level=error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("failure", { request_id: "r1" }, { detail: "stack" });

    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("failure");
    expect(parsed.request_id).toBe("r1");
    expect(parsed.detail).toBe("stack");
  });

  it("metric() outputs structured JSON with level=metric", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.metric(
      { event: "upload_completed", duration_ms: 250, file_size_bytes: 1024 },
      { case_id: "c2" },
    );

    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe("metric");
    expect(parsed.msg).toBe("upload_completed");
    expect(parsed.duration_ms).toBe(250);
    expect(parsed.file_size_bytes).toBe(1024);
    expect(parsed.case_id).toBe("c2");
  });

  it("includes all five spec-mandated context fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("full context", {
      request_id: "r1",
      user_id: "u1",
      case_id: "c1",
      asset_id: "a1",
      job_id: "j1",
    });

    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.request_id).toBe("r1");
    expect(parsed.user_id).toBe("u1");
    expect(parsed.case_id).toBe("c1");
    expect(parsed.asset_id).toBe("a1");
    expect(parsed.job_id).toBe("j1");
  });

  it("outputs valid JSON that can be parsed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("parse test", {});

    expect(() => JSON.parse(spy.mock.calls[0][0])).not.toThrow();
  });
});
