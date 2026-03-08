/**
 * Mapping from repair step ID to schematic image URL.
 *
 * Place your step figure images under `public/schematics/` with the
 * filenames below, or update this mapping to match your assets.
 */

import type { RepairStep } from "./events";

export const REPAIR_STEP_SCHEMATICS: Record<number, string> = {
  1: "/schematics/step01_power_gas_off.png",
  2: "/schematics/step02_remove_control_door.png",
  3: "/schematics/step03_disconnect_igniter_harness.png",
  4: "/schematics/step04_check_igniter_resistance.png",
  5: "/schematics/step05_remove_igniter_bracket.png",
  6: "/schematics/step06_replace_igniter_assembly.png",
  7: "/schematics/step07_reconnect_igniter_harness.png",
  8: "/schematics/step08_turn_on_power_gas.png",
  9: "/schematics/step09_verify_igniter_operation.png",
  10: "/schematics/step10_replace_control_door.png",
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
