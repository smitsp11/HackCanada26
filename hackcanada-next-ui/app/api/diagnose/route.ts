import { NextRequest } from "next/server";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: NextRequest) {
  const rawUrls = request.nextUrl.searchParams.get("urls");
  let assetUrls: string[] = [];
  try {
    if (rawUrls) assetUrls = JSON.parse(rawUrls);
  } catch {
    /* ignore parse errors */
  }

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
          url: assetUrls[i] || `/api/diagnose/placeholder?slot=${i}`,
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
              "Turn off gas and electrical supplies to furnace. CAUTION: ELECTRICAL SHOCK AND FIRE HAZARD — Failure to follow this warning could result in personal injury, death, and/or property damage. Turn off the gas and electrical supplies to the furnace and install lockout tag before performing any maintenance or service.",
            schematicUrl: null,
          },
          {
            id: 2,
            instruction:
              "Remove control door.",
            schematicUrl: null,
          },
          {
            id: 3,
            instruction:
              "Disconnect igniter wire connection.",
            schematicUrl: null,
          },
          {
            id: 4,
            instruction:
              "Check igniter resistance across both igniter leads in connector using an ohm meter. Cold reading should be between 40 ohms and 70 ohms.",
            schematicUrl: null,
          },
          {
            id: 5,
            instruction:
              "Using a 1/4-in. driver, remove the two screws securing the igniter mounting bracket to the burner assembly. Carefully withdraw the igniter and bracket assembly through the front of the burner assembly without striking surrounding parts. Inspect igniter for signs of damage or failure. If replacement is required, remove the screw that secures the igniter on igniter bracket and remove the igniter.",
            schematicUrl: null,
          },
          {
            id: 6,
            instruction:
              "To replace igniter and bracket assembly, reverse the removal steps (5a through 5d).",
            schematicUrl: null,
          },
          {
            id: 7,
            instruction:
              "Reconnect igniter harness to the igniter, dressing the igniter wires to ensure there is no tension on the igniter itself.",
            schematicUrl: null,
          },
          {
            id: 8,
            instruction:
              "Turn on gas and electrical supplies to furnace.",
            schematicUrl: null,
          },
          {
            id: 9,
            instruction:
              "Verify igniter operation by initiating control board self-test feature or by cycling thermostat.",
            schematicUrl: null,
          },
          {
            id: 10,
            instruction:
              "Replace control door.",
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
