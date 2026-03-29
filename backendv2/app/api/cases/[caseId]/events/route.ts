import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { identifyWithGemini } from "@/lib/identify-gemini";
import {
  diagnoseWithGemini,
  synthesizeRepairSteps,
  type DiagnosisResult,
} from "@/lib/diagnose";

export const dynamic = "force-dynamic";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      }

      function sendError(message: string) {
        send({ type: "error", message });
        controller.close();
      }

      try {
        // ── Fetch case + assets from DB ─────────────────────────────────
        const caseResult = await pool.query(
          `SELECT case_id, description_raw, metadata, appliance_type_hint
           FROM cases WHERE case_id = $1`,
          [caseId],
        );

        if (caseResult.rows.length === 0) {
          sendError("Case not found");
          return;
        }

        const caseRow = caseResult.rows[0];
        const symptom = caseRow.description_raw || "Unknown issue";
        const applianceHint = caseRow.appliance_type_hint || undefined;

        const assetsResult = await pool.query(
          `SELECT asset_id, asset_type, slot_key, cloudinary_url
           FROM assets WHERE case_id = $1
           ORDER BY created_at`,
          [caseId],
        );

        const assets = assetsResult.rows;
        const slotOrder = ["model", "additional", "video"] as const;
        const orderedUrls: string[] = slotOrder.map((key) => {
          const match = assets.find(
            (a: { slot_key: string }) => a.slot_key === key,
          );
          return match?.cloudinary_url ?? "";
        });

        // ── Phase 1: Slot processing ────────────────────────────────────

        await pool.query(
          `UPDATE cases SET status = 'validating', updated_at = NOW() WHERE case_id = $1`,
          [caseId],
        );

        for (let i = 0; i < orderedUrls.length; i++) {
          send({ type: "slot_processing", slotIndex: i });
          await delay(400);

          if (orderedUrls[i]) {
            try {
              const headRes = await fetch(orderedUrls[i], { method: "HEAD" });
              if (!headRes.ok) {
                orderedUrls[i] = "";
              }
            } catch {
              orderedUrls[i] = "";
            }
          }

          send({
            type: "slot_complete",
            slotIndex: i,
            url: orderedUrls[i] || `/api/diagnose/placeholder?slot=${i}`,
          });
          await delay(200);
        }

        // Update asset validation statuses
        for (const asset of assets) {
          const url = orderedUrls[slotOrder.indexOf(asset.slot_key)];
          const validationStatus = url ? "validated" : "failed";
          await pool.query(
            `UPDATE assets SET validation_status = $2 WHERE asset_id = $1`,
            [asset.asset_id, validationStatus],
          );
        }

        // ── Phase 2: Cognitive analysis ─────────────────────────────────

        await pool.query(
          `UPDATE cases SET status = 'preprocessing', updated_at = NOW() WHERE case_id = $1`,
          [caseId],
        );

        const modelImageUrl = orderedUrls[0];
        let deviceId = applianceHint || "Unknown appliance";

        if (modelImageUrl) {
          try {
            const geminiId = await identifyWithGemini(modelImageUrl);
            if (geminiId.company || geminiId.modelNumber) {
              deviceId = [geminiId.company, geminiId.modelNumber]
                .filter(Boolean)
                .join(" ");
            }
          } catch (e) {
            console.warn("Device identification failed, using hint:", e);
          }
        }

        send({ type: "device_identified", makeModel: deviceId });

        // Full diagnosis with Gemini
        let diagnosis: DiagnosisResult;
        try {
          diagnosis = await diagnoseWithGemini(
            orderedUrls.filter(Boolean),
            symptom,
            deviceId,
          );
        } catch (e) {
          console.error("Diagnosis failed:", e);
          diagnosis = {
            makeModel: deviceId,
            manualTitle: `${deviceId} Service Manual`,
            symptomSummary: symptom,
            relevantSections: "General Troubleshooting",
            partsNeeded: "Inspection required to determine parts",
          };
        }

        send({
          type: "manual_found",
          manualId: diagnosis.manualId || "AUTO-GENERATED",
          title: diagnosis.manualTitle,
        });

        await delay(300);

        send({
          type: "symptom_sections_found",
          symptom: diagnosis.symptomSummary,
          sections: diagnosis.relevantSections,
        });

        await delay(300);

        send({
          type: "parts_check_complete",
          parts: diagnosis.partsNeeded,
        });

        // ── Phase 3: Synthesis ──────────────────────────────────────────

        const synthLogs = [
          "CROSS_REFERENCING_SYMPTOM_LOG",
          "ANALYZING_VISUAL_DATA",
          "MATCHING_MANUAL_SECTIONS",
          "GENERATING_REPAIR_INSTRUCTIONS",
          "RENDERING_VISUAL_SCHEMATICS",
        ];

        for (let i = 0; i < synthLogs.length; i++) {
          if (i < 3) {
            await delay(500);
          }
          send({
            type: "synthesis_progress",
            percent: (i + 1) * 20,
            log: synthLogs[i],
          });
          if (i === 2) {
            // After first 3 progress events, start actual synthesis
            break;
          }
        }

        let steps;
        try {
          steps = await synthesizeRepairSteps(
            orderedUrls.filter(Boolean),
            symptom,
            diagnosis,
          );
        } catch (e) {
          console.error("Synthesis failed:", e);
          steps = [
            {
              id: 1,
              instruction:
                "Turn off power/gas supply to the appliance for safety.",
              schematicUrl: null,
            },
            {
              id: 2,
              instruction: `Inspect the appliance for signs related to: ${symptom}`,
              schematicUrl: null,
            },
            {
              id: 3,
              instruction:
                "Consult the service manual for detailed troubleshooting steps.",
              schematicUrl: null,
            },
          ];
        }

        send({ type: "synthesis_progress", percent: 80, log: "GENERATING_REPAIR_INSTRUCTIONS" });
        await delay(300);
        send({ type: "synthesis_progress", percent: 100, log: "RENDERING_VISUAL_SCHEMATICS" });

        // ── Complete ────────────────────────────────────────────────────

        await pool.query(
          `UPDATE cases SET status = 'ready_for_analysis', updated_at = NOW() WHERE case_id = $1`,
          [caseId],
        );

        send({ type: "synthesis_complete", steps });

        controller.close();
      } catch (error) {
        console.error("SSE pipeline error:", error);
        try {
          sendError(
            error instanceof Error ? error.message : "Pipeline failed",
          );
        } catch {
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
