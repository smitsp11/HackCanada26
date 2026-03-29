import { NextRequest, NextResponse } from "next/server";

const DEFAULT_BACKEND = "https://hack-canada26.vercel.app";

function getBackendBase() {
  return (
    process.env.BACKEND_URL ||
    process.env.PROCESS_API_URL?.replace(/\/api\/process\/?$/, "") ||
    DEFAULT_BACKEND
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await params;
    const url = `${getBackendBase()}/api/cases/${caseId}`;

    const upstreamRes = await fetch(url, { cache: "no-store" });
    const bodyText = await upstreamRes.text();
    const ct = upstreamRes.headers.get("content-type") || "";

    return new NextResponse(bodyText, {
      status: upstreamRes.status,
      headers: { "content-type": ct || "application/json" },
    });
  } catch (error) {
    console.error("cases/[caseId] proxy GET failed:", error);
    return NextResponse.json(
      { error: "Case fetch proxy failed" },
      { status: 500 },
    );
  }
}
