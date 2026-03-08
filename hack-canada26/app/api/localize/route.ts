import { NextRequest, NextResponse } from "next/server";
import { LocalizeServiceError, localizePart } from "@/lib/localize";
import { LocalizationPlan } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const imageUrl = body?.imageUrl as string | undefined;
    const width = body?.width as number | undefined;
    const height = body?.height as number | undefined;
    const localizationPlan = body?.localizationPlan as LocalizationPlan | undefined;

    if (!imageUrl || !width || !height || !localizationPlan) {
      return NextResponse.json(
        { error: "Missing imageUrl, width, height, or localizationPlan" },
        { status: 400 }
      );
    }

    console.log("[localize] dimensions used for pixel conversion:", {
      width,
      height,
      imageUrl,
    });

    const result = await localizePart({
      imageUrl,
      width,
      height,
      localizationPlan,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LocalizeServiceError) {
      return NextResponse.json(
        {
          error: error.message,
          provider: error.details,
        },
        { status: error.status }
      );
    }

    console.error("localize failed:", error);
    return NextResponse.json(
      { error: "Failed to localize target" },
      { status: 500 }
    );
  }
}
