// Renders the Spot brand images to brand/out/ at 2x.
// Usage (from app/): npx vite --port 5174 &  then  node brand/render.cjs
// Set PW to your playwright path if it isn't resolvable.
const { chromium } = require(process.env.PW || "playwright");
const path = require("path");
(async () => {
  const out = path.join(__dirname, "out");
  require("fs").mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await b.newContext({ deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.error("page error:", e.message));
  await p.setViewportSize({ width: 1000, height: 2000 });
  await p.goto("http://localhost:5174/brand/pfp.html", { waitUntil: "load", timeout: 120000 });
  await p.waitForFunction(() => window.__ready, null, { timeout: 60000 });
  // Clip instead of element screenshots: software WebGL is too slow for
  // Playwright's "element is stable" check.
  await p.screenshot({ path: path.join(out, "spot-pfp.png"), clip: { x: 0, y: 0, width: 1000, height: 1000 }, timeout: 120000 });
  await p.screenshot({ path: path.join(out, "spot-pfp-dark.png"), clip: { x: 0, y: 1000, width: 1000, height: 1000 }, timeout: 120000 });
  await p.close();
  const q = await ctx.newPage();
  await q.setViewportSize({ width: 1500, height: 500 });
  await q.goto("http://localhost:5174/brand/banner.html", { waitUntil: "load", timeout: 120000 });
  await q.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  await q.screenshot({ path: path.join(out, "spot-banner.png"), clip: { x: 0, y: 0, width: 1500, height: 500 }, timeout: 120000 });
  await b.close();
  console.log("wrote", out);
})();
