import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

export const LOCALIZE_TARGET_WIDTH = 768;
export const LOCALIZE_TRANSFORMATION = {
  width: LOCALIZE_TARGET_WIDTH,
  crop: "limit",
  quality: "auto",
  fetch_format: "auto",
} as const;

export function getLocalizeDimensions(
  originalWidth: number,
  originalHeight: number
) {
  const scale = Math.min(1, LOCALIZE_TARGET_WIDTH / originalWidth);

  return {
    localizeWidth: Math.max(1, Math.round(originalWidth * scale)),
    localizeHeight: Math.max(1, Math.round(originalHeight * scale)),
  };
}

export default cloudinary;
