export interface RegisteredAsset {
  asset_id: string;
  upload_url: string;
  storage_path: string | null;
  expires_at: string;
  upload_method?: "PUT" | "POST";
  upload_provider?: "supabase" | "cloudinary";
  upload_fields?: Record<string, string> | null;
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
  registered: RegisteredAsset,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ cloudinaryUrl?: string; cloudinaryPublicId?: string }> {
  const method = registered.upload_method ?? "PUT";
  if (method === "POST") {
    const form = new FormData();
    for (const [key, value] of Object.entries(registered.upload_fields ?? {})) {
      form.append(key, value);
    }
    form.append("file", file);
    const res = await fetch(registered.upload_url, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Upload failed with status ${res.status}`);
    }
    const payload = await res.json().catch(() => ({}));
    onProgress?.(100);
    return {
      cloudinaryUrl:
        typeof payload.secure_url === "string" ? payload.secure_url : undefined,
      cloudinaryPublicId:
        typeof payload.public_id === "string" ? payload.public_id : undefined,
    };
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", registered.upload_url);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({});
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
  uploadMeta?: { cloudinaryUrl?: string; cloudinaryPublicId?: string },
): Promise<{ asset_id: string; status: string }> {
  const res = await fetch(`/api/cases/${caseId}/assets/${assetId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cloudinary_url: uploadMeta?.cloudinaryUrl,
      cloudinary_public_id: uploadMeta?.cloudinaryPublicId,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Complete failed (${res.status})`);
  }

  return res.json();
}

export interface UploadResult {
  assetId: string;
  storagePath: string | null;
}

export async function uploadAsset(
  caseId: string,
  file: File,
  slotKey: string,
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  const registered = await registerAsset(caseId, file, slotKey);

  onProgress?.(0);
  const uploadMeta = await uploadToSignedUrl(registered, file, onProgress);
  onProgress?.(100);

  await completeAsset(caseId, registered.asset_id, uploadMeta);

  return {
    assetId: registered.asset_id,
    storagePath: registered.storage_path,
  };
}
