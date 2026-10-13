// Landing page: hero 3D stack, auction chart, market, My Spots, launch form.
// Talks to Solana through window.StacksChain (src/main.ts), which is loaded
// after window.StacksUI is defined so live data can flow straight in.

import type { CardView } from "../main";
import { createStack, hasWebGL, type StackHandle } from "./stack3d";
import { $, $$, esc, fmt, friendly, pad, initChrome, toast, miniStack, countUp } from "./common";

type ModeKey = "degen" | "builder";
const MODES: Record<ModeKey, { start: number; floor: number; drop: number; label: string }> = {
  degen: { start: 1.5, floor: 0.5, drop: 0.125, label: "Degen" },
  builder: { start: 4, floor: 1, drop: 0.2, label: "Builder" },
};
const STEP_MS = 15_000;
const PROTOCOL_FEE = 0.02;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const priceAt = (m: ModeKey, ms: number) => {
  const c = MODES[m];
  return Math.max(c.floor, c.start - c.drop * Math.floor(Math.max(0, ms) / STEP_MS));
};
const stepsOf = (m: ModeKey) => Math.round((MODES[m].start - MODES[m].floor) / MODES[m].drop);

initChrome();

const isLive = () => !!window.StacksChain?.live;

/* =============================== HERO =============================== */
let hero: StackHandle | null = null;
(function heroStage() {
  const canvas = $<HTMLCanvasElement>("#stackCanvas");
  const tip = $("#coinTip");
  const stage = $("#stage");
  let sold = 3;
  const paintSold = (n: number) => {
    sold = n;
    $("#soldN").textContent = String(n);
    $("#soldTxt").textContent = String(n);
    $("#soldRing").style.strokeDashoffset = String(94.25 * (1 - n / 10));
  };
  paintSold(sold);

  const onTake = (n: number) => {
    paintSold(n);
    if (n === 0 || n <= 3) return;
    const steps = Math.floor(Math.random() * (stepsOf("degen") + 1));
    $("#takeNo").textContent = pad(n);
    $("#takePx").textContent = (MODES.degen.start - steps * MODES.degen.drop).toFixed(3);
    const chip = $("#chipTake");
    chip.classList.remove("pop"); void chip.offsetWidth; chip.classList.add("pop");
  };

  if (hasWebGL()) {
    hero = createStack(canvas, {
      sold, autoplay: true, interactive: true, onTake,
      onHover(i, x, y) {
        if (i === null) { tip.hidden = true; return; }
        tip.hidden = false;
        tip.style.left = x + "px";
        tip.style.top = y + "px";
        tip.innerHTML = `<b>${pad(i + 1)}</b>Spot · 10% of fees · <span>${i < sold ? "taken" : "for sale"}</span>`;
      },
    });
  } else {
    canvas.hidden = true;
    const box = $("#cssStack");
    box.hidden = false;
    box.innerHTML = `<div class="mini-stack"></div>`;
    miniStack($(".mini-stack", box), sold);
  }

  // Scroll fans the coins out into a helix.
  const onScroll = () => {
    const r = stage.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, -r.top / (r.height * 0.8) + 0.15));
    hero?.setExplode(p);
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Fee counter ticks up while the page is open.
  let fees = 0.8421;
  const el = $("#feeCounter");
  setInterval(() => { fees += Math.random() * 0.0031; el.textContent = fees.toFixed(4); }, reduce ? 2000 : 280);
})();

/* =============================== TICKER =============================== */

const FACTS = [
  "<b>10</b> Spots per coin", "<b>10%</b> of creator fees, each", "Paid in <b>SOL</b>",
  "Price drops every <b>15s</b>", "Launch in <b>one</b> wallet prompt", "Built on <b>pump.fun</b>",
];
function renderTicker(items: { sym: string; sold: number; mode: ModeKey }[]) {
  const one = !items.length
    ? FACTS.map((f) => `<span class="tick"><span class="sep"></span>${f}</span>`).join("")
    : items.map((l, i) => {
    const px = priceAt(l.mode, ((i * 37) % 8) * STEP_MS);
    return `<span class="tick"><span class="sep"></span><b>$${esc(l.sym)}</b> Spot <span class="it">${pad(Math.max(1, Math.min(10, l.sold)))}</span> taken at <b>${fmt(px)} SOL</b></span>`;
  }).join("");
  $("#ticker").innerHTML = one + one;
}
renderTicker([]);

