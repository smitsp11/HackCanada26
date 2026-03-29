export interface RegisteredAsset {
  asset_id: string;
  upload_url: string;
  storage_path: string;
  expires_at: string;
}

export async function registerAsset(
  caseId: string,
  file: File,
  slotKey: string,
): Promise<RegisteredAsset> {
  const assetType = file.type.startsWith("video/") ? "video" : "image";

  const res = await fetch(`/api/cases/${caseId}/assets/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      mime_type: file.type,
      asset_type: assetType,
      size_bytes: file.size,
      slot_key: slotKey,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Register failed (${res.status})`);
  }

  return res.json();
}

export async function uploadToSignedUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload network error")));
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));

    xhr.send(file);
  });
}

export async function completeAsset(
  caseId: string,
  assetId: string,
): Promise<{ asset_id: string; status: string }> {
  const res = await fetch(`/api/cases/${caseId}/assets/${assetId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Complete failed (${res.status})`);
  }

  return res.json();
}

export interface UploadResult {
  assetId: string;
  storagePath: string;
}

export async function uploadAsset(
  caseId: string,
  file: File,
  slotKey: string,
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  const registered = await registerAsset(caseId, file, slotKey);

  onProgress?.(0);
  await uploadToSignedUrl(registered.upload_url, file, onProgress);
  onProgress?.(100);

  await completeAsset(caseId, registered.asset_id);

  return {
    assetId: registered.asset_id,
    storagePath: registered.storage_path,
  };
}
