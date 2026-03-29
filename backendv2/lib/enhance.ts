const CLOUDINARY_HOST = "res.cloudinary.com";

function isCloudinaryUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes(CLOUDINARY_HOST);
  } catch {
    return false;
  }
}

/**
 * Inserts e_enhance transformation into a Cloudinary upload URL.
 * Returns the original URL unchanged if it's not a Cloudinary URL.
 */
export function getEnhancedImageUrl(secureUrl: string): string {
  if (!secureUrl || !isCloudinaryUrl(secureUrl)) return secureUrl;

  const marker = "/upload/";
  const idx = secureUrl.indexOf(marker);
  if (idx === -1) return secureUrl;

  const before = secureUrl.slice(0, idx + marker.length);
  const after = secureUrl.slice(idx + marker.length);
  return `${before}e_enhance/${after}`;
}
