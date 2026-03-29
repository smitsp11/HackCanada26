import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { identifyWithGemini } from "@/lib/identify-gemini";
import {
  diagnoseWithGemini,
  synthesizeRepairSteps,
  type DiagnosisResult,
} from "@/lib/diagnose";
import { getPublicUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PreprocessingResult =
  | { outcome: "ok"; readyCount: number }
  | { outcome: "all_failed" }
  | { outcome: "timeout"; doneCount: number; totalCount: number };

const PREPROCESSING_TIMEOUT_MS = 60_000;

async function waitForPreprocessing(
  caseId: string,
  send: (data: Record<string, unknown>) => void,
): Promise<PreprocessingResult> {
  const start = Date.now();
  const pollInterval = 1500;

  while (Date.now() - start < PREPROCESSING_TIMEOUT_MS) {
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE processing_status IN ('ready', 'failed')) AS done,
         COUNT(*) FILTER (WHERE processing_status = 'ready') AS ready,
         COUNT(*) FILTER (WHERE upload_status = 'uploaded') AS uploaded
       FROM assets WHERE case_id = $1`,
      [caseId],
    );

    const { total, done, ready, uploaded } = result.rows[0];
    const totalNum = Number(total);
    const doneNum = Number(done);
    const readyNum = Number(ready);
    const uploadedNum = Number(uploaded);

    if (totalNum === 0) {
      await delay(pollInterval);
      continue;
    }

    send({
      type: "preprocessing_progress",
      total: totalNum,
      done: doneNum,
      ready: readyNum,
      uploaded: uploadedNum,
    });

    if (doneNum >= uploadedNum && uploadedNum > 0) {
      return readyNum > 0
        ? { outcome: "ok", readyCount: readyNum }
        : { outcome: "all_failed" };
    }

    await delay(pollInterval);
  }

  // Timed out -- report how far we got
  const final = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE processing_status IN ('ready', 'failed')) AS done,
       COUNT(*) AS total
     FROM assets WHERE case_id = $1`,
    [caseId],
  );
  return {
    outcome: "timeout",
    doneCount: Number(final.rows[0].done),
    totalCount: Number(final.rows[0].total),
  };
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

        send({ type: "case_status", status: "validating" });

        // ── Phase 1: Wait for async preprocessing or do inline validation ──

        const assetsResult = await pool.query(
          `SELECT asset_id, asset_type, slot_key, cloudinary_url,
                  storage_uri_raw, storage_uri_normalized, upload_status,
                  validation_status, processing_status
           FROM assets WHERE case_id = $1
           ORDER BY created_at`,
          [caseId],
        );

        const assets = assetsResult.rows;
        const hasSignedUrlAssets = assets.some((a: { storage_uri_raw: string | null }) => a.storage_uri_raw);

        if (hasSignedUrlAssets) {
          // Phase B flow: assets were uploaded via signed URLs, preprocessing is async
          send({ type: "case_status", status: "preprocessing" });

          const ppResult = await waitForPreprocessing(caseId, send);

          if (ppResult.outcome === "timeout") {
            await pool.query(
              `UPDATE cases SET status = 'preprocessing_failed', updated_at = NOW() WHERE case_id = $1`,
              [caseId],
            );
            send({ type: "case_status", status: "preprocessing_failed" });
            sendError(
              `Preprocessing timed out after ${PREPROCESSING_TIMEOUT_MS / 1000}s ` +
              `(${ppResult.doneCount}/${ppResult.totalCount} assets finished). ` +
              `This may be a transient failure -- try resubmitting.`,
            );
            return;
          }

          if (ppResult.outcome === "all_failed") {
            await pool.query(
              `UPDATE cases SET status = 'preprocessing_failed', updated_at = NOW() WHERE case_id = $1`,
              [caseId],
            );
            send({ type: "case_status", status: "preprocessing_failed" });
            sendError("All assets failed preprocessing. Check uploads and try again.");
            return;
          }

          // Refresh asset data after preprocessing
          const refreshed = await pool.query(
            `SELECT asset_id, asset_type, slot_key, cloudinary_url,
                    storage_uri_raw, storage_uri_normalized, upload_status,
                    validation_status, processing_status
             FROM assets WHERE case_id = $1
             ORDER BY created_at`,
            [caseId],
          );

          for (const asset of refreshed.rows) {
            if (asset.processing_status === "ready") {
              send({
                type: "asset_preprocessed",
                asset_id: asset.asset_id,
                slot_key: asset.slot_key,
                validation_status: asset.validation_status,
                processing_status: asset.processing_status,
              });
            }
          }

          assets.length = 0;
          assets.push(...refreshed.rows);
        } else {
          // Phase A fallback: Cloudinary-based assets, do inline validation
          const slotOrder = ["model", "additional", "video"] as const;
          const orderedUrls: string[] = slotOrder.map((key) => {
            const match = assets.find(
              (a: { slot_key: string }) => a.slot_key === key,
            );
            return match?.cloudinary_url ?? "";
          });

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
                if (!headRes.ok) orderedUrls[i] = "";
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

          for (const asset of assets) {
            const slotIdx = slotOrder.indexOf(asset.slot_key);
            const url = slotIdx >= 0 ? orderedUrls[slotIdx] : "";
            const validationStatus = url ? "validated" : "failed";
            await pool.query(
              `UPDATE assets SET validation_status = $2 WHERE asset_id = $1`,
              [asset.asset_id, validationStatus],
            );
          }
        }

        // ── Pre-Gemini gate ─────────────────────────────────────────
        // Both upload paths (Phase A Cloudinary inline, Phase B signed-URL
        // async) must converge to the same state before the Gemini pipeline
        // starts. Required contract:
        //   - At least one asset has a reachable URL (cloudinary or storage)
        //   - Case has a non-empty symptom description
        //   - No path reaches here if *all* assets failed (handled above)
        const usableAssets = assets.filter(
          (a: { cloudinary_url?: string; storage_uri_normalized?: string; validation_status: string }) =>
            (a.cloudinary_url || a.storage_uri_normalized) &&
            a.validation_status !== "failed",
        );

        if (usableAssets.length === 0) {
          await pool.query(
            `UPDATE cases SET status = 'failed_validation', updated_at = NOW() WHERE case_id = $1`,
            [caseId],
          );
          send({ type: "case_status", status: "failed_validation" });
          sendError("No usable assets available for analysis. All uploads failed validation.");
          return;
        }

        // ── Phase 2: Cognitive analysis ─────────────────────────────

        send({ type: "case_status", status: "analyzing" });

        await pool.query(
          `UPDATE cases SET status = 'analyzing', updated_at = NOW() WHERE case_id = $1`,
          [caseId],
        );

        // Build image URLs for Gemini - prefer storage URLs, fall back to Cloudinary
        const imageUrls: string[] = [];
        for (const asset of assets) {
          if (asset.storage_uri_normalized) {
            try {
              const url = await getPublicUrl(asset.storage_uri_normalized);
              imageUrls.push(url);
            } catch {
              if (asset.cloudinary_url) imageUrls.push(asset.cloudinary_url);
            }
          } else if (asset.cloudinary_url) {
            imageUrls.push(asset.cloudinary_url);
          }
        }

        const modelAsset = assets.find((a: { slot_key: string }) => a.slot_key === "model");
        const modelImageUrl =
          modelAsset?.storage_uri_normalized
            ? await getPublicUrl(modelAsset.storage_uri_normalized).catch(() => modelAsset.cloudinary_url)
            : modelAsset?.cloudinary_url || imageUrls[0] || "";

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

        let diagnosis: DiagnosisResult;
        try {
          diagnosis = await diagnoseWithGemini(
            imageUrls.filter(Boolean),
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

        // ── Phase 3: Synthesis ──────────────────────────────────────

        const synthLogs = [
          "CROSS_REFERENCING_SYMPTOM_LOG",
          "ANALYZING_VISUAL_DATA",
          "MATCHING_MANUAL_SECTIONS",
          "GENERATING_REPAIR_INSTRUCTIONS",
          "RENDERING_VISUAL_SCHEMATICS",
        ];

        for (let i = 0; i < synthLogs.length; i++) {
          if (i < 3) await delay(500);
          send({
            type: "synthesis_progress",
            percent: (i + 1) * 20,
            log: synthLogs[i],
          });
          if (i === 2) break;
        }

        let steps;
        try {
          steps = await synthesizeRepairSteps(
            imageUrls.filter(Boolean),
            symptom,
            diagnosis,
          );
        } catch (e) {
          console.error("Synthesis failed:", e);
          steps = [
            { id: 1, instruction: "Turn off power/gas supply to the appliance for safety.", schematicUrl: null },
            { id: 2, instruction: `Inspect the appliance for signs related to: ${symptom}`, schematicUrl: null },
            { id: 3, instruction: "Consult the service manual for detailed troubleshooting steps.", schematicUrl: null },
          ];
        }

        send({ type: "synthesis_progress", percent: 80, log: "GENERATING_REPAIR_INSTRUCTIONS" });
        await delay(300);
        send({ type: "synthesis_progress", percent: 100, log: "RENDERING_VISUAL_SCHEMATICS" });

        // ── Complete ────────────────────────────────────────────────

        await pool.query(
          `UPDATE cases SET status = 'ready_for_analysis', updated_at = NOW() WHERE case_id = $1`,
          [caseId],
        );

        send({ type: "case_status", status: "ready_for_analysis" });
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
