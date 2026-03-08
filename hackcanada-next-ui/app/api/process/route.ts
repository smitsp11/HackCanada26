import { NextRequest, NextResponse } from "next/server";

const DEFAULT_PROCESS_URL = "https://hack-canada26.vercel.app/";

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type");
    const body = await req.arrayBuffer();

    const processUrl = process.env.PROCESS_API_URL || DEFAULT_PROCESS_URL;
    const upstreamRes = await fetch(processUrl, {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : undefined,
      body,
      cache: "no-store",
    });

    const upstreamContentType =
      upstreamRes.headers.get("content-type") || "application/json";
    const bodyText = await upstreamRes.text();

    return new NextResponse(bodyText, {
      status: upstreamRes.status,
      headers: { "content-type": upstreamContentType },
    });
  } catch (error) {
    console.error("process proxy failed:", error);
    return NextResponse.json({ error: "Process proxy failed" }, { status: 500 });
  }
}
