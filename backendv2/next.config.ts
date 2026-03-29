import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp requires native libvips binaries. Works in containers and
  // standard Node runtimes. If deploying to a serverless platform (e.g.
  // Vercel Functions), verify the runtime includes native binary support
  // or use the NEXT_SHARP_PATH env var to point to a pre-built binary.
  serverExternalPackages: ["tesseract.js", "sharp"],
};

export default nextConfig;
