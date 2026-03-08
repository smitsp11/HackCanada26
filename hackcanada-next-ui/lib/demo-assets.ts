/**
 * Hardcoded demo asset paths for Phase 1 and Phase 2.
 * Images: public/demo-assets/model_enhanced.png, additional_enhanced.png
 * Video: public/demo-assets/demo_video.mp4 (add your file to this path)
 */

export const DEMO_ASSET_URLS = [
  "/demo-assets/model_enhanced.png",
  "/demo-assets/additional_enhanced.png",
  "/demo-assets/demo_video.mp4",
] as const;

export type DemoAssetUrls = readonly [string, string, string];

export const DEFAULT_DEMO_SYMPTOM = "Furnace igniter fault — ceramic igniter crack detected";
