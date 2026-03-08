/**
 * Cloudinary AI enhancement utilities for Phase 2.
 * Inserts URL transformations (e_enhance for images, q_auto for video)
 * into existing Cloudinary secure_urls.
 */

const CLOUDINARY_HOST = "res.cloudinary.com";

function isCloudinaryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes(CLOUDINARY_HOST);
  } catch {
    return false;
  }
}

/**
 * Inserts a transformation segment into a Cloudinary upload URL.
 * Expects path like .../resource_type/upload/<rest> and produces
 * .../resource_type/upload/<transform>,<rest> or .../upload/<transform>/<rest>
 *
 * Cloudinary expects transformations as a chain before the public_id.
 * Format: /upload/TRANSFORMATIONS/public_id
 * e.g. /upload/e_enhance/v123/folder/id.jpg
 */
function insertTransformation(
  url: string,
  transformation: string
): string {
  const uploadMarker = "/upload/";
  const idx = url.indexOf(uploadMarker);
  if (idx === -1) return url;

  const before = url.slice(0, idx + uploadMarker.length);
  const after = url.slice(idx + uploadMarker.length);
  return `${before}${transformation}/${after}`;
}

/**
 * Returns an AI-enhanced image URL using Cloudinary's e_enhance.
 * Adjusts exposure, color temperature, and vibrancy.
 */
export function getEnhancedImageUrl(secureUrl: string): string {
  if (!secureUrl || !isCloudinaryUrl(secureUrl)) return secureUrl;
  return insertTransformation(secureUrl, "e_enhance");
}

/**
 * Returns an enhanced video URL using q_auto for quality optimization.
 * Cloudinary's AI image effects are image-specific; video uses quality/format optimization.
 */
export function getEnhancedVideoUrl(secureUrl: string): string {
  if (!secureUrl || !isCloudinaryUrl(secureUrl)) return secureUrl;
  return insertTransformation(secureUrl, "q_auto");
}

export type SlotUrlsTuple = [string | null, string | null, string | null];

/**
 * Returns enhanced URLs for the three slots: indices 0,1 = images, 2 = video.
 * Non-Cloudinary URLs and null values are returned as-is.
 */
export function getEnhancedSlotUrls(
  slotUrls: SlotUrlsTuple
): SlotUrlsTuple {
  return [
    slotUrls[0] ? getEnhancedImageUrl(slotUrls[0]) : null,
    slotUrls[1] ? getEnhancedImageUrl(slotUrls[1]) : null,
    slotUrls[2] ? getEnhancedVideoUrl(slotUrls[2]) : null,
  ];
}
