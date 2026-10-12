// Docs page: 3D stack in the header, table-of-contents scroll spy.

import { createStack, hasWebGL } from "./stack3d";
import { $, $$, initChrome } from "./common";

initChrome();

const canvas = $<HTMLCanvasElement>("#docsCanvas");
if (hasWebGL()) {
  const stack = createStack(canvas, { sold: 6, compact: true });
  stack.setExplode(0.9);
} else {
  canvas.hidden = true;
}

const links = $$<HTMLAnchorElement>("#toc a");
const setOn = (id: string) => {
  links.forEach((a) => {
    const on = a.getAttribute("href") === "#" + id;
    a.classList.toggle("on", on);
    if (on && matchMedia("(max-width: 960px)").matches) a.scrollIntoView({ block: "nearest", inline: "center" });
  });
};
const io = new IntersectionObserver((es) => {
  es.forEach((e) => { if (e.isIntersecting) setOn(e.target.id); });
}, { rootMargin: "-20% 0px -70% 0px" });
$$("[data-ds]").forEach((s) => io.observe(s));
