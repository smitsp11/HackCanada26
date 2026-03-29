#!/usr/bin/env npx tsx
/**
 * Interactive self-test script for the OPERA Input Ingestion Layer.
 * Tests the running backend against the part1.md specification.
 *
 * Usage:  npm run self-test
 *    or:  npx tsx scripts/self-test.ts [--base-url http://localhost:3001]
 */

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--base-url") + 1]
  ?? "http://localhost:3001";

interface TestResult {
  name: string;
  section: string;
  passed: boolean;
  detail: string;
  duration_ms: number;
}

const results: TestResult[] = [];
let caseId = "";
let assetId = "";

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

function log(msg: string) {
  console.log(msg);
}

function header(text: string) {
  log(`\n${COLORS.bold}${COLORS.cyan}━━━ ${text} ━━━${COLORS.reset}`);
}

function pass(name: string) {
  log(`  ${COLORS.green}✓${COLORS.reset} ${name}`);
}

function fail(name: string, detail: string) {
  log(`  ${COLORS.red}✗${COLORS.reset} ${name}`);
  log(`    ${COLORS.dim}${detail}${COLORS.reset}`);
}

async function test(
  section: string,
  name: string,
  fn: () => Promise<{ passed: boolean; detail: string }>,
): Promise<void> {
  const start = Date.now();
  try {
    const { passed, detail } = await fn();
    const duration_ms = Date.now() - start;
    results.push({ name, section, passed, detail, duration_ms });
    if (passed) {
      pass(name);
    } else {
      fail(name, detail);
    }
  } catch (err) {
    const duration_ms = Date.now() - start;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, section, passed: false, detail, duration_ms });
    fail(name, detail);
  }
}

async function json(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

// ─────────────────────────────────────────────
// Test Sections
// ─────────────────────────────────────────────

async function testCaseCreation() {
  header("Section 9 — POST /cases (Create Case)");

  await test("API", "POST /cases returns 201 with case_id and status=created", async () => {
    const res = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliance_type_hint: "dishwasher" }),
    });
    const data = (await json(res)) as Record<string, unknown>;
    caseId = data.case_id as string;

    return {
      passed: res.status === 201 && !!caseId && data.status === "created",
      detail: `status=${res.status}, case_id=${caseId}, body=${JSON.stringify(data)}`,
    };
  });

  await test("API", "POST /cases without body still works (optional appliance_type_hint)", async () => {
    const res = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = (await json(res)) as Record<string, unknown>;

    return {
      passed: res.status === 201 && !!data.case_id,
      detail: `status=${res.status}, body=${JSON.stringify(data)}`,
    };
  });
}

async function testCaseRetrieval() {
  header("Section 9 — GET /cases/{caseId} (Poll Case)");

  await test("API", "GET /cases/{caseId} returns case with assets and jobs arrays", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}`);
    const data = (await json(res)) as Record<string, unknown>;

    return {
      passed:
        res.status === 200 &&
        data.case_id === caseId &&
        Array.isArray(data.assets) &&
        Array.isArray(data.jobs),
      detail: `status=${res.status}, has_assets=${Array.isArray(data.assets)}, has_jobs=${Array.isArray(data.jobs)}`,
    };
  });

  await test("API", "GET /cases/nonexistent returns 404", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/case_nonexistent_12345`);
    return {
      passed: res.status === 404,
      detail: `status=${res.status}`,
    };
  });
}

