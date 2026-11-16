"""Real-browser end-to-end test, driving the actual UI in headless Chrome.

    # backend on :8000, `npm run dev` on :3000
    ./.venv/bin/python -m tests.browser_e2e              # fresh run through the input screen
    ./.venv/bin/python -m tests.browser_e2e <case_id>    # open an existing case's diagnostic page

Every other test mocks or bypasses the browser. That blind spot let a real bug
through: under React StrictMode (on by default in `next dev`) OperaShell never
enabled its EventSource, so the diagnostic page sat on phase 1 forever while
the proxy-level tests passed. This one runs React, StrictMode and the real
EventSource, and only passes if the page visibly reaches the result screen.

Uses the installed Google Chrome (channel="chrome"); no browser download.
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

UI = "http://localhost:3000"
FIXTURES = Path(__file__).parent.parent / "fixtures"
FILES = [FIXTURES / "opera-img2.png", FIXTURES / "opera-img1.png", FIXTURES / "opera-vid.mp4"]
SYMPTOM = ("Furnace tries to start, igniter glows, but no flame. After several attempts "
           "it stops and the board light blinks 3 short 4 long.")

# Text that only appears on each screen, most advanced first.
PHASES = [
    ("COMPLETE", re.compile(r"S\s*C\s*H\s*E\s*M\s*A\s*T\s*I\s*C\s*S|NO SCHEMATICS AVAILABLE")),
    ("ERROR", re.compile(r"SYSTEM ERROR", re.I)),
    ("PHASE_3", re.compile(r"SYNTHES", re.I)),
    ("PHASE_2", re.compile(r"MATCH_FOUND|MANUAL LOCATED|PARTS CHECK", re.I)),
    ("PHASE_1", re.compile(r"LOCKED")),
]


def current_phase(text: str) -> str:
    for name, pattern in PHASES:
        if pattern.search(text):
            return name
    return "UNKNOWN"


def run(case_id: str | None, timeout_s: int) -> int:
    t0 = time.time()
    stamp = lambda: f"{time.time() - t0:6.1f}s"  # noqa: E731

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.add_init_script("sessionStorage.setItem('opera-intro-seen', '1')")

        sse_opened, console_errors = [], []
        page.on("request", lambda r: sse_opened.append(r.url)
                if re.search(r"/api/cases/[^/]+/events", r.url) else None)
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

        if case_id:
            print(f"{stamp()}  opening diagnostic page for {case_id}")
            page.goto(f"{UI}/diagnostic?caseId={case_id}")
        else:
            print(f"{stamp()}  opening input screen")
            # The page creates its case eagerly on mount. A file selected before
            # that returns is shown in its slot but never uploaded
            # (InputScreen: `if (!caseId) return;`), leaving Execute disabled
            # for good. Real users can't hit this - the upload buttons are
            # disabled until the case exists - so wait exactly as they must.
            with page.expect_response(
                lambda r: r.url.rstrip("/").endswith("/api/cases") and r.request.method == "POST",
                timeout=30000,
            ) as created:
                page.goto(UI)
            print(f"{stamp()}  case created ({created.value.status})")
            page.wait_for_selector('input[type="file"]', state="attached", timeout=30000)
            inputs = page.locator('input[type="file"]')
            print(f"{stamp()}  {inputs.count()} file inputs; uploading 3 fixtures")
            for i, f in enumerate(FILES):
                inputs.nth(i).set_input_files(str(f))
            page.fill('textarea', SYMPTOM)
            execute = page.get_by_role("button", name=re.compile("Execute Diagnostic", re.I))
            execute.wait_for(state="visible", timeout=30000)
            # Enabled only once all three presigned uploads have completed.
            page.wait_for_function(
                "() => { const b=[...document.querySelectorAll('button')].find(b=>/Execute Diagnostic/i.test(b.textContent||'')); return b && !b.disabled; }",
                timeout=180000,
            )
            print(f"{stamp()}  uploads complete; clicking Execute Diagnostic")
            execute.click()
            page.wait_for_url(re.compile(r"/diagnostic\?caseId="), timeout=60000)
            case_id = page.url.split("caseId=")[-1]
            print(f"{stamp()}  navigated to diagnostic page, case {case_id}")

        seen, last = [], None
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            phase = current_phase(page.inner_text("body"))
            if phase != last:
                seen.append(phase)
                print(f"{stamp()}  screen -> {phase}")
                last = phase
            if phase in ("COMPLETE", "ERROR"):
                break
            time.sleep(1)

        body = page.inner_text("body")
        page.screenshot(path="/tmp/opera-browser-final.png", full_page=True)
        browser.close()

    final = seen[-1] if seen else "UNKNOWN"
    checks = [
        ("browser opened the event stream", bool(sse_opened)),
        ("page left phase 1", any(s in seen for s in ("PHASE_2", "PHASE_3", "COMPLETE"))),
        ("page reached the result screen", final == "COMPLETE"),
        ("result screen names the technician verdict", "licensed technician" in body),
        ("result screen carries manual page references", "manual p." in body),
    ]
    print()
    ok = True
    for name, passed in checks:
        ok &= passed
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
    if console_errors:
        print(f"\n  console errors ({len(console_errors)}):")
        for e in console_errors[:5]:
            print(f"    {e[:160]}")
    print(f"\n  screenshot: /tmp/opera-browser-final.png")
    print(f"{'ALL PASS' if ok else 'FAILED'} in {time.time()-t0:.0f}s  case={case_id}")
    return 0 if ok else 1


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    raise SystemExit(run(arg, timeout_s=90 if arg else 420))
