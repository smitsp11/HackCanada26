/**
 * Mapping from repair step ID to schematic image URL.
 *
 * Place your step figure images under `public/schematics/` with the
 * filenames below, or update this mapping to match your assets.
 */

import type { RepairStep } from "./events";

export const REPAIR_STEP_SCHEMATICS: Record<number, string> = {
  1: "/schematics/fig1.png",
  2: "/schematics/fig2.png",
  3: "/schematics/fig3.png",
  4: "/schematics/fig4.png",
  5: "/schematics/fig5.png",
  6: "/schematics/fig6.png",
  7: "/schematics/fig7.png",
  8: "/schematics/fig8.png",
  9: "/schematics/fig9.png",
  10: "/schematics/fig10.png",
};

export function getSchematicUrlForStep(id: number): string | null {
  return REPAIR_STEP_SCHEMATICS[id] ?? null;
}

export function attachSchematics(steps: RepairStep[]): RepairStep[] {
  return steps.map((step) => ({
    ...step,
    schematicUrl: getSchematicUrlForStep(step.id),
  }));
}
