"""End-to-end through the real Next.js proxy, making the calls the browser makes.

    # with backend on :8000 and `npm run dev` on :3000
    ./.venv/bin/python -m tests.e2e_frontend

Every request goes to the Next.js server on :3000 exactly as the browser sends
it - same paths, same bodies, same dialect - except the S3 PUT, which the
browser also sends directly to the presigned URL. So this exercises the proxy's
auth forwarding, the request-shape adapters, the presigned upload, the pipeline,
and the SSE translation layer together.

The captured stream is then replayed through a model of the frontend's phase
machine; the run passes only if the UI would actually reach COMPLETE.
"""

from __future__ import annotations

import json
import mimetypes
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from test_ui_compat import FrontendPhaseModel  # noqa: E402

UI = "http://localhost:3000"
FIXTURES = Path(__file__).parent.parent / "fixtures"
SLOTS = [("model", "opera-img2.png"), ("additional", "opera-img1.png"), ("video", "opera-vid.mp4")]
SYMPTOM = (
    "Furnace tries to start, igniter glows, but no flame. After several attempts "
    "it stops and the board light blinks 3 short 4 long."
)

# Every type the frontend's switch statement handles. Anything else is ignored.
KNOWN_TYPES = {
    "case_status", "preprocessing_progress", "asset_preprocessed", "slot_processing",
    "slot_complete", "understanding_start", "understanding_progress",
    "understanding_complete", "device_identified", "manual_found",
    "symptom_sections_found", "parts_check_complete", "synthesis_progress",
    "synthesis_complete", "error",
}


def step(msg: str) -> None:
    print(f"\n-- {msg}")


def main() -> int:
    c = httpx.Client(base_url=UI, timeout=120)
    t0 = time.time()

    step("POST /api/cases  (app/page.tsx on mount)")
    r = c.post("/api/cases", json={})
    r.raise_for_status()
    case_id = r.json()["case_id"]
    print(f"   case_id={case_id}")

    for slot, name in SLOTS:
        path = FIXTURES / name
        mime = mimetypes.guess_type(name)[0]
        step(f"upload slot '{slot}' ({name})  (lib/upload.ts)")
        reg = c.post(f"/api/cases/{case_id}/assets/register", json={
            "filename": name,
            "mime_type": mime,
            "asset_type": "video" if mime.startswith("video/") else "image",
            "size_bytes": path.stat().st_size,
            "slot_key": slot,
        })
        if reg.status_code >= 400:
            print(f"   REGISTER FAILED {reg.status_code}: {reg.text}")
            return 1
        reg = reg.json()
        method = reg.get("upload_method", "PUT")
        print(f"   registered {reg['asset_id']}  method={method}")

        # The browser PUTs straight to storage with Content-Type = file.type.
        put = httpx.put(reg["upload_url"], content=path.read_bytes(),
                        headers={"Content-Type": mime}, timeout=300)
        print(f"   S3 PUT -> {put.status_code}")
        if put.status_code >= 300:
            print(f"   {put.text[:300]}")
            return 1

        done = c.post(f"/api/cases/{case_id}/assets/{reg['asset_id']}/complete", json={})
        print(f"   complete -> {done.status_code} {done.json().get('status')}")
        if done.status_code >= 400:
            print(f"   {done.text}")
            return 1

    step("POST /input  (app/page.tsx on Execute - frontend dialect)")
    r = c.post(f"/api/cases/{case_id}/input", json={
        "description": SYMPTOM, "metadata": {"brand": "Carrier"}, "assets": [],
    })
    print(f"   -> {r.status_code}")
    r.raise_for_status()

    step("GET /api/cases/{id}/events  (hooks/useSSE.ts via the Next.js proxy)")
    events, named, unknown, raw_frames = [], [], [], 0
    with c.stream("GET", f"/api/cases/{case_id}/events",
                  headers={"Accept": "text/event-stream"}, timeout=600) as resp:
        print(f"   status={resp.status_code} content-type={resp.headers.get('content-type')}")
        for line in resp.iter_lines():
            if line.startswith("event:"):
                named.append(line)
            if not line.startswith("data:"):
                continue
            raw_frames += 1
            e = json.loads(line[5:].strip())
            events.append(e)
            if e.get("type") not in KNOWN_TYPES:
                unknown.append(e.get("type"))
            label = {
                "slot_complete": lambda: f"slot {e['slotIndex']} url={'yes' if e.get('url') else 'NO'}",
                "case_status": lambda: e["status"],
                "device_identified": lambda: e["makeModel"],
                "manual_found": lambda: f"{e['manualId']} / {e['title']}",
                "symptom_sections_found": lambda: e["sections"][:110],
                "parts_check_complete": lambda: e["parts"][:110],
                "synthesis_progress": lambda: f"{e['percent']:>3}%  {e['log']}",
                "synthesis_complete": lambda: f"{len(e['steps'])} steps",
                "error": lambda: e["message"],
            }.get(e["type"], lambda: "")()
            print(f"   {time.time()-t0:6.1f}s  {e['type']:24} {label}")
            if e["type"] in ("synthesis_complete", "error"):
                break

    step("verdict")
    model = FrontendPhaseModel().run(events)
    checks = [
        ("no named SSE frames (browser would drop them)", not named),
        ("every type is one the UI handles", not unknown),
        ("3 slots delivered with URLs", sum(1 for e in events if e["type"] == "slot_complete" and e.get("url")) == 3),
        ("device identified", any(e["type"] == "device_identified" for e in events)),
        ("manual found", any(e["type"] == "manual_found" for e in events)),
        ("parts gate fired (phase 2 -> 3)", any(e["type"] == "parts_check_complete" for e in events)),
        ("UI reaches COMPLETE", model.phase == "COMPLETE"),
        ("result has steps", bool(model.repair_steps)),
    ]
    ok = True
    for name, passed in checks:
        ok &= passed
        print(f"   {'PASS' if passed else 'FAIL'}  {name}")
    if unknown:
        print(f"   unknown types: {sorted(set(unknown))}")

    if model.repair_steps:
        print("\n   result screen:")
        for s in model.repair_steps:
            print(f"   {s['id']:02d}. {s['instruction'][:140]}")

    print(f"\n{'ALL PASS' if ok else 'FAILED'} in {time.time()-t0:.0f}s   case_id={case_id}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
