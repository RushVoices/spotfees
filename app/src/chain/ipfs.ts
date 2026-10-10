// Uploads the token image + metadata JSON through our serverless route
// (api/upload.ts), which holds the Pinata key. Returns the metadata URI that
// Pump / Meteora store on the token.
export interface TokenMeta {
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export async function uploadMetadata(image: File, meta: TokenMeta): Promise<string> {
  const form = new FormData();
  form.append("file", image);
  for (const [k, v] of Object.entries(meta)) if (v) form.append(k, v);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.uri) throw new Error(body.error || `Upload failed (${res.status})`);
  return body.uri as string;
}
