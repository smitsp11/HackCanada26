export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  isPermanent?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void | Promise<void>;
}

const PERMANENT_ERROR_CODES = new Set([
  "ERR_MIME_MISMATCH",
  "ERR_SIZE_EXCEEDED",
  "ERR_DECODE_FAILED",
  "ERR_SCAN_FLAGGED",
  "ERR_DUPLICATE",
]);

function defaultIsPermanent(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (code && PERMANENT_ERROR_CODES.has(code)) return true;
    if (err.message.includes("MIME mismatch")) return true;
    if (err.message.includes("flagged")) return true;
  }
  return false;
}

export class PermanentError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PermanentError";
    this.code = code;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 30_000;
  const isPermanent = opts.isPermanent ?? defaultIsPermanent;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (err instanceof PermanentError || isPermanent(err)) {
        throw err;
      }

      if (attempt >= maxRetries) break;

      const jitter = Math.random() * 0.3 + 0.85;
      const delay = Math.min(baseDelay * 2 ** attempt * jitter, maxDelay);

      if (opts.onRetry) {
        await opts.onRetry(attempt + 1, err);
      }

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const msg = lastError instanceof Error ? lastError.message : "Unknown error";
  const retryErr = new PermanentError(
    `Failed after ${maxRetries + 1} attempts: ${msg}`,
    "ERR_MAX_RETRIES_EXCEEDED",
  );
  throw retryErr;
}
