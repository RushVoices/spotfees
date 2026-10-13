// The 3D Spot: ten beveled coins, one per Spot of a token's creator fees.
// Green jade coins are still for sale, pearl ones are taken. Fee "sparks"
// spiral up into the stack. Scroll fans the coins into a helix; hovering a
// coin pulls it out.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface StackOptions {
  /** Coins already taken (0-10). */
  sold?: number;
  /** Plays the take animation on a loop (hero). */
  autoplay?: boolean;
  /** Mouse parallax + hover. */
  interactive?: boolean;
  /** Smaller camera framing for side panels. */
  compact?: boolean;
  onHover?: (index: number | null, x: number, y: number) => void;
  onTake?: (sold: number) => void;
  /** Camera distance multiplier (1 = default framing). */
  zoom?: number;
  /** Freeze motion, for still renders (brand images). */
  still?: boolean;
  /** Tone-mapping exposure; lower gives deeper, more saturated jade. */
  exposure?: number;
}

export interface StackHandle {
  setSold(n: number, animate?: boolean): void;
  setExplode(e: number): void;
  dispose(): void;
}

const N = 10;
const R = 1.55; // coin radius
const H = 0.2; // coin thickness
const GAP = 0.09;

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function coinProfile(): THREE.Vector2[] {
  const b = 0.07; // bevel radius
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -H / 2)];
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let k = 0; k <= 8; k++) {
      const a = a0 + ((a1 - a0) * k) / 8;
      pts.push(new THREE.Vector2(cx + Math.cos(a) * b, cy + Math.sin(a) * b));
    }
  };
  arc(R - b, -H / 2 + b, -Math.PI / 2, 0);
  arc(R - b, H / 2 - b, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(0, H / 2));
  return pts;
}

