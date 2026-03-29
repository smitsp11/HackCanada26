import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const DEFAULT_BACKEND = "https://hack-canada26.vercel.app";

function getBackendBase() {
  return (
    process.env.BACKEND_URL ||
    process.env.PROCESS_API_URL?.replace(/\/api\/process\/?$/, "") ||
    DEFAULT_BACKEND
  );
}

function sseError(message: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const msg = JSON.stringify({ type: "error", message });
      controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  const url = `${getBackendBase()}/api/cases/${caseId}/events`;

  try {
    const upstreamRes = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "text/event-stream" },
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      return sseError(`Backend returned ${upstreamRes.status}`);
    }

    // Manually pump the upstream reader so each chunk flushes immediately.
    // Passing upstreamRes.body directly can coalesce chunks in Node/undici
    // and deliver all events at once instead of progressively.
    const reader = upstreamRes.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      cancel() {
        reader.cancel();
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    console.error("cases/[caseId]/events proxy failed:", error);
    return sseError("SSE proxy connection failed");
  }
}