/* =============================== AUCTION CHART =============================== */
(function auctionChart() {
  const svg = $<SVGSVGElement>("#chart");
  const toggle = $("#modeToggle");
  let mode: ModeKey = "degen";
  let t0 = performance.now();
  const W = 640, Hh = 300, L = 44, Rr = 16, T = 18, B = 34;
  const totalMs = () => (stepsOf(mode) + 1) * STEP_MS;
  const x = (ms: number) => L + (ms / totalMs()) * (W - L - Rr);
  const y = (p: number) => T + (1 - p / MODES.builder.start) * (Hh - T - B);

  function draw() {
    const m = MODES[mode];
    let d = `M${x(0)},${y(m.start)}`;
    for (let s = 0; s <= stepsOf(mode); s++) {
      const p = Math.max(m.floor, m.start - s * m.drop);
      d += ` H${x((s + 1) * STEP_MS)}`;
      const np = Math.max(m.floor, m.start - (s + 1) * m.drop);
      if (s < stepsOf(mode)) d += ` V${y(np)}`;
      void p;
    }
    const other = mode === "degen" ? "builder" : "degen";
    const om = MODES[other];
    let g = `M${x(0)},${y(om.start)}`;
    const oSteps = stepsOf(other);
    for (let s = 0; s <= oSteps; s++) {
      g += ` H${L + ((s + 1) / (oSteps + 1)) * (W - L - Rr)}`;
      if (s < oSteps) g += ` V${y(Math.max(om.floor, om.start - (s + 1) * om.drop))}`;
    }
    const grid = [0, 1, 2, 3, 4].map((v) => `<line class="gridl" x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
    svg.innerHTML = `
      <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2fd18a" stop-opacity=".28"/><stop offset="1" stop-color="#2fd18a" stop-opacity="0"/></linearGradient></defs>
      ${grid}
      <path class="ghost" d="${g}"/>
      <path class="area" d="${d} V${y(0)} H${x(0)} Z"/>
      <path class="line" d="${d}"/>
      <line class="cursor" id="cCur" y1="${T}" y2="${Hh - B}"/>
      <circle class="now-ring" id="cRing" r="12"/>
      <circle class="now" id="cNow" r="5.5"/>`;
    $("#chartEnd").textContent = `${totalMs() / 1000}s`;
    const fee = (m.floor * PROTOCOL_FEE).toFixed(3);
    $("#modeStats").innerHTML = `
      <div><dt>Start</dt><dd>${fmt(m.start)}</dd></div>
      <div><dt>Floor</dt><dd>${fmt(m.floor)}</dd></div>
      <div><dt>Drop / 15s</dt><dd>${fmt(m.drop)}</dd></div>`;
    void fee;
  }
  toggle.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-mode]");
    if (!b) return;
    mode = b.dataset.mode as ModeKey;
    toggle.dataset.mode = mode;
    $$("[data-mode]", toggle).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    t0 = performance.now();
    draw();
  });
  draw();
  function tick(now: number) {
    requestAnimationFrame(tick);
    // 4x speed so the whole staircase plays in under a minute
    const ms = ((now - t0) * 4) % totalMs();
    const p = priceAt(mode, ms);
    const cx = x(ms), cy = y(p);
    const n = $("#cNow"), r = $("#cRing"), c = $("#cCur");
    if (!n) return;
    n.setAttribute("cx", String(cx)); n.setAttribute("cy", String(cy));
    r.setAttribute("cx", String(cx)); r.setAttribute("cy", String(cy));
    r.setAttribute("r", String(8 + ((now / 80) % 10)));
    c.setAttribute("x1", String(cx)); c.setAttribute("x2", String(cx));
    $("#chartPx").textContent = p.toFixed(3);
    const left = p <= MODES[mode].floor ? null : Math.ceil((STEP_MS - (ms % STEP_MS)) / 1000);
    $("#chartNext").textContent = left === null ? "floor" : `${left}s`;
  }
  requestAnimationFrame(tick);
})();

/* =============================== MARKET =============================== */
interface Launch {
  id: number;
  story?: string;
  live: boolean;
  mint?: string;
  name: string;
  sym: string;
  image?: string;
  mode: ModeKey;
  sold: number;
  status?: "setup" | "open" | "soldout";
  nextIndex: number;
  hue: string;
  t0: number;
}
let launches: Launch[] = [];
let tab: "all" | "open" | "soldout" = "all";
const isSold = (l: Launch) => l.sold >= 10 || l.status === "soldout";

function renderTabs() {
  const n = { all: launches.length, open: launches.filter((l) => !isSold(l)).length, soldout: launches.filter(isSold).length };
  $("#tabs").innerHTML = (["all", "open", "soldout"] as const)
    .map((k) => `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${tab === k}">${{ all: "All", open: "Open", soldout: "Sold out" }[k]} <span>${n[k]}</span></button>`).join("");
}
function cardHTML(l: Launch) {
  const sold = isSold(l);
  const av = l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy">` : esc(l.sym.slice(0, 1));
  return `<article class="card tilt lc${sold ? " sold" : ""}" data-id="${l.id}">
    <div class="glare"></div>
    <div class="lc-head">
      <div class="av" style="background:${esc(l.hue)}">${av}</div>
      <div style="min-width:0"><h3>${esc(l.name)}</h3><span class="mono">$${esc(l.sym)}</span></div>
      <div class="chips"><span class="chip ${l.mode === "degen" ? "g" : ""}">${MODES[l.mode].label}</span></div>
    </div>
    <p class="lc-story">${l.story ? esc(l.story) : "No narrative yet."}</p>
    <div class="lc-body">
      <div class="mini-stack" data-ms></div>
      <div class="lc-px">
        <span class="mono">${sold ? "Sold out" : `Spot ${pad(l.nextIndex + 1)} price`}</span>
        <b data-px>${sold ? "—" : fmt(priceAt(l.mode, performance.now() - l.t0))}<small> SOL</small></b>
        <div class="drop-bar"><i data-bar></i></div>
        <div class="meta"><span data-sold>${Math.min(10, l.sold)} of 10 taken</span><span data-next></span></div>
      </div>
    </div>
    <button class="btn ${sold ? "" : "primary"}" type="button" data-take ${sold ? "disabled" : ""}>${sold ? "All ten Spots taken" : `Take Spot ${pad(l.nextIndex + 1)}`} ${sold ? "" : '<span class="arr">→</span>'}</button>
  </article>`;
}
function renderGrid() {
  const list = launches.filter((l) => tab === "all" || (tab === "open" ? !isSold(l) : isSold(l)));
  const empty = {
    all: `<div class="empty"><b>No coins yet.</b><br>Be the first to launch one and put its ten Spots up for auction.<br><br><a class="btn primary sm" href="#launch">Launch a coin <span class="arr">→</span></a></div>`,
    open: `<div class="empty"><b>No open auctions right now.</b><br>New coins show up here the moment their Spots go on sale.</div>`,
    soldout: `<div class="empty"><b>Nothing has sold out yet.</b><br>Coins move here once all ten Spots are taken.</div>`,
  }[tab];
  $("#grid").innerHTML = list.length ? list.map(cardHTML).join("") : empty;
  $$<HTMLElement>("#grid .lc").forEach((c) => {
    const l = launches[+c.dataset.id!];
    miniStack($("[data-ms]", c), Math.min(10, l.sold), !isSold(l));
  });
  updateCards(performance.now());
}
function updateCards(now: number) {
  $$<HTMLElement>("#grid .lc").forEach((c) => {
    const l = launches[+c.dataset.id!];
    if (!l || isSold(l)) return;
    const live = l.live && l.mint ? window.StacksChain?.priceNow(l.mint) : null;
    const ms = now - l.t0;
    const p = live ?? priceAt(l.mode, ms);
    const m = MODES[l.mode];
    const px = $("[data-px]", c);
    const txt = `${fmt(p)}<small> SOL</small>`;
    if (px.innerHTML !== txt) px.innerHTML = txt;
    const atFloor = p <= m.floor;
    $<HTMLElement>("[data-bar]", c).style.width = atFloor ? "100%" : `${((ms % STEP_MS) / STEP_MS) * 100}%`;
    $("[data-next]", c).textContent = atFloor ? "at floor" : `−${fmt(m.drop)} in ${Math.ceil((STEP_MS - (ms % STEP_MS)) / 1000)}s`;
  });
}
$("#tabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab as typeof tab;
  renderTabs(); renderGrid();
});
$("#grid").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-take]");
  if (!b || b.disabled) return;
  const card = b.closest<HTMLElement>(".lc")!;
  const l = launches[+card.dataset.id!];
  if (l.live && l.mint) {
    const price = window.StacksChain!.priceNow(l.mint) ?? priceAt(l.mode, performance.now() - l.t0);
    const old = b.innerHTML;
    b.disabled = true; b.textContent = "Confirm in your wallet…";
    window.StacksChain!.take(l.mint, l.nextIndex, price)
      .then(() => toast(`Spot ${pad(l.nextIndex + 1)} of $${l.sym} is yours at ${fmt(price)} SOL`))
      .catch((err) => toast(friendly(err)))
      .finally(() => { b.disabled = false; b.innerHTML = old; });
    return;
  }
  const p = priceAt(l.mode, performance.now() - l.t0);
  l.sold += 1; l.nextIndex = l.sold; l.t0 = performance.now();
  toast(`Preview: took Spot ${pad(l.sold)} of $${l.sym} at ${fmt(p)} SOL`);
  renderTabs(); renderGrid();
  const fresh = $(`#grid .lc[data-id="${l.id}"]`);
  if (fresh) {
    fresh.classList.add("flash");
    const coins = $$("[data-ms] i", fresh);
    coins[l.sold - 1]?.classList.add("new");
  }
});
renderTabs(); renderGrid();
setInterval(() => updateCards(performance.now()), 250);

