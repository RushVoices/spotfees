// Vercel Edge Function: POST /api/upload
// Body: multipart form with `file` (token image) and name, symbol,
// description?, twitter?, telegram?, website?.
// Pins the image, then the metadata JSON, to IPFS via Pinata and returns
// { uri } — the metadata URI Pump/Meteora store on the token.
//
// Env: PINATA_JWT (required), PINATA_GATEWAY (optional, e.g. you.mypinata.cloud)

export const config = { runtime: "edge" };

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return json({ error: "Uploads are not configured (PINATA_JWT is missing)." }, 500);
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
    createdOn: "stacks",
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

declare const process: { env: Record<string, string | undefined> };
