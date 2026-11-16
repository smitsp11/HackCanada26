# Opera AI: frontend

Next.js 16 / React 19 UI for Opera AI. See the [project README](../README.md)
for the overall system.

```bash
npm install
npm run dev     # http://localhost:3000
```

`.env.local`:

```
BACKEND_URL=http://localhost:8000
BACKEND_API_TOKEN=<same value as the backend's API_BEARER_TOKEN>
```

The token has no `NEXT_PUBLIC_` prefix, so it never reaches the browser.

## How it talks to the backend

The browser only calls this app's own `/api/cases/*` routes. Those routes proxy
to FastAPI and attach the bearer token on the server side. Photos and video
are the one exception: they go straight from the browser to S3 via presigned
PUT URLs, so large files never pass through either server.

The results screen is driven by a single SSE stream,
`/api/cases/{id}/events`, which proxies to the backend's `/ui-events`. The
reducer in [hooks/useOperaReducer.ts](hooks/useOperaReducer.ts) moves through
three phases:
1. ingestion;
2. analysis;
3. synthesis.

| Path | |
|---|---|
| `app/page.tsx`, `app/components/InputScreen.tsx` | Upload slots (nameplate, interior, video) and the symptom field |
| `app/diagnostic/page.tsx`, `components/opera/` | The three-phase diagnostic view and the result pane |
| `app/api/cases/` | Server-side proxy routes to the backend |
| `hooks/useSSE.ts`, `lib/events.ts` | Event stream client and event types |
| `lib/upload.ts` | The register → PUT → complete upload flow |