/* =============================== WALLET =============================== */
let address: string | null = null;
function paintWallet() {
  const b = $("#walletBtn");
  b.innerHTML = address ? `<span class="dot"></span><span class="addr">${address.slice(0, 4)}…${address.slice(-4)}</span>` : "Connect";
}
async function connectWallet(): Promise<boolean> {
  try {
    if (isLive()) address = await window.StacksChain!.connect();
    else {
      const w = (window as unknown as { phantom?: { solana?: { connect(): Promise<{ publicKey: { toString(): string } }> } }; solana?: { connect(): Promise<{ publicKey: { toString(): string } }> } });
      const p = w.phantom?.solana ?? w.solana;
      if (!p) { toast("No Solana wallet found. Install Phantom or Solflare."); return false; }
      address = (await p.connect()).publicKey.toString();
    }
    paintWallet();
    toast("Wallet connected");
    return true;
  } catch (e) {
    toast(friendly(e));
    return false;
  }
}
$("#walletBtn").addEventListener("click", () => { if (!address) connectWallet(); });

/* =============================== MY SPOTS =============================== */
type MineRow = { mint: string; name: string; sym: string; index: number; claimable: number; venue: string };
function renderMine(rows: MineRow[] | null) {
  const box = $("#mineList");
  if (rows === null) { box.innerHTML = `<div class="empty">Connect your wallet to see the Spots you hold. <br><br><button class="btn dark sm" type="button" data-connect>Connect wallet</button></div>`; return; }
  if (!rows.length) { box.innerHTML = `<div class="empty">You don’t hold any Spots yet. <a href="#market">Take one</a>.</div>`; return; }
  box.innerHTML = rows.map((r) => `<div class="card mine-row" data-mint="${esc(r.mint)}" data-index="${r.index}">
      <div style="min-width:0"><b class="t">$${esc(r.sym)} · Spot ${pad(r.index + 1)}</b><span class="mono">${esc(r.name)}</span></div>
      <div class="mine-amt"><b>${r.claimable.toFixed(4)}</b> <small>SOL ready</small></div>
      <div class="mine-act">
        <button class="btn sm" type="button" data-collect>Collect fees</button>
        <button class="btn sm" type="button" data-send>Send</button>
        <button class="btn sm primary" type="button" data-claim ${r.claimable > 0 ? "" : "disabled"}>Claim</button>
      </div>
    </div>`).join("");
}
$("#mineList").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-connect]")) { connectWallet(); return; }
  const b = t.closest<HTMLButtonElement>("[data-claim],[data-collect],[data-send]");
  if (!b || b.disabled) return;
  const row = b.closest<HTMLElement>(".mine-row")!;
  const mint = row.dataset.mint!, index = +row.dataset.index!;
  const chain = window.StacksChain!;
  let job: Promise<unknown>; let done: string;
  if (b.hasAttribute("data-send")) {
    const to = prompt("Send this Spot, and its unclaimed SOL, to which wallet address?")?.trim();
    if (!to) return;
    job = chain.transfer(mint, index, to); done = "Spot sent";
  } else if (b.hasAttribute("data-claim")) { job = chain.claim(mint, index); done = "Claimed to your wallet"; }
  else { job = chain.collectFees(mint); done = "Fees paid into all ten Spots"; }
  const old = b.innerHTML; b.disabled = true; b.textContent = "Confirm in wallet…";
  job.then(() => toast(done)).catch((err) => toast(friendly(err))).finally(() => { b.disabled = false; b.innerHTML = old; });
});

