import { NextRequest, NextResponse } from "next/server";

const DEFAULT_BACKEND = "https://hack-canada26.vercel.app";

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type");
    const body = await req.arrayBuffer();

    const backendBase =
      process.env.IDENTIFY_API_URL ||
      process.env.PROCESS_API_URL?.replace(/\/api\/process\/?$/, "") ||
      DEFAULT_BACKEND;

    const url = `${backendBase}/api/identify-product`;

    const upstreamRes = await fetch(url, {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : undefined,
      body,
      cache: "no-store",
    });

    const bodyText = await upstreamRes.text();
    const ct = upstreamRes.headers.get("content-type") || "";
    const isJson =
      ct.includes("application/json") ||
      (bodyText.trim().startsWith("{") && bodyText.trim().length > 0);

    if (!isJson) {
      return NextResponse.json(
        { error: "Identify service returned invalid response." },
        { status: 502 },
      );
    }

    return new NextResponse(bodyText, {
      status: upstreamRes.status,
      headers: { "content-type": ct || "application/json" },
    });
  } catch (error) {
    console.error("identify-product proxy failed:", error);
    return NextResponse.json(
      { error: "Identify proxy failed" },
      { status: 500 },
    );
  }
}
