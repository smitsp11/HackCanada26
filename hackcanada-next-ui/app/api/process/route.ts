import { NextRequest, NextResponse } from "next/server";

// Set PROCESS_API_URL in Vercel to your backend's /api/process, e.g. https://<backend-project>.vercel.app/api/process
// Default points to frontend root and will fail; backend (backendv2) must be deployed separately.
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

    const bodyText = await upstreamRes.text();

    // If upstream returned empty or non-JSON, return a proper JSON error
    // instead of forwarding, so the client doesn't fail on response.json()
    const contentTypeHeader = upstreamRes.headers.get("content-type") || "";
    const isJson =
      contentTypeHeader.includes("application/json") ||
      (bodyText.trim().length > 0 && bodyText.trim().startsWith("{"));

    if (!isJson) {
      console.error("process proxy: upstream returned non-JSON", {
        status: upstreamRes.status,
        contentType: contentTypeHeader,
        bodyPreview: bodyText.slice(0, 200),
      });
      return NextResponse.json(
        {
          error:
            "Process service returned an invalid response. Ensure PROCESS_API_URL points to your backend /api/process and the backend is deployed.",
        },
        { status: 502 }
      );
    }

    return new NextResponse(bodyText, {
      status: upstreamRes.status,
      headers: {
        "content-type": contentTypeHeader || "application/json",
      },
    });
  } catch (error) {
    console.error("process proxy failed:", error);
    return NextResponse.json({ error: "Process proxy failed" }, { status: 500 });
  }
}