/* =============================== LAUNCH FORM =============================== */
(function launchForm() {
  const f = { mode: "degen" as ModeKey, pre: 2, img: null as File | null };
  const descI = $<HTMLTextAreaElement>("#tDesc");
  const nameI = $<HTMLInputElement>("#tName"), symI = $<HTMLInputElement>("#tSym"), devI = $<HTMLInputElement>("#dev");
  const file = $<HTMLInputElement>("#tImg"), drop = $("#drop");
  const devVal = () => { const v = parseFloat(devI.value.replace(",", ".")); return isFinite(v) && v > 0 ? Math.min(v, 85) : 0; };

  function render() {
    $("#nameCt").textContent = `${nameI.value.length}/32`;
    $("#symCt").textContent = `${symI.value.length}/10`;
    $("#preN").textContent = String(f.pre);
    $("#preSeg").innerHTML = Array.from({ length: 5 }, (_, i) => `<span class="${i < f.pre ? "mine" : ""}">${pad(i + 1)}</span>`).join("");
    const m = MODES[f.mode];
    const preFee = f.pre * m.floor * PROTOCOL_FEE;
    const dev = devVal();
    $("#pvName").textContent = nameI.value.trim() || "Your coin";
    $("#pvSym").textContent = "$" + (symI.value.trim() || "TICKER");
    const story = descI.value.trim();
    $("#descCt").textContent = `${descI.value.length}/500`;
    $("#pvStory").textContent = story || "Your coin’s narrative shows up here.";
    $("#pvStory").classList.toggle("empty-story", !story);
    $("#pvMode").textContent = m.label;
    if (!f.img) $("#pvAv").textContent = (symI.value.trim() || nameI.value.trim() || "?").slice(0, 1).toUpperCase();
    $("#sAuc").textContent = `${10 - f.pre} of 10`;
    $("#sPre").textContent = `${preFee.toFixed(4)} SOL`;
    $("#sDev").textContent = dev ? `${fmt(dev)} SOL` : "None";
    $("#sTotal").textContent = `${fmt(preFee + dev + 0.03)} SOL`;
    $("#sEarn").textContent = `${fmt((10 - f.pre) * m.floor * (1 - PROTOCOL_FEE))}+ SOL to you`;
    $$<HTMLButtonElement>("#devQuick button").forEach((b) => b.classList.toggle("on", parseFloat(b.dataset.v!) === dev || (b.dataset.v === "0" && !dev && devI.value === "")));
    miniStack($("#pvStack"), f.pre, true);
  }
  nameI.addEventListener("input", () => { nameI.classList.remove("bad"); render(); });
  symI.addEventListener("input", () => {
    symI.value = symI.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    symI.classList.remove("bad"); render();
  });
  descI.addEventListener("input", () => render());
  devI.addEventListener("input", () => { devI.value = devI.value.replace(/[^0-9.,]/g, ""); render(); });
  $("#devQuick").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-v]");
    if (!b) return;
    devI.value = b.dataset.v === "0" ? "" : b.dataset.v!;
    render();
  });
  $$<HTMLInputElement>('input[name="mode"]').forEach((r) => r.addEventListener("change", () => { f.mode = r.value as ModeKey; render(); }));
  $("#preMinus").addEventListener("click", () => { f.pre = Math.max(0, f.pre - 1); render(); });
  $("#prePlus").addEventListener("click", () => { f.pre = Math.min(5, f.pre + 1); render(); });

  function setFile(fl?: File | null) {
    if (!fl) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(fl.type)) { toast("Use a PNG, JPEG, GIF or WebP image."); return; }
    if (fl.size > 5 * 1024 * 1024) { toast("The image must be 5 MB or smaller."); return; }
    f.img = fl;
    drop.classList.remove("bad");
    const url = URL.createObjectURL(fl);
    const img = $<HTMLImageElement>("#dropImg");
    img.src = url; img.hidden = false;
    $("#dropIdle").hidden = true;
    $("#pvAv").innerHTML = `<img src="${url}" alt="">`;
  }
  file.addEventListener("change", () => setFile(file.files?.[0]));
  (["dragenter", "dragover"] as const).forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  (["dragleave", "drop"] as const).forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => setFile((e as DragEvent).dataTransfer?.files[0]));

  function missing() {
    const m: string[] = [];
    if (!nameI.value.trim()) { m.push("a name"); nameI.classList.add("bad"); }
    if (!symI.value.trim()) { m.push("a ticker"); symI.classList.add("bad"); }
    if (!f.img) { m.push("an image"); drop.classList.add("bad"); }
    return m;
  }

  let busy = false;
  const btn = $<HTMLButtonElement>("#launchBtn");
  btn.addEventListener("click", async () => {
    if (busy) return;
    const miss = missing();
    if (miss.length) {
      btn.classList.remove("shake"); void btn.offsetWidth; btn.classList.add("shake");
      toast("Add " + miss.join(", ").replace(/, ([^,]*)$/, " and $1") + " first.");
      return;
    }
    if (!isLive()) {
      $("#help").textContent = "This is a preview build. Launching turns on once the site is connected to Solana (see the docs).";
      toast("Preview build: launching is not switched on yet");
      return;
    }
    if (!address && !(await connectWallet())) return;
    busy = true; btn.disabled = true; $("#doneBox").hidden = true;
    const sym = symI.value.trim();
    const labels = [
      "Uploading image and metadata",
      `Creating $${sym} on pump.fun`,
      "Registering the Spots and turning on fee sharing",
      "Locking fees to the ten Spots and opening the auction",
    ];
    const ol = $("#progress");
    ol.hidden = false;
    ol.innerHTML = labels.map((l) => `<li><i></i>${esc(l)}</li>`).join("");
    const items = $$("li", ol);
    const step = (i: number) => items.forEach((li, k) => { li.className = k < i ? "done" : k === i ? "run" : ""; });
    $("#help").textContent = "Your wallet asks once, for every transaction.";
    try {
      const r = await window.StacksChain!.launch({
        venue: "pump", name: nameI.value.trim(), symbol: sym, image: f.img!,
        description: descI.value.trim(),
        twitter: $<HTMLInputElement>("#sX").value.trim(), telegram: $<HTMLInputElement>("#sT").value.trim(), website: $<HTMLInputElement>("#sW").value.trim(),
        mode: f.mode, prebuy: f.pre, devBuySol: devVal(),
      }, step);
      step(items.length);
      const box = $("#doneBox");
      box.hidden = false;
      box.innerHTML = `<b>$${esc(sym)} is live.</b> ${10 - f.pre} Spots are up for auction. <a href="${esc(r.explorer)}" target="_blank" rel="noopener">View transaction</a> · <a href="https://pump.fun/coin/${esc(r.mint)}" target="_blank" rel="noopener">Open on pump.fun</a><br><span class="mono" style="text-transform:none">${esc(r.mint)}</span>`;
      toast("Launched");
      hero?.setSold(f.pre, false);
    } catch (err) {
      items.forEach((li) => { if (li.className === "run") li.className = ""; });
      $("#help").innerHTML = `<span class="err">${esc(friendly(err))}</span>`;
      toast(friendly(err));
    } finally { busy = false; btn.disabled = false; }
  });
  render();
})();

