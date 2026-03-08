import { NextRequest, NextResponse } from "next/server";
import { planLocalization } from "@/lib/plan-localization";
import { RepairStep } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const step = body?.step as RepairStep | undefined;

    if (!step) {
      return NextResponse.json(
        { error: 'Missing "step" in request body' },
        { status: 400 }
      );
    }

    const plan = await planLocalization(step);

    return NextResponse.json(plan);
  } catch (error) {
    console.error("plan-localization failed:", error);
    return NextResponse.json(
      { error: "Failed to generate localization plan" },
      { status: 500 }
    );
  }
}