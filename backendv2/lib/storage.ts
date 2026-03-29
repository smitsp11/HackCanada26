import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const BUCKET = "raw-uploads";

export async function createSignedUploadUrl(
  caseId: string,
  assetId: string,
  filename: string,
): Promise<{ uploadUrl: string; storagePath: string; expiresAt: string }> {
  const storagePath = `raw/${caseId}/${assetId}/${filename}`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error || !data) {
    throw new Error(`Failed to create signed upload URL: ${error?.message}`);
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  return {
    uploadUrl: data.signedUrl,
    storagePath,
    expiresAt,
  };
}

export async function verifyFileExists(storagePath: string): Promise<boolean> {
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
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  return !error;
}

export async function getPublicUrl(storagePath: string): Promise<string> {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Lists files under a given storage prefix (directory-like path).
 * Returns the full storage path for each file.
 */
export async function listFiles(prefix: string): Promise<string[]> {
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