/* =============================== CTA + NUMBERS =============================== */
miniStack($("#ctaStack"), 4, true);
countUp();

/* =============================== CHAIN BRIDGE =============================== */
window.StacksUI = {
  toast,
  setLaunches(list: CardView[]) {
    launches = list.map((l, i) => ({
      id: i, live: true, mint: l.mint, name: l.name, sym: l.sym, image: l.image, story: l.story, mode: l.mode,
      sold: l.sold, status: l.status, nextIndex: l.nextIndex, hue: l.hue, t0: l.t0,
    }));
    $("#gridNote").textContent = "Live. Prices drop every 15 seconds and restart after each take. Taking a Spot is one transaction from your wallet.";
    if (launches.length) renderTicker(launches);
    renderTabs(); renderGrid();
  },
  renderMine,
};

function onChainReady() {
  if (!isLive()) return;
  document.documentElement.classList.add("is-live");
  const net = window.StacksChain!.cluster === "mainnet-beta" ? "Solana" : "Solana devnet";
  $("#netName").textContent = net;
  $("#mine").hidden = false;
  renderMine(null);
  launches = [];
  renderTabs(); renderGrid();
  $("#gridNote").textContent = `Loading launches from ${net}…`;
}
window.addEventListener("stacks:ready", onChainReady, { once: true });
// The Solana bundle is large: load it after the page is interactive.
if (!import.meta.env.VITE_NO_CHAIN) import("../main").catch((e) => console.warn("Chain module failed to load", e));
