import Tesseract from "tesseract.js";

/**
 * Downloads an image from the given URL and runs Tesseract OCR on it.
 * Returns the recognized text.
 */
export async function extractText(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch image for OCR: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { data } = await Tesseract.recognize(buffer, "eng", {
    logger: () => {},
  });

  return data.text;
}
