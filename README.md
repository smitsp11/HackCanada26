# Opera AI · HackCanada 2026

**Opera AI** turns product photos and a symptom description into step-by-step repair guides with annotated schematics. Upload images, describe the fault, and get a visual diagnostic pipeline that localizes parts and produces actionable instructions.

---

## Pitch

<!-- Replace with your four-sentence pitch -->

*[Sentence 1: The problem you're solving.]*

*[Sentence 2: Why it matters / who it's for.]*

*[Sentence 3: How Opera AI solves it—your approach.]*

*[Sentence 4: What you built / what's next.]*

---

## How It Works

1. **Ingest** — Upload model photos, a supplementary image, and optional video. Cloudinary enhances and stores the media.
2. **Analyze** — Gemini AI identifies the device, matches parts to the symptom, and runs a cognitive check. Plan-localization pinpoints target components on your images.
3. **Synthesize** — AI generates repair steps with cautions, tool hints, and visual descriptions. Schematics and annotated overlays are attached to each step.
4. **Deliver** — A guided result pane with clickable steps, downloadable PDF-ready output, and optional demo mode for walkthroughs.

---

## Knowledge Base (Fairness & Grounding)

Opera AI relies on a curated corpus stored for fairness and consistent quality:

- **Manuals** — Potential repair manuals (OEM service guides, technical documentation) are stored in a structured corpus so Gemini can cross-reference symptoms and retrieve relevant sections instead of relying on generic training data. This ensures solutions draw from authoritative sources and are available to all users regardless of device make or model.
- **YouTube videos** — Associated repair and troubleshooting videos are indexed and scraped so Gemini can incorporate real-world walkthroughs, audio/visual anomaly patterns, and technician insights into problem identification and solution generation. The combination of manuals and video content produces more accurate, grounded diagnostics and step-by-step instructions.

---

## Architecture

| Layer | Stack |
|-------|-------|
| **Frontend** | Next.js 16, React 19, Tailwind 4, Framer Motion, GSAP |
| **Backend** | Next.js API routes, Cloudinary, Google Gemini |
| **AI / CV** | Gemini for structured extraction, plan-localization, part matching |
| **Media** | Cloudinary (upload, enhance, localize, annotate) |

```
HackCanada26/
├── hackcanada-next-ui/    # Main UI + /api/diagnose proxy
│   ├── app/               # Pages, layout, API routes
│   ├── components/opera/ # Ingestion, cognitive, synthesis, result
│   └── lib/               # SSE, events, schematics, demo assets
└── backendv2/             # Processing APIs (process, localize, annotate, plan-localization)
    ├── app/api/
    └── lib/               # Gemini, Cloudinary, types, localize, annotate
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- [Cloudinary](https://cloudinary.com) account
- [Google AI](https://ai.google.dev) API key (Gemini)

### 1. Frontend

```bash
cd hackcanada-next-ui
cp .env.example .env
# Edit .env with NEXT_PUBLIC_* and API URLs
npm install
npm run dev
```

Runs at `http://localhost:3000`.

### 2. Backend

```bash
cd backendv2
cp .env.example .env
# Add CLOUDINARY_*, GEMINI_API_KEY, etc.
npm install
npm run dev
```

Runs at `http://localhost:3001`.

### 3. Vercel Deployment

Set the **Root Directory** to `hackcanada-next-ui` in your Vercel project settings so the build picks up the Next.js app.

---

## Demo Mode

Without uploading, the app falls back to demo assets (furnace igniter fault). Use the “Try demo” flow on the home screen to see the full pipeline without configuration.

---

## License

MIT · Built at HackCanada 2026.
