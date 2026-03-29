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
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await params;
    const contentType = req.headers.get("content-type");
    const body = await req.arrayBuffer();

    const url = `${getBackendBase()}/api/cases/${caseId}/assets/register`;

    const upstreamRes = await fetch(url, {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : undefined,
      body,
      cache: "no-store",
    });

    const bodyText = await upstreamRes.text();
    const ct = upstreamRes.headers.get("content-type") || "";

    return new NextResponse(bodyText, {
      status: upstreamRes.status,
      headers: { "content-type": ct || "application/json" },
    });
  } catch (error) {
    console.error("assets/register proxy POST failed:", error);
    return NextResponse.json(
      { error: "Asset register proxy failed" },
      { status: 500 },
    );
  }
}
