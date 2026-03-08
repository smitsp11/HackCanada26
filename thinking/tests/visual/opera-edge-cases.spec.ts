import { expect, test } from "@playwright/test";
import { gotoState } from "./helpers";

test.describe("OPERA visual edge cases", () => {
  test("PHASE_1 mixed slot statuses and log overflow", async ({ page }) => {
    await gotoState(page, "phase1-mixed");
    await expect(page).toHaveScreenshot("phase1-mixed-overflow.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_3 progress at 0", async ({ page }) => {
    await gotoState(page, "phase3-0");
    await expect(page).toHaveScreenshot("phase3-progress-0.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_3 progress at 30", async ({ page }) => {
    await gotoState(page, "phase3-30");
    await expect(page).toHaveScreenshot("phase3-progress-30.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_3 progress at 100", async ({ page }) => {
    await gotoState(page, "phase3-100");
    await expect(page).toHaveScreenshot("phase3-progress-100.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_3 clamped low progress", async ({ page }) => {
    await gotoState(page, "phase3-clamp-low");
    await expect(page).toHaveScreenshot("phase3-clamp-low.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_3 clamped high progress", async ({ page }) => {
    await gotoState(page, "phase3-clamp-high");
    await expect(page).toHaveScreenshot("phase3-clamp-high.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("COMPLETE no-schematics fallback", async ({ page }) => {
    await gotoState(page, "complete-no-schematic");
    await expect(page).toHaveScreenshot("complete-no-schematic.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("COMPLETE with schematics cards", async ({ page }) => {
    await gotoState(page, "complete-with-schematic");
    await expect(page).toHaveScreenshot("complete-with-schematic.png", {
      fullPage: true,
      animations: "disabled",
    });
  });
});
