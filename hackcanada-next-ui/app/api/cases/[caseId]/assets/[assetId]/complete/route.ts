import { NextRequest, NextResponse } from "next/server";

const DEFAULT_BACKEND = "https://hack-canada26.vercel.app";

function getBackendBase() {
  return (
    process.env.BACKEND_URL ||
    process.env.PROCESS_API_URL?.replace(/\/api\/process\/?$/, "") ||
    DEFAULT_BACKEND
  );
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string; assetId: string }> },
) {
  try {
    const { caseId, assetId } = await params;

    const url = `${getBackendBase()}/api/cases/${caseId}/assets/${assetId}/complete`;

    const upstreamRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      cache: "no-store",
    });

    const bodyText = await upstreamRes.text();
    const ct = upstreamRes.headers.get("content-type") || "";

    return new NextResponse(bodyText, {
      status: upstreamRes.status,
      headers: { "content-type": ct || "application/json" },
    });
  } catch (error) {
    console.error("assets/complete proxy POST failed:", error);
    return NextResponse.json(
      { error: "Asset complete proxy failed" },
      { status: 500 },
    );
  }
}