/** Engraved face: guilloché rings, the Spot number and a tiny legend. */
function faceTexture(i: number, taken: boolean): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const ink = taken ? "rgba(6,95,60,0.6)" : "rgba(255,255,255,0.8)";
  g.translate(s / 2, s / 2);
  g.strokeStyle = ink;
  g.lineWidth = 2;
  g.beginPath(); g.arc(0, 0, s * 0.46, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 1;
  g.beginPath(); g.arc(0, 0, s * 0.43, 0, Math.PI * 2); g.stroke();
  // guilloché rosette
  g.globalAlpha = 0.5;
  for (let k = 0; k < 36; k++) {
    g.beginPath();
    g.ellipse(0, 0, s * 0.3, s * 0.12, (k * Math.PI) / 36, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalAlpha = 1;
  // ticks
  for (let k = 0; k < 60; k++) {
    const a = (k / 60) * Math.PI * 2;
    const r0 = s * (k % 6 === 0 ? 0.385 : 0.4);
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * s * 0.42, Math.sin(a) * s * 0.42);
    g.stroke();
  }
  g.fillStyle = taken ? "rgba(6,78,50,0.9)" : "rgba(255,255,255,1)";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `italic 400 ${s * 0.22}px "Instrument Serif", Georgia, serif`;
  g.fillText(String(i + 1).padStart(2, "0"), 0, s * 0.01);
  g.font = `500 ${s * 0.034}px "Geist Mono", ui-monospace, monospace`;
  g.fillText("SPOT · 10% OF FEES", 0, s * 0.2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function shadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(4,60,38,0.38)");
  grd.addColorStop(0.45, "rgba(4,60,38,0.14)");
  grd.addColorStop(1, "rgba(4,60,38,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function createStack(canvas: HTMLCanvasElement, opts: StackOptions = {}): StackHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(opts.compact ? 30 : 32, 1, 0.1, 100);
  const camDist = (opts.compact ? 11.5 : 10.5) * (opts.zoom ?? 1);

  // lights: soft key, cool fill, green rim
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 7, 5);
  scene.add(key);
  const rim = new THREE.PointLight(0x2bff9c, 30, 14, 2);
  rim.position.set(-3.5, 1.5, -3);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9f5e6, 0.6));

  const root = new THREE.Group();
  scene.add(root);
  const stackGroup = new THREE.Group();
  root.add(stackGroup);

  // materials
  const jade = new THREE.MeshPhysicalMaterial({
    color: 0x12c27a, roughness: 0.2, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.06,
    sheen: 0.6, sheenColor: new THREE.Color(0x9dffcf), iridescence: 0.25, iridescenceIOR: 1.4,
  });
  const pearl = new THREE.MeshPhysicalMaterial({
    color: 0xf4f8f5, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12,
    sheen: 0.5, sheenColor: new THREE.Color(0xc8f7de),
  });
  const chrome = new THREE.MeshStandardMaterial({ color: 0x7ff0b6, metalness: 1, roughness: 0.18, emissive: 0x0a5c38, emissiveIntensity: 0.25 });

  const coinGeo = new THREE.LatheGeometry(coinProfile(), 128);
  const faceGeo = new THREE.CircleGeometry(R - 0.09, 96);
  const rimGeo = new THREE.TorusGeometry(R - 0.004, 0.016, 12, 160);

  interface Coin {
    group: THREE.Group;
    body: THREE.Mesh;
    face: THREE.Mesh;
    faceBottom: THREE.Mesh;
    taken: boolean;
    texJade: THREE.CanvasTexture;
    texPearl: THREE.CanvasTexture;
    hover: number; // 0..1
    take: number; // -1 idle, else 0..1 progress of take animation
  }

  const coins: Coin[] = [];
  // Small fixed offsets so it reads as a hand-stacked pile, not a cylinder.
  const jitter = Array.from({ length: N }, (_, i) => ({
    x: Math.sin(i * 12.9898) * 0.07,
    z: Math.cos(i * 78.233) * 0.07,
    r: Math.sin(i * 3.7) * 0.5,
  }));
  for (let i = 0; i < N; i++) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(coinGeo, jade);
    body.userData.index = i;
    group.add(body);
    const texJade = faceTexture(i, false);
    const texPearl = faceTexture(i, true);
    const faceMat = new THREE.MeshStandardMaterial({ map: texJade, transparent: true, roughness: 0.4, metalness: 0, depthWrite: false });
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.rotation.x = -Math.PI / 2;
    face.position.y = H / 2 + 0.002;
    group.add(face);
    const faceBottom = new THREE.Mesh(faceGeo, faceMat);
    faceBottom.rotation.x = Math.PI / 2;
    faceBottom.position.y = -H / 2 - 0.002;
    group.add(faceBottom);
    for (const y of [H / 2 - 0.035, -H / 2 + 0.035]) {
      const ring = new THREE.Mesh(rimGeo, chrome);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      ring.scale.setScalar(1.0);
      group.add(ring);
    }
    stackGroup.add(group);
    coins.push({ group, body, face, faceBottom, taken: false, texJade, texPearl, hover: 0, take: -1 });
  }

  const paint = (c: Coin) => {
    c.body.material = c.taken ? pearl : jade;
    (c.face.material as THREE.MeshStandardMaterial).map = c.taken ? c.texPearl : c.texJade;
    (c.face.material as THREE.MeshStandardMaterial).needsUpdate = true;
  };

  let sold = Math.max(0, Math.min(N, opts.sold ?? 0));
  // Taken coins sit at the bottom of the stack, like a filled meter.
  coins.forEach((c, i) => { c.taken = i < sold; paint(c); });

  // contact shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 7),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  root.add(shadow);

  // halo ring on the floor
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(2.05, 2.08, 128),
    new THREE.MeshBasicMaterial({ color: 0x16c47f, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  );
  halo.rotation.x = -Math.PI / 2;
  root.add(halo);
  const halo2 = halo.clone();
  (halo2.material as THREE.MeshBasicMaterial) = (halo.material as THREE.MeshBasicMaterial).clone();
  halo2.scale.setScalar(1.25);
  root.add(halo2);

  // fee sparks
  const SPARKS = opts.compact ? 90 : 180;
  const sparkGeo = new THREE.IcosahedronGeometry(0.035, 1);
  const sparkMat = new THREE.MeshStandardMaterial({ color: 0x3dffa8, emissive: 0x19e08a, emissiveIntensity: 1.6, roughness: 0.3 });
  const sparks = new THREE.InstancedMesh(sparkGeo, sparkMat, SPARKS);
  const sparkSeed = Array.from({ length: SPARKS }, () => ({
    phase: Math.random(),
    speed: 0.05 + Math.random() * 0.07,
    radius: 2.1 + Math.random() * 1.4,
    turns: 1 + Math.random() * 1.5,
    size: 0.5 + Math.random() * 0.9,
  }));
  root.add(sparks);
  const dummy = new THREE.Object3D();

  // state
  let explode = 0;
  let explodeTarget = 0;
  let mx = 0, my = 0, tmx = 0, tmy = 0;
  let hovered: number | null = null;
  let visible = true;
  let raf = 0;
  let lastTake = performance.now();
  let resetAt = 0;
  const clock = new THREE.Clock();
  const motion = !reduceMotion() && !opts.still;

  const stackHeight = () => N * H + (N - 1) * GAP;

  function layout(t: number) {
    const e = ease(explode);
    const spacing = lerp(H + GAP, H + 0.42, e);
    const total = spacing * (N - 1);
    coins.forEach((c, i) => {
      const k = i / (N - 1);
      const breathe = motion ? Math.sin(t * 1.4 + i * 0.6) * 0.012 : 0;
      let y = -total / 2 + i * spacing + breathe;
      const helix = e * (k - 0.5) * 2.2;
      let x = Math.sin(helix * 1.4) * e * 0.9;
      let z = Math.cos(helix * 1.4) * e * 0.4 - e * 0.4;
      x += jitter[i].x * (1 - e);
      z += jitter[i].z * (1 - e);
      let ry = i * 0.22 * e + jitter[i].r;
      let rx = e * 0.35;
      let rz = 0;
      // hover pull-out
      x += c.hover * 0.55;
      y += c.hover * 0.06;
      rz += c.hover * -0.08;
      // take animation: slide out, flip, slide back
      if (c.take >= 0) {
        const p = c.take;
        const out = Math.sin(Math.min(1, p) * Math.PI);
        x += out * 2.4;
        y += out * 0.35;
        rx += ease(Math.min(1, p * 1.15)) * Math.PI * 2;
        rz += out * 0.25;
      }
      c.group.position.set(x, y, z);
      c.group.rotation.set(rx, ry, rz);
    });
    shadow.position.y = -total / 2 - H / 2 - 0.02 - e * 0.3;
    halo.position.y = halo2.position.y = shadow.position.y + 0.001;
    const sm = shadow.material as THREE.MeshBasicMaterial;
    sm.opacity = 1 - e * 0.5;
  }

  function updateSparks(t: number) {
    const top = stackHeight() / 2 + 0.2;
    const bottom = -stackHeight() / 2 - 0.6;
    for (let i = 0; i < SPARKS; i++) {
      const s = sparkSeed[i];
      const p = (s.phase + t * s.speed) % 1;
      const a = p * Math.PI * 2 * s.turns + i;
      const r = s.radius * (1 - ease(p) * 0.78);
      dummy.position.set(Math.cos(a) * r, lerp(bottom, top, p), Math.sin(a) * r);
      const fade = Math.sin(p * Math.PI);
      dummy.scale.setScalar(s.size * fade);
      dummy.updateMatrix();
      sparks.setMatrixAt(i, dummy.matrix);
    }
    sparks.instanceMatrix.needsUpdate = true;
  }

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the stack framed on tall, narrow screens
    const fit = Math.max(1, 0.9 / camera.aspect);
    camera.position.set(0, 4.3, camDist * fit);
    camera.lookAt(0, -0.1, 0);
    camera.updateProjectionMatrix();
  }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(clientX: number, clientY: number) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(coins.map((c) => c.body), false)[0];
    return hit ? (hit.object.userData.index as number) : null;
  }

  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    tmx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    tmy = ((e.clientY - r.top) / r.height - 0.5) * 2;
    if (!opts.interactive || e.pointerType === "touch") return;
    const idx = pick(e.clientX, e.clientY);
    if (idx !== hovered) {
      hovered = idx;
      canvas.style.cursor = idx === null ? "" : "pointer";
    }
    opts.onHover?.(hovered, e.clientX - r.left, e.clientY - r.top);
  };
  const onLeave = () => {
    tmx = tmy = 0;
    hovered = null;
    canvas.style.cursor = "";
    opts.onHover?.(null, 0, 0);
  };
  if (opts.interactive) {
    window.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("pointerleave", onLeave);
  }

  function takeNext() {
    if (sold >= N) return;
    const c = coins[sold];
    c.take = 0;
    sold++;
    opts.onTake?.(sold);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    mx = lerp(mx, tmx, 0.05);
    my = lerp(my, tmy, 0.05);
    explode = lerp(explode, explodeTarget, 0.08);

    root.rotation.y = (motion ? t * 0.18 : 0.6) + mx * 0.35;
    root.rotation.x = my * 0.08;
    root.position.y = motion ? Math.sin(t * 0.8) * 0.06 : 0;

    for (const c of coins) {
      const target = hovered !== null && coins[hovered] === c ? 1 : 0;
      c.hover = lerp(c.hover, target, 0.14);
      if (c.take >= 0) {
        c.take += dt / 1.5;
        if (c.take >= 0.5 && !c.taken) { c.taken = true; paint(c); }
        if (c.take >= 1) c.take = -1;
      }
    }

    if (opts.autoplay && motion) {
      const now = performance.now();
      if (sold < N && now - lastTake > 2600) { lastTake = now; takeNext(); }
      if (sold >= N && !resetAt) resetAt = now + 2800;
      if (resetAt && now > resetAt) {
        resetAt = 0;
        lastTake = now;
        sold = Math.min(3, N);
        coins.forEach((c, i) => { c.taken = i < sold; paint(c); });
        opts.onTake?.(sold);
      }
    }

    halo.scale.setScalar(1 + Math.sin(t * 1.6) * 0.02);
    (halo2.material as THREE.MeshBasicMaterial).opacity = 0.12 + Math.sin(t * 1.6 + 1) * 0.06;
    rim.intensity = 26 + Math.sin(t * 2) * 6;

    layout(t);
    updateSparks(motion ? t : 0);
    renderer.render(scene, camera);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; clock.getDelta(); }, { threshold: 0 });
  io.observe(canvas);
  resize();
  // Fonts load after first paint: redraw faces once they are ready.
  document.fonts?.ready.then(() => {
    coins.forEach((c, i) => {
      c.texJade.dispose(); c.texPearl.dispose();
      c.texJade = faceTexture(i, false); c.texPearl = faceTexture(i, true);
      (c.face.material as THREE.MeshStandardMaterial).dispose();
      const m = new THREE.MeshStandardMaterial({ map: c.taken ? c.texPearl : c.texJade, transparent: true, roughness: 0.4, depthWrite: false });
      c.face.material = m; c.faceBottom.material = m;
    });
  });
  frame();

  return {
    setSold(n: number, animate = true) {
      n = Math.max(0, Math.min(N, n));
      if (animate && n === sold + 1) { takeNext(); return; }
      sold = n;
      coins.forEach((c, i) => { c.taken = i < sold; c.take = -1; paint(c); });
    },
    setExplode(e: number) { explodeTarget = Math.max(0, Math.min(1, e)); if (opts.still) explode = explodeTarget; },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      renderer.dispose();
      pmrem.dispose();
      envTex.dispose();
    },
  };
}

/** True when WebGL is available (falls back to the CSS stack otherwise). */
export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