async function testAssetRegistration() {
  header("Section 9 — POST /cases/{caseId}/assets/register");

  await test("API", "Register valid image asset returns 201 with asset_id + upload_url", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/assets/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "panel.jpg",
        mime_type: "image/jpeg",
        asset_type: "image",
        size_bytes: 2_000_000,
        slot_key: "model",
      }),
    });
    const data = (await json(res)) as Record<string, unknown>;
    assetId = data.asset_id as string;

    return {
      passed: res.status === 201 && !!data.asset_id && !!data.upload_url && !!data.expires_at,
      detail: `status=${res.status}, asset_id=${data.asset_id}, has_upload_url=${!!data.upload_url}`,
    };
  });

  await test("API", "Rejects disallowed MIME type (image/gif)", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/assets/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "animation.gif",
        mime_type: "image/gif",
        asset_type: "image",
        size_bytes: 500_000,
      }),
    });

    return {
      passed: res.status === 400,
      detail: `status=${res.status} (expected 400)`,
    };
  });

  await test("API", "Rejects oversized image (>20 MB)", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/assets/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "huge.jpg",
        mime_type: "image/jpeg",
        asset_type: "image",
        size_bytes: 25_000_000,
      }),
    });

    return {
      passed: res.status === 413,
      detail: `status=${res.status} (expected 413)`,
    };
  });

  await test("API", "Rejects oversized video (>500 MB)", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/assets/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "large.mp4",
        mime_type: "video/mp4",
        asset_type: "video",
        size_bytes: 600_000_000,
      }),
    });

    return {
      passed: res.status === 413,
      detail: `status=${res.status} (expected 413)`,
    };
  });

  await test("API", "Rejects missing required fields", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/assets/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "panel.jpg" }),
    });

    return {
      passed: res.status === 400,
      detail: `status=${res.status} (expected 400)`,
    };
  });

  await test("API", "Rejects registration on non-existent case", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/case_nonexistent/assets/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "panel.jpg",
        mime_type: "image/jpeg",
        asset_type: "image",
        size_bytes: 1_000_000,
      }),
    });

    return {
      passed: res.status === 404,
      detail: `status=${res.status} (expected 404)`,
    };
  });
}

async function testAssetComplete() {
  header("Section 9 — POST /cases/{caseId}/assets/{assetId}/complete");

  await test("API", "Complete returns response for registered asset", async () => {
    if (!assetId) return { passed: false, detail: "No asset_id from registration" };

    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/assets/${assetId}/complete`, {
      method: "POST",
    });
    const data = (await json(res)) as Record<string, unknown>;

    return {
      passed: res.status === 200 && data.asset_id === assetId,
      detail: `status=${res.status}, body=${JSON.stringify(data)}`,
    };
  });

  await test("API", "Complete on non-existent asset returns 404", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/assets/asset_fake_12345/complete`, {
      method: "POST",
    });

    return {
      passed: res.status === 404,
      detail: `status=${res.status} (expected 404)`,
    };
  });
}

async function testCaseInput() {
  header("Section 9 — POST /cases/{caseId}/input");

  await test("API", "Submit text + metadata returns case_id and status", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Dishwasher shows E24 and will not drain.",
        metadata: {
          brand: "Bosch",
          error_code: "E24",
          serial_number: "SN12345",
          approximate_age_years: 5,
        },
        assets: [
          {
            cloudinary_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
            slot_key: "model",
            asset_type: "image",
          },
        ],
      }),
    });
    const data = (await json(res)) as Record<string, unknown>;

    return {
      passed:
        res.status === 200 &&
        data.case_id === caseId &&
        data.status === "ingestion_in_progress",
      detail: `status=${res.status}, body=${JSON.stringify(data)}`,
    };
  });

  await test("API", "Input on non-existent case returns 404", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/case_nonexistent/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "test" }),
    });

    return {
      passed: res.status === 404,
      detail: `status=${res.status} (expected 404)`,
    };
  });
}

async function testSSEEvents() {
  header("Section 9 — GET /cases/{caseId}/events (SSE)");

  await test("API", "SSE endpoint returns text/event-stream content type", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${BASE_URL}/api/cases/${caseId}/events`, {
        signal: controller.signal,
      });

      const contentType = res.headers.get("content-type") || "";
      clearTimeout(timeout);
      controller.abort();

      return {
        passed: contentType.includes("text/event-stream"),
        detail: `content-type: ${contentType}`,
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        return { passed: false, detail: "Request timed out after 5s" };
      }
      throw err;
    }
  });
}

async function testCaseStatusAfterInput() {
  header("Section 10 — State Machine Verification");

  await test("State", "Case status progresses after input submission", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}`);
    const data = (await json(res)) as Record<string, unknown>;
    const status = data.status as string;

    const validStatuses = [
      "created",
      "awaiting_upload",
      "ingestion_in_progress",
      "validating",
      "preprocessing",
      "ready_for_analysis",
      "analyzing",
      "preprocessing_complete",
    ];

    return {
      passed: validStatuses.includes(status),
      detail: `case status = "${status}" (expected one of: ${validStatuses.join(", ")})`,
    };
  });
}

