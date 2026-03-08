import path from "node:path";
import { expect, test } from "@playwright/test";
import { stabilizeVisuals } from "./helpers";

test.describe("OPERA live SSE visual smoke", () => {
  test("captures key milestones on live stream", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await stabilizeVisuals(page);

    const validImage = path.resolve("public", "vercel.svg");
    await page.locator("input[type='file']").setInputFiles(validImage);

    await expect(
      page.getByText("P H A S E", { exact: false }).first()
    ).toBeVisible();
    await expect(page).toHaveScreenshot("live-phase1-start.png", {
      fullPage: true,
      animations: "disabled",
    });

    await expect(
      page.getByText("P H A S E", { exact: false }).first()
    ).toContainText("2", { timeout: 35000 });
    await expect(page).toHaveScreenshot("live-phase2-cognitive.png", {
      fullPage: true,
      animations: "disabled",
    });

    await expect(page.getByText("M A N U A L", { exact: false })).toBeVisible({
      timeout: 35000,
    });
  });
});
