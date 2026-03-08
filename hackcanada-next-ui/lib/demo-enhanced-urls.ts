/**
 * Pre-loaded demo URLs for Phase 2.
 * Uses local demo assets (furnace images + video) from public/demo-assets/.
 */

import type { SlotUrlsTuple } from "./cloudinary-enhance";
import { DEMO_ASSET_URLS } from "./demo-assets";

/**
 * Returns the demo asset URLs for Phase 2 thumbnails.
 * Same as Phase 1: model_enhanced.png, additional_enhanced.png, demo_video.m4a.
 */
export function getDemoEnhancedUrls(): SlotUrlsTuple {
  return [...DEMO_ASSET_URLS] as SlotUrlsTuple;
}
