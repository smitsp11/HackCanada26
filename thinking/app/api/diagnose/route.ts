function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      }

      // Phase 1: Slot processing
      for (let i = 0; i < 4; i++) {
        await delay(600);
        send({ type: "slot_processing", slotIndex: i });
        await delay(1200);
        send({
          type: "slot_complete",
          slotIndex: i,
          url: `/api/diagnose/placeholder?slot=${i}`,
        });
      }

      // Phase 2: Device identification
      await delay(2000);
      send({
        type: "device_identified",
        makeModel: "BOSCH_SERIE_6_SMS6ZDW48G",
      });

      await delay(1500);
      send({
        type: "manual_found",
        manualId: "BOSCH-SMS6Z-MANUAL-2024",
        title: "Bosch Serie 6 SMS6ZDW48G Service Manual",
      });

      // Phase 3: Synthesis
      const synthLogs = [
        "CROSS_REFERENCING_SYMPTOM_LOG",
        "ANALYZING_AUDIO_ANOMALIES",
        "MATCHING_MANUAL_SECTIONS",
        "GENERATING_REPAIR_INSTRUCTIONS",
        "RENDERING_VISUAL_SCHEMATICS",
      ];

      for (let i = 0; i < synthLogs.length; i++) {
        await delay(1000);
        send({
          type: "synthesis_progress",
          percent: (i + 1) * 20,
          log: synthLogs[i],
        });
      }

      await delay(800);
      send({
        type: "synthesis_complete",
        steps: [
          {
            id: 1,
            instruction:
              "Disconnect the power supply by unplugging the appliance from the wall outlet. Wait 30 seconds for residual charge to dissipate.",
            schematicUrl: null,
          },
          {
            id: 2,
            instruction:
              "Open the lower access panel by removing the two Phillips-head screws on the bottom front edge. Pull the panel toward you gently.",
            schematicUrl: null,
          },
          {
            id: 3,
            instruction:
              "Locate the drain pump assembly on the lower left side. Check for debris or foreign objects blocking the impeller.",
            schematicUrl: null,
          },
          {
            id: 4,
            instruction:
              "Inspect the inlet valve solenoid connections. Ensure the wiring harness is firmly seated and not corroded.",
            schematicUrl: null,
          },
          {
            id: 5,
            instruction:
              "Reassemble the access panel and restore power. Run a test cycle on the rinse-only program to verify the repair.",
            schematicUrl: null,
          },
        ],
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
