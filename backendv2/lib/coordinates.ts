import { PixelBox } from "./types";

export function box2dToPixels(
  box2d: [number, number, number, number],
  width: number,
  height: number
): PixelBox {
  const [y0, x0, y1, x1] = box2d;

  return {
    x0: Math.round((x0 / 1000) * width),
    y0: Math.round((y0 / 1000) * height),
    x1: Math.round((x1 / 1000) * width),
    y1: Math.round((y1 / 1000) * height),
  };
}