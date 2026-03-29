export interface LogContext {
  request_id?: string;
  user_id?: string;
  case_id?: string;
  asset_id?: string;
  job_id?: string;
}

export interface MetricData {
  event: string;
  duration_ms?: number;
  file_size_bytes?: number;
  mime_type?: string;
  format?: string;
  [key: string]: unknown;
}

function formatEntry(
  level: string,
  message: string,
  ctx: LogContext,
  extra?: Record<string, unknown>,
): string {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...ctx,
    ...extra,
  };
  return JSON.stringify(entry);
}

export const logger = {
  info(message: string, ctx: LogContext = {}, extra?: Record<string, unknown>) {
    console.log(formatEntry("info", message, ctx, extra));
  },
  warn(message: string, ctx: LogContext = {}, extra?: Record<string, unknown>) {
    console.warn(formatEntry("warn", message, ctx, extra));
  },
  error(message: string, ctx: LogContext = {}, extra?: Record<string, unknown>) {
    console.error(formatEntry("error", message, ctx, extra));
  },
  metric(data: MetricData, ctx: LogContext = {}) {
    console.log(formatEntry("metric", data.event, ctx, data));
  },
};
