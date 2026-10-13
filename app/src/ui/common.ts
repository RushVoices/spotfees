// Small helpers shared by the site and the docs: DOM lookups, formatting,
// toasts, the nav, scroll reveals, 3D tilt cards and the CSS mini stack.

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  return root.querySelector(sel) as T;
}
export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll(sel)) as T[];
}
export const pad = (n: number) => String(n).padStart(2, "0");
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Up to 3 decimals, no trailing zeros. */
export const fmt = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";

export function friendly(err: unknown): string {
  const m = String((err as { message?: string })?.message ?? err);
  if (/User rejected|rejected the request|cancel/i.test(m)) return "Cancelled in your wallet.";
  if (/PriceAboveMax|0x1780|6016/.test(m)) return "The price moved before your transaction landed. Try again.";
  if (/StackTaken|6015|0x177f/i.test(m)) return "Someone took that Spot first. Try the next one.";
  if (/NothingToClaim|6018|0x1782/i.test(m)) return "Nothing to claim yet. Collect fees first.";
  if (/NotStackOwner|6017|0x1781/i.test(m)) return "That Spot isn’t in this wallet.";
  if (/Invalid public key|Non-base58/i.test(m)) return "That doesn’t look like a Solana address.";
  if (/insufficient lamports|insufficient funds|0x1\b/i.test(m)) return "Not enough SOL in your wallet for this.";
  if (/blockhash not found|block height exceeded|expired/i.test(m)) return "The network was slow and the transaction expired. Try again.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}

let toastTimer = 0;
export function toast(msg: string) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("on"), 3600);
}

/** Ten CSS coins; the first `sold` are taken (pearl), the next one glows. */
export function miniStack(el: Element | null, sold: number, glowNext = false) {
  if (!el) return;
  if (el.children.length !== 10) {
    el.innerHTML = Array.from({ length: 10 }, (_, k) => `<i style="--k:${k}"></i>`).join("");
  }
  Array.from(el.children).forEach((c, k) => {
    c.classList.toggle("t", k < sold);
    c.classList.toggle("next", glowNext && k === sold);
  });
}

/** Splits headings into words for the rise-in animation. */
function splitWords(el: HTMLElement) {
  let i = 0;
  const walk = (node: Node) => {
    Array.from(node.childNodes).forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        n.textContent!.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(document.createTextNode(part)); return; }
          const w = document.createElement("span");
          w.className = "w";
          const inner = document.createElement("span");
          inner.style.setProperty("--i", String(i++));
          inner.textContent = part;
          w.append(inner);
          frag.append(w);
        });
        n.replaceWith(frag);
      } else if ((n as Element).classList?.contains("green-text")) {
        // background-clip:text doesn't paint through split children: move it whole
        const w = document.createElement("span");
        w.className = "w";
        const inner = document.createElement("span");
        inner.style.setProperty("--i", String(i++));
        n.replaceWith(w);
        inner.append(n);
        w.append(inner);
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        walk(n);
      }
    });
  };
  walk(el);
}

export function countUp() {
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      const el = e.target as HTMLElement;
      const to = +el.dataset.count!;
      const suf = el.dataset.suffix ?? "";
      const t0 = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 1400);
        el.textContent = Math.round(to * (1 - Math.pow(1 - p, 4))) + suf;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, { threshold: 0.6 });
  $$("[data-count]").forEach((el) => io.observe(el));
}

/**
 * In-page links (#how, ./#launch, /#market) scroll smoothly without putting
 * the #section in the address bar, so the URL stays clean (spotfees.trade/).
 */
function cleanAnchors() {
  const scrollToId = (id: string, smooth: boolean) => {
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    else if (id === "top" || !id) scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
    return !!el || id === "top" || !id;
  };
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[href]");
    if (!a || a.target === "_blank") return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) return;
    const id = decodeURIComponent(url.hash.slice(1));
    if (scrollToId(id, true)) {
      e.preventDefault();
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    }
  }, true); // capture: runs before anything else can let the browser add the #
  // Fallback: if a #section still lands in the URL, scroll there and remove it.
  addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    history.replaceState(null, "", location.pathname + location.search);
    scrollToId(id, true);
  });
  // Arrived with a #section (e.g. from a docs link): jump there, then tidy the URL.
  if (location.hash) {
    const id = decodeURIComponent(location.hash.slice(1));
    const go = () => {
      scrollToId(id, false);
      history.replaceState(null, "", location.pathname + location.search);
      setTimeout(() => scrollToId(id, false), 350); // again, after late layout shifts
    };
    if (document.readyState === "complete") go();
    else addEventListener("load", go, { once: true });
  }
}

export function initChrome() {
  cleanAnchors();
  // nav
  const nav = $("#nav");
  const menu = $("#menuBtn");
  const onScroll = () => nav?.classList.toggle("scrolled", scrollY > 20);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  menu?.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    menu.setAttribute("aria-expanded", String(open));
  });
  $$("#navLinks a").forEach((a) => a.addEventListener("click", () => { nav.classList.remove("open"); menu?.setAttribute("aria-expanded", "false"); }));

  // reveals
  $$("[data-split]").forEach(splitWords);
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); } });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  $$(".rv, .split").forEach((el) => io.observe(el));

  // 3D tilt + glare on cards (event delegation so re-rendered cards work)
  const fine = matchMedia("(pointer: fine)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (fine) {
    document.addEventListener("pointermove", (e) => {
      const c = (e.target as HTMLElement).closest?.<HTMLElement>(".tilt");
      if (!c) return;
      const r = c.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      c.style.setProperty("--ry", `${(px - 0.5) * 8}deg`);
      c.style.setProperty("--rx", `${(0.5 - py) * 8}deg`);
      c.style.setProperty("--gx", `${px * 100}%`);
      c.style.setProperty("--gy", `${py * 100}%`);
    }, { passive: true });
    document.addEventListener("pointerout", (e) => {
      const c = (e.target as HTMLElement).closest?.<HTMLElement>(".tilt");
      if (c && !c.contains(e.relatedTarget as Node)) { c.style.setProperty("--rx", "0deg"); c.style.setProperty("--ry", "0deg"); }
    });
  }
}
