import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoState, stabilizeVisuals } from "./helpers";

test.describe("OPERA core phase visuals", () => {
  test("IDLE baseline screenshot", async ({ page }) => {
    await gotoState(page, "idle");
    await expect(page).toHaveScreenshot("idle-baseline.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("IDLE drag-over visual state", async ({ page }) => {
    await gotoState(page, "idle");
    const zone = page
      .locator("div")
      .filter({ hasText: /D R O P/ })
      .first();
    await zone.dispatchEvent("dragover", {
      dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
    });
    await expect(page).toHaveScreenshot("idle-dragover.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("IDLE invalid file does not transition", async ({ page }) => {
    await gotoState(page, "idle");
    const invalid = path.resolve("tests/fixtures/invalid.txt");
    await page.locator("input[type='file']").setInputFiles(invalid);
    await expect(page.getByText("D R O P", { exact: false })).toBeVisible();
    await expect(page).toHaveScreenshot("idle-invalid-file.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_1 initial visual", async ({ page }) => {
    await gotoState(page, "phase1-initial");
    await expect(page).toHaveScreenshot("phase1-initial.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_1 complete visual", async ({ page }) => {
    await gotoState(page, "phase1-complete");
    await expect(page).toHaveScreenshot("phase1-complete.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("TRANSITION_CUT overlay visual", async ({ page }) => {
    await gotoState(page, "transition-cut");
    await expect(page).toHaveScreenshot("transition-cut-overlay.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_2 pre-identification visual", async ({ page }) => {
    await gotoState(page, "phase2-pre-id");
    await expect(page).toHaveScreenshot("phase2-pre-identification.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_2 matched/manual visual", async ({ page }) => {
    await gotoState(page, "phase2-matched");
    await expect(page).toHaveScreenshot("phase2-manual-matched.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("PHASE_3 default visual", async ({ page }) => {
    await gotoState(page, "phase3-70");
    await expect(page).toHaveScreenshot("phase3-default.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("COMPLETE visual", async ({ page }) => {
    await gotoState(page, "complete-with-schematic");
    await expect(page).toHaveScreenshot("complete-view.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("ERROR visual", async ({ page }) => {
    await gotoState(page, "error");
    await expect(page).toHaveScreenshot("error-view.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("post-cut handoff frame visual", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await stabilizeVisuals(page);
    await expect(page).toHaveScreenshot("post-cut-handoff-idle.png", {
      fullPage: true,
      animations: "disabled",
    });
  });
});
