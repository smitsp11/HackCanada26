import { expect, type Page } from "@playwright/test";

export async function stabilizeVisuals(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
      html, body {
        scroll-behavior: auto !important;
      }
    `,
  });
}

export async function gotoState(page: Page, state: string) {
  await page.goto(`/?state=${state}`);
  await page.waitForLoadState("networkidle");
  await stabilizeVisuals(page);
  await expect(page.locator("body")).toBeVisible();
}
