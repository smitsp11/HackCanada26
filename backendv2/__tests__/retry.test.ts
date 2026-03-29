import { describe, it, expect, vi } from "vitest";
import { withRetry, PermanentError } from "../lib/retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 1 }),
    ).rejects.toThrow("Failed after 3 attempts");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry PermanentError", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new PermanentError("bad file", "ERR_DECODE_FAILED"));

    await expect(
      withRetry(fn, { maxRetries: 5, baseDelay: 1 }),
    ).rejects.toThrow("bad file");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry errors matching default permanent codes", async () => {
    const err = new Error("MIME mismatch detected");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxRetries: 5, baseDelay: 1 }),
    ).rejects.toThrow("MIME mismatch");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry callback with attempt number", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");

    const onRetry = vi.fn();

    await withRetry(fn, { maxRetries: 3, baseDelay: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it("respects custom isPermanent", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("custom-fatal"));

    const isPermanent = (err: unknown) =>
      err instanceof Error && err.message.includes("custom-fatal");

    await expect(
      withRetry(fn, { maxRetries: 5, baseDelay: 1, isPermanent }),
    ).rejects.toThrow("custom-fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausted retries produce ERR_MAX_RETRIES_EXCEEDED code", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("transient"));

    try {
      await withRetry(fn, { maxRetries: 1, baseDelay: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(PermanentError);
      expect((err as PermanentError).code).toBe("ERR_MAX_RETRIES_EXCEEDED");
    }
  });
});

describe("PermanentError", () => {
  it("has name, message, and code", () => {
    const err = new PermanentError("test message", "ERR_TEST");
    expect(err.name).toBe("PermanentError");
    expect(err.message).toBe("test message");
    expect(err.code).toBe("ERR_TEST");
    expect(err).toBeInstanceOf(Error);
  });
});
