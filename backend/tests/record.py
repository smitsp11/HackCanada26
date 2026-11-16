"""Record golden pipeline output for the cases in tests/cases.json.

    ./.venv/bin/python -m tests.record              # all cases
    ./.venv/bin/python -m tests.record furnace_no_flame_no_code

Goes through the real HTTP routes (via TestClient, so no separate server) so
the recording exercises auth, upload, persistence and the run endpoint - not
just the stage functions.

Each run costs real money (~$0.07/case), which is exactly why the assertions in
test_phase_a.py read these files instead of re-running the pipeline.
"""

from __future__ import annotations

import json
import mimetypes
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

HERE = Path(__file__).parent
FIXTURES = Path("fixtures")
GOLDEN = HERE / "golden"


def run_case(client: TestClient, case: dict) -> dict:
    auth = {"Authorization": f"Bearer {settings.api_bearer_token}"}

    r = client.post("/api/cases", json={"appliance_type_hint": "furnace"}, headers=auth)
    r.raise_for_status()
    case_id = r.json()["case_id"]

    for asset in case["assets"]:
        path = FIXTURES / asset["file"]
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        r = client.post(
            f"/api/cases/{case_id}/assets",
            headers=auth,
            data={"role": asset["role"]},
            files={"file": (path.name, path.read_bytes(), mime)},
        )
        r.raise_for_status()

    r = client.post(
        f"/api/cases/{case_id}/input",
        headers=auth,
        json={"symptom": case["symptom"], "error_code": case.get("error_code")},
    )
    r.raise_for_status()

    t = time.time()
    r = client.post(f"/api/cases/{case_id}/run", headers=auth)
    r.raise_for_status()
    result = r.json()

    # Prove the result survives independently of the request that made it.
    persisted = client.get(f"/api/cases/{case_id}", headers=auth).json()
    result["_persisted"] = {
        "status": persisted["status"],
        "manual_id": persisted["manual_id"],
        "cause_count": len((persisted.get("summary") or {}).get("causes", [])),
        "stages": [s["stage"] for s in persisted["stages"]],
    }
    result["_case_id"] = case_id
    result["_elapsed_sec"] = round(time.time() - t, 1)
    return result


def main() -> int:
    wanted = set(sys.argv[1:])
    cases = json.loads((HERE / "cases.json").read_text())
    if wanted:
        cases = [c for c in cases if c["id"] in wanted]
        if not cases:
            print(f"no case matched {wanted}", file=sys.stderr)
            return 1

    GOLDEN.mkdir(exist_ok=True)
    total = 0.0
    with TestClient(app) as client:
        for case in cases:
            print(f"recording {case['id']} ...", flush=True)
            try:
                result = run_case(client, case)
            except Exception as e:
                print(f"  FAILED: {type(e).__name__}: {e}")
                continue
            (GOLDEN / f"{case['id']}.json").write_text(json.dumps(result, indent=2))
            cost = result["meta"]["cost_usd"]
            total += cost
            print(
                f"  {result['_elapsed_sec']}s  ${cost:.4f}  "
                f"{len(result['summary']['causes'])} causes  "
                f"identity={result['identity'].get('unit_number')}"
            )
    print(f"\ntotal ${total:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
