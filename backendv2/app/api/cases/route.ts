import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import pool from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const applianceTypeHint = body?.appliance_type_hint ?? null;

    const caseId = `case_${crypto.randomUUID()}`;

    await pool.query(
      `INSERT INTO cases (case_id, status, appliance_type_hint)
       VALUES ($1, 'created', $2)`,
      [caseId, applianceTypeHint],
    );

    return NextResponse.json({ case_id: caseId, status: "created" }, { status: 201 });
  } catch (error) {
    console.error("POST /api/cases failed:", error);
    return NextResponse.json(
      { error: "Failed to create case" },
      { status: 500 },
    );
  }
}