async function testMIMEFormats() {
  header("Section 6 — Format Acceptance");

  const formats = [
    { mime: "image/jpeg", type: "image", expected: 201, label: "JPEG" },
    { mime: "image/png", type: "image", expected: 201, label: "PNG" },
    { mime: "image/webp", type: "image", expected: 201, label: "WEBP" },
    { mime: "image/heic", type: "image", expected: 201, label: "HEIC" },
    { mime: "video/mp4", type: "video", expected: 201, label: "MP4" },
    { mime: "video/quicktime", type: "video", expected: 201, label: "MOV" },
    { mime: "video/webm", type: "video", expected: 201, label: "WebM" },
    { mime: "image/gif", type: "image", expected: 400, label: "GIF (rejected)" },
    { mime: "image/bmp", type: "image", expected: 400, label: "BMP (rejected)" },
    { mime: "application/pdf", type: "image", expected: 400, label: "PDF (rejected)" },
  ];

  for (const fmt of formats) {
    await test("Formats", `${fmt.label} (${fmt.mime}) → ${fmt.expected}`, async () => {
      const newCase = await fetch(`${BASE_URL}/api/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const { case_id } = (await json(newCase)) as Record<string, string>;

      const res = await fetch(`${BASE_URL}/api/cases/${case_id}/assets/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `test.${fmt.label.toLowerCase().replace(/[^a-z]/g, "")}`,
          mime_type: fmt.mime,
          asset_type: fmt.type,
          size_bytes: 1_000_000,
        }),
      });

      return {
        passed: res.status === fmt.expected,
        detail: `status=${res.status} (expected ${fmt.expected})`,
      };
    });
  }
}

// ─────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────

function printSummary() {
  header("AUDIT SUMMARY");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  const sections = new Map<string, TestResult[]>();
  for (const r of results) {
    const list = sections.get(r.section) || [];
    list.push(r);
    sections.set(r.section, list);
  }

  for (const [section, tests] of sections) {
    const sectionPassed = tests.filter((t) => t.passed).length;
    const color = sectionPassed === tests.length ? COLORS.green : COLORS.yellow;
    log(`  ${color}${section}: ${sectionPassed}/${tests.length} passed${COLORS.reset}`);
  }

  log("");
  const overallColor = failed === 0 ? COLORS.green : COLORS.red;
  log(
    `${COLORS.bold}${overallColor}` +
    `Total: ${passed}/${total} passed, ${failed} failed` +
    `${COLORS.reset}`,
  );

  if (failed > 0) {
    log(`\n${COLORS.red}Failed tests:${COLORS.reset}`);
    for (const r of results.filter((r) => !r.passed)) {
      log(`  ${COLORS.red}✗${COLORS.reset} [${r.section}] ${r.name}`);
      log(`    ${COLORS.dim}${r.detail}${COLORS.reset}`);
    }
  }

  log("");

  const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);
  log(`${COLORS.dim}Completed in ${totalDuration}ms against ${BASE_URL}${COLORS.reset}`);
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  log(`\n${COLORS.bold}OPERA Input Ingestion Layer — Self-Test${COLORS.reset}`);
  log(`${COLORS.dim}Testing against: ${BASE_URL}${COLORS.reset}`);
  log(`${COLORS.dim}Spec: part1.md — Input Ingestion Layer${COLORS.reset}\n`);

  // Verify server is reachable
  try {
    await fetch(`${BASE_URL}/api/cases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (err) {
    log(`${COLORS.red}ERROR: Cannot reach backend at ${BASE_URL}${COLORS.reset}`);
    log(`${COLORS.dim}Make sure the dev server is running: npm run dev${COLORS.reset}`);
    log(`${COLORS.dim}Error: ${err instanceof Error ? err.message : String(err)}${COLORS.reset}`);
    process.exit(1);
  }

  await testCaseCreation();
  await testCaseRetrieval();
  await testAssetRegistration();
  await testAssetComplete();
  await testCaseInput();
  await testSSEEvents();
  await testCaseStatusAfterInput();
  await testMIMEFormats();

  printSummary();

  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Self-test crashed:", err);
  process.exit(1);
});
