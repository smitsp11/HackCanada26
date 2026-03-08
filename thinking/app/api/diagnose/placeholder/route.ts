import { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const slot = req.nextUrl.searchParams.get("slot") ?? "X";
  const label = `SLOT_${slot}`;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <rect width="640" height="480" fill="#e5e5e5"/>
  <rect x="24" y="24" width="592" height="432" fill="#ffffff" stroke="#000000" stroke-width="2"/>
  <text x="320" y="250" font-family="monospace" font-size="42" text-anchor="middle" fill="#000000">${label}</text>
</svg>
`.trim();

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
