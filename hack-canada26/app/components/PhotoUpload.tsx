"use client";

import { useState } from "react";

type UploadResponse = {
  publicId: string;
  secureUrl: string;
  width: number;
  height: number;
  localizeUrl: string;
  localizeWidth: number;
  localizeHeight: number;
  format: string;
};

type RepairStep = {
  step: number;
  category: string;
  action: string;
  caution?: string;
  visual_description?: string;
};

type LocalizationPlan = {
  targetLabel: string;
  targetDescription: string;
  countHint?: number;
  contextObjects: string[];
  overlayText: string;
  groupTargets: boolean;
};

type LocalizationResponse = {
  found: boolean;
  targetLabel?: string;
  box2d?: [number, number, number, number];
  pixelBox?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
};

type AnnotateResponse = {
  annotatedUrl: string;
};

const HARDCODED_IMAGE = {
  imageUrl: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
  width: 864,
  height: 576,
};

const HARDCODED_PLAN: LocalizationPlan = {
  targetLabel: "screws",
  targetDescription: "the two screws securing the igniter mounting bracket",
  countHint: 2,
  contextObjects: ["igniter mounting bracket", "burner assembly", "igniter"],
  overlayText: "Remove these two screws",
  groupTargets: true,
};

const SAMPLE_STEP: RepairStep = {
  step: 5,
  category: "tool|screw",
  action:
    "Using a 1/4-in. driver, remove the two screws securing the igniter mounting bracket to the burner assembly.",
  caution: "None",
  visual_description:
    "Line drawing showing a screwdriver removing screws from the igniter mounting bracket on the burner assembly.",
};

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function PhotoUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string>("");
  const [status, setStatus] = useState<string>("Ready");
  const [error, setError] = useState<string>("");

  const [uploadedUrl, setUploadedUrl] = useState<string>("");
  const [uploadResponse, setUploadResponse] = useState<UploadResponse | null>(null);
  const [planResponse, setPlanResponse] = useState<LocalizationPlan | null>(null);
  const [localizeResponse, setLocalizeResponse] = useState<LocalizationResponse | null>(null);
  const [annotatedUrl, setAnnotatedUrl] = useState<string>("");
  const [annotateResponse, setAnnotateResponse] = useState<AnnotateResponse | null>(null);

  function resetOutputs() {
    setStatus("Ready");
    setError("");
    setUploadedUrl("");
    setUploadResponse(null);
    setPlanResponse(null);
    setLocalizeResponse(null);
    setAnnotatedUrl("");
    setAnnotateResponse(null);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = e.target.files?.[0] || null;
    setFile(selectedFile);

    if (selectedFile) {
      const previewUrl = URL.createObjectURL(selectedFile);
      setLocalPreview(previewUrl);
    } else {
      setLocalPreview("");
    }

    resetOutputs();
  }

  async function runHardcodedLocalizationTest() {
    resetOutputs();
    setStatus("Running hardcoded localization test...");

    try {
      const payload = {
        imageUrl: HARDCODED_IMAGE.imageUrl,
        width: HARDCODED_IMAGE.width,
        height: HARDCODED_IMAGE.height,
        localizationPlan: HARDCODED_PLAN,
      };

      console.log("[hardcoded] /api/localize payload", payload);

      const res = await fetch("/api/localize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as LocalizationResponse & { error?: string };
      console.log("[hardcoded] /api/localize response", data);

      if (!res.ok) {
        throw new Error(data.error || "Hardcoded localization test failed");
      }

      setPlanResponse(HARDCODED_PLAN);
      setLocalizeResponse(data);
      setStatus("Hardcoded localization test complete.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown hardcoded test error";
      setError(message);
      setStatus("Hardcoded localization test failed.");
    }
  }

  async function runFullChainTest() {
    if (!file) {
      setError("Please select an image first for full chain test.");
      setStatus("Waiting for file.");
      return;
    }

    resetOutputs();

    try {
      setStatus("Step 1/3: Uploading image...");
      const uploadFormData = new FormData();
      uploadFormData.append("file", file);

      const uploadRes = await fetch("/api/upload", {
        method: "POST",
        body: uploadFormData,
      });

      const uploadData = (await uploadRes.json()) as UploadResponse & { error?: string };
      console.log("[full-chain] /api/upload response", uploadData);

      if (!uploadRes.ok) {
        throw new Error(uploadData.error || "Upload failed");
      }

      setUploadResponse(uploadData);
      setUploadedUrl(uploadData.secureUrl);

      setStatus("Step 2/3: Generating localization plan...");
      const planRes = await fetch("/api/plan-localization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: SAMPLE_STEP }),
      });

      const planData = (await planRes.json()) as LocalizationPlan & { error?: string };
      console.log("[full-chain] /api/plan-localization response", planData);

      if (!planRes.ok) {
        throw new Error(planData.error || "Plan generation failed");
      }

      setPlanResponse(planData);

      setStatus("Step 3/3: Running localization...");
      const localizePayload = {
        imageUrl: uploadData.localizeUrl,
        width: uploadData.localizeWidth,
        height: uploadData.localizeHeight,
        localizationPlan: planData,
      };

      console.log("[full-chain] /api/localize payload", localizePayload);

      const localizeRes = await fetch("/api/localize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localizePayload),
      });

      const localizeData = (await localizeRes.json()) as LocalizationResponse & { error?: string };
      console.log("[full-chain] /api/localize response", localizeData);

      if (!localizeRes.ok) {
        throw new Error(localizeData.error || "Localization failed");
      }

      setLocalizeResponse(localizeData);

      if (localizeData.found && localizeData.pixelBox) {
        setStatus("Step 4/4: Annotating image...");

        const annotateRes = await fetch("/api/annotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publicId: uploadData.publicId,
            pixelBox: localizeData.pixelBox,
            overlayText: planData.overlayText,
          }),
        });

        const annotateData = (await annotateRes.json()) as AnnotateResponse & {
          error?: string;
        };
        console.log("Annotated image:", annotateData);

        if (!annotateRes.ok) {
          throw new Error(annotateData.error || "Annotation failed");
        }

        setAnnotatedUrl(annotateData.annotatedUrl);
        setAnnotateResponse(annotateData);
      }

      setStatus("Full chain test complete.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown full chain error";
      setError(message);
      setStatus("Full chain test failed.");
    }
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.heading}>Upload a photo</h1>

      <input type="file" accept="image/*" onChange={handleChange} style={styles.input} />

      {localPreview ? (
        <div style={styles.section}>
          <p style={styles.label}>Local preview</p>
          <img src={localPreview} alt="Local preview" style={styles.image} />
        </div>
      ) : null}

      <div style={styles.buttonRow}>
        <button onClick={runHardcodedLocalizationTest} style={styles.buttonSecondary}>
          Run hardcoded localization test
        </button>
        <button onClick={runFullChainTest} style={styles.buttonPrimary}>
          Run full chain test
        </button>
      </div>

      <p style={styles.status}>Status: {status}</p>

      {error ? <p style={styles.error}>Error: {error}</p> : null}

      {uploadedUrl ? (
        <div style={styles.section}>
          <p style={styles.label}>Uploaded image</p>
          <img src={uploadedUrl} alt="Uploaded result" style={styles.image} />
        </div>
      ) : null}

      {uploadResponse ? (
        <div style={styles.section}>
          <p style={styles.label}>Upload response JSON</p>
          <pre style={styles.pre}>{prettyJson(uploadResponse)}</pre>
        </div>
      ) : null}

      {planResponse ? (
        <div style={styles.section}>
          <p style={styles.label}>Localization plan JSON</p>
          <pre style={styles.pre}>{prettyJson(planResponse)}</pre>
        </div>
      ) : null}

      {localizeResponse ? (
        <div style={styles.section}>
          <p style={styles.label}>Localization result JSON</p>
          <pre style={styles.pre}>{prettyJson(localizeResponse)}</pre>
        </div>
      ) : null}

      {annotateResponse ? (
        <div style={styles.section}>
          <p style={styles.label}>Annotate response JSON</p>
          <pre style={styles.pre}>{prettyJson(annotateResponse)}</pre>
        </div>
      ) : null}

      {annotatedUrl ? (
        <div style={styles.section}>
          <h3 style={styles.subheading}>Annotated Result</h3>
          <img src={annotatedUrl} alt="Annotated result" style={styles.image} />
        </div>
      ) : null}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "420px",
    margin: "24px auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    fontFamily: "Arial, sans-serif",
  },
  heading: {
    fontSize: "28px",
    fontWeight: 700,
    margin: 0,
  },
  input: {
    padding: "8px 0",
  },
  buttonRow: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  buttonPrimary: {
    padding: "12px 16px",
    borderRadius: "8px",
    border: "none",
    background: "#111",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  buttonSecondary: {
    padding: "12px 16px",
    borderRadius: "8px",
    border: "1px solid #333",
    background: "#fff",
    color: "#111",
    fontWeight: 600,
    cursor: "pointer",
  },
  status: {
    margin: 0,
    fontWeight: 600,
  },
  error: {
    margin: 0,
    color: "#b91c1c",
    fontWeight: 600,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  label: {
    margin: 0,
    fontWeight: 600,
  },
  subheading: {
    margin: 0,
    fontSize: "18px",
    fontWeight: 700,
  },
  image: {
    width: "100%",
    borderRadius: "12px",
    border: "1px solid #ddd",
  },
  pre: {
    margin: 0,
    padding: "10px",
    background: "#f5f5f5",
    border: "1px solid #ddd",
    borderRadius: "8px",
    overflowX: "auto",
    fontSize: "12px",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
};
