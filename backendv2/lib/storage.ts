import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const hasSupabaseConfig = Boolean(supabaseUrl && supabaseServiceKey && !supabaseServiceKey.includes("your-service-role-key"));
const supabase = hasSupabaseConfig ? createClient(supabaseUrl, supabaseServiceKey) : null;

const BUCKET = "raw-uploads";

export type UploadMethod = "PUT" | "POST";
export type UploadProvider = "supabase" | "cloudinary";
export interface SignedUploadResult {
  uploadUrl: string;
  storagePath: string | null;
  expiresAt: string;
  uploadMethod: UploadMethod;
  uploadProvider: UploadProvider;
  uploadFields?: Record<string, string>;
}

export async function createSignedUploadUrl(
  caseId: string,
  assetId: string,
  filename: string,
): Promise<SignedUploadResult> {
  const storagePath = `raw/${caseId}/${assetId}/${filename}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Prefer Supabase signed uploads when configured.
  if (supabase) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);

    if (!error && data) {
      return {
        uploadUrl: data.signedUrl,
        storagePath,
        expiresAt,
        uploadMethod: "PUT",
        uploadProvider: "supabase",
      };
    }
  }

  // Cloudinary fallback intentionally disabled for now.
  throw new Error(
    "Supabase signed upload unavailable: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  );
}

export async function verifyFileExists(storagePath: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(storagePath.substring(0, storagePath.lastIndexOf("/")), {
      search: storagePath.substring(storagePath.lastIndexOf("/") + 1),
    });

  if (error) return false;
  return (data?.length ?? 0) > 0;
}

export async function downloadFile(
  storagePath: string,
): Promise<Buffer> {
  if (!supabase) {
    throw new Error("Supabase storage not configured for file download.");
  }
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(storagePath);

  if (error || !data) {
    throw new Error(`Failed to download file: ${error?.message}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function uploadDerived(
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  if (!supabase) {
    throw new Error("Supabase storage not configured for derived uploads.");
  }
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload derived file: ${error.message}`);
  }

  return storagePath;
}

export async function deleteFile(storagePath: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  return !error;
}

export async function getPublicUrl(storagePath: string): Promise<string> {
  if (!supabase) {
    throw new Error("Supabase storage not configured for public URLs.");
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Lists files under a given storage prefix (directory-like path).
 * Returns the full storage path for each file.
 */
export async function listFiles(prefix: string): Promise<string[]> {
  if (!supabase) return [];
  const dirPath = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const folder = dirPath.substring(0, dirPath.lastIndexOf("/"));
  const search = dirPath.substring(dirPath.lastIndexOf("/") + 1);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(folder, { search });

  if (error || !data) return [];

  const nested = await supabase.storage.from(BUCKET).list(dirPath);
  if (nested.error || !nested.data) return [];

  return nested.data
    .filter((f) => f.name && !f.id?.startsWith("."))
    .map((f) => `${dirPath}/${f.name}`);
}

export { supabase, BUCKET };
