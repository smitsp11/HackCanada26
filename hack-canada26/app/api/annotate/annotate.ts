import { NextRequest, NextResponse } from "next/server";
import { buildAnnotatedUrl } from "@/lib/annotate";
import { PixelBox } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const publicId = body?.publicId as string;
    const pixelBox = body?.pixelBox as PixelBox;
    const overlayText = body?.overlayText as string;

    if (!publicId || !pixelBox || !overlayText) {
      return NextResponse.json(
        { error: "Missing publicId, pixelBox, or overlayText" },
        { status: 400 }
      );
    }

    const annotatedUrl = buildAnnotatedUrl(
      publicId,
      pixelBox,
      overlayText
    );
    console.log("[annotate] pixelBox used for localized derivative:", pixelBox);

    return NextResponse.json({ annotatedUrl });
  } catch (error) {
    console.error("annotate failed:", error);

    return NextResponse.json(
      { error: "Failed to annotate image" },
      { status: 500 }
    );
  }
}
