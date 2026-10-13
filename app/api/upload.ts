// Vercel Edge Function: POST /api/upload
// Body: multipart form with `file` (token image) and name, symbol,
// description?, twitter?, telegram?, website?.
// Pins the image, then the metadata JSON, to IPFS via Pinata and returns
// { uri } — the metadata URI Pump/Meteora store on the token.
//
// Env: PINATA_JWT (optional), PINATA_GATEWAY (optional, e.g. you.mypinata.cloud).
// Without PINATA_JWT the files go through pump.fun's own IPFS uploader, the
// one pump.fun uses for its create page, so launching needs no keys at all.

export const config = { runtime: "edge" };

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const jwt = process.env.PINATA_JWT;
  const gateway = process.env.PINATA_GATEWAY ? `https://${process.env.PINATA_GATEWAY}/ipfs/` : "https://ipfs.io/ipfs/";

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "Send the image as multipart form data." }, 400); }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Add a token image." }, 400);
  if (!TYPES.has(file.type)) return json({ error: "Use a PNG, JPEG, GIF or WebP image." }, 400);
  if (file.size > MAX_BYTES) return json({ error: "The image must be 5 MB or smaller." }, 400);

  const text = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
  const name = text("name", 32);
  const symbol = text("symbol", 10);
  if (!name || !symbol) return json({ error: "Name and symbol are required." }, 400);

  if (!jwt) return uploadViaPump(file, {
    name, symbol, description: text("description", 500),
    twitter: text("twitter", 200), telegram: text("telegram", 200), website: text("website", 200),
  });

  const pinFile = new FormData();
  pinFile.append("file", file, file.name || "image");
  pinFile.append("pinataMetadata", JSON.stringify({ name: `${symbol}-image` }));
  const imgRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: pinFile,
  });
  if (!imgRes.ok) return json({ error: `Image upload failed (${imgRes.status}).` }, 502);
  const { IpfsHash: imageCid } = (await imgRes.json()) as { IpfsHash: string };

  // Same shape pump.fun writes, so wallets and explorers show it.
  const metadata = {
    name,
    symbol,
    description: text("description", 500),
    image: `${gateway}${imageCid}`,
    showName: true,
    createdOn: "spot",
    twitter: text("twitter", 200) || undefined,
    telegram: text("telegram", 200) || undefined,
    website: text("website", 200) || undefined,
  };
  const metaRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ pinataContent: metadata, pinataMetadata: { name: `${symbol}-metadata` } }),
  });
  if (!metaRes.ok) return json({ error: `Metadata upload failed (${metaRes.status}).` }, 502);
  const { IpfsHash: metaCid } = (await metaRes.json()) as { IpfsHash: string };

  return json({ uri: `${gateway}${metaCid}`, image: metadata.image });
}

/** pump.fun's IPFS uploader: same form fields as its create page. Returns { metadataUri }. */
async function uploadViaPump(file: File, f: Record<string, string>): Promise<Response> {
  const form = new FormData();
  form.append("file", file, file.name || "image");
  for (const [k, v] of Object.entries(f)) if (v) form.append(k, v);
  form.append("showName", "true");
  let res: Response;
  try {
    res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form, headers: { origin: "https://pump.fun", referer: "https://pump.fun/create" } });
  } catch {
    return json({ error: "Couldn’t reach pump.fun to upload the image. Try again." }, 502);
  }
  const body = (await res.json().catch(() => null)) as { metadataUri?: string; metadata?: { image?: string } } | null;
  if (!res.ok || !body?.metadataUri) return json({ error: `pump.fun image upload failed (${res.status}). Try again, or set PINATA_JWT.` }, 502);
  return json({ uri: body.metadataUri, image: body.metadata?.image });
}

declare const process: { env: Record<string, string | undefined> };
