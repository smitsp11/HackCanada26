import sharp from "sharp";

const HASH_SIZE = 8;
const RESIZE_DIM = HASH_SIZE + 1;

/**
 * Computes a 64-bit difference hash (dHash) for an image buffer.
 * Resizes to 9x8 grayscale, compares adjacent horizontal pixels.
 * Returns a hex string representation of the 64-bit hash.
 */
export async function computeDHash(buffer: Buffer): Promise<string> {
  const pixels = await sharp(buffer)
    .grayscale()
    .resize(RESIZE_DIM, HASH_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();

  let hash = BigInt(0);
  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const idx = row * RESIZE_DIM + col;
      if (pixels[idx] < pixels[idx + 1]) {
        hash |= BigInt(1) << BigInt(row * HASH_SIZE + col);
      }
    }
  }

  return hash.toString(16).padStart(16, "0");
}

/**
 * Computes the Hamming distance between two hex-encoded dHash strings.
 * Returns the number of differing bits (0 = identical, 64 = maximally different).
 */
export function hammingDistance(hashA: string, hashB: string): number {
  const a = BigInt(`0x${hashA}`);
  const b = BigInt(`0x${hashB}`);
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

export const PERCEPTUAL_DUPLICATE_THRESHOLD = 5;
