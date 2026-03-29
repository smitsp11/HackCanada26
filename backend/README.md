# FastAPI backend

This is a clean FastAPI replacement for the old `backendv2` Next.js API-routes backend.

## Routes (frontend-compatible)

- `POST /api/process` (expects `multipart/form-data` with `file` and `step` JSON string)
- `POST /api/identify-product` (expects JSON `{ "imageUrl": "..." }`)
- `GET /health`

## Run locally

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 3001
```

Your frontend already proxies:

- `hackcanada-next-ui/app/api/process/route.ts` via `PROCESS_API_URL`
- `hackcanada-next-ui/app/api/identify-product/route.ts` via `IDENTIFY_API_URL` (or derived from `PROCESS_API_URL`)

So for local dev you can set, for example:

```bash
PROCESS_API_URL=http://localhost:3001/api/process
IDENTIFY_API_URL=http://localhost:3001
```

