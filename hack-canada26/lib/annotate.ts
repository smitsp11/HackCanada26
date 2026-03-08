import cloudinary, { LOCALIZE_TRANSFORMATION } from "./cloudinary";
import { PixelBox } from "./types";

export function buildAnnotatedUrl(
  publicId: string,
  pixelBox: PixelBox,
  overlayText: string
) {
  const width = Math.max(40, pixelBox.x1 - pixelBox.x0);
  const height = Math.max(40, pixelBox.y1 - pixelBox.y0);

  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      LOCALIZE_TRANSFORMATION,
      {
        overlay: {
          font_family: "Arial",
          font_size: 30,
          font_weight: "bold",
          text: overlayText,
        },
        color: "red",
        background: "white",
        gravity: "north_west",
        x: pixelBox.x0,
        y: Math.max(0, pixelBox.y0 - 50),
      },
      {
        overlay: "red-border-300x300_mox1re",
        width,
        height,
        crop: "scale",
        gravity: "north_west",
        x: pixelBox.x0,
        y: pixelBox.y0,
      },
    ],
  });
}
