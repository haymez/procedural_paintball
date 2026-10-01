// Foliage textures for the instanced props.
//
//  - tLeaf: an array texture of canvas-painted, alpha-tested leaf cards
//    (leafy sprays, palm / fern / banana fronds, needles, big understory
//    leaves, flowers). Painted once at startup in a few hundred ms; colors are
//    natural albedo, vertex colors only tint around white.
//  - tBark: CC0 bark photos (Poly Haven, see public/tex/CREDITS.md) tiling
//    along trunks; vertex color carries the species hue, the photo the detail.
//
// Geometry addresses them through the `tuv` attribute (u, v, layer, flags):
// layer < 0 untextured, 0..15 bark layer, >= 16 leaf page (layer - 16).
import * as THREE from "three";
import { loadTextureArray, texUrl } from "../assets";
import { rng } from "./builder";

export const LEAF_RES = 1024;
export const LEAF_BASE = 16;

/** Rect on a leaf page in uv (v down, as painted). */
export interface Cell { page: number; x0: number; y0: number; x1: number; y1: number }
const C = (page: number, x0: number, y0: number, x1: number, y1: number): Cell => ({ page, x0, y0, x1, y1 });

export const CELL = {
  // page 0: leafy sprays (round clusters seen from outside)
  broad: C(0, 0, 0, 0.5, 0.5), // glossy tropical oval leaves
  small: C(0, 0.5, 0, 1, 0.5), // small dense leaves (holm oak, maquis, naupaka, mangrove, citrus)
  fine: C(0, 0, 0.5, 0.5, 1), // bipinnate leaflets (monkeypod / albizia / acacia)
  olive: C(0, 0.5, 0.5, 1, 1), // narrow silvery leaves
  // page 1: long bands, u along the frond (base -> tip), v across (rachis at the bottom)
  palm: C(1, 0, 0, 1, 0.25), // coconut frond: one side of leaflets
  fern: C(1, 0, 0.25, 1, 0.5), // fern frond: one side of pinnae
  banana: C(1, 0, 0.5, 1, 0.75), // half a banana leaf blade, torn
  strap: C(1, 0, 0.75, 1, 0.875), // whole green strap leaf (ginger / lily / agave)
  ti: C(1, 0, 0.875, 1, 1), // whole red-maroon ti leaf
  // page 2: big single leaves and conifer foliage
  monstera: C(2, 0, 0, 0.5, 0.5),
  heart: C(2, 0.5, 0, 1, 0.5), // elephant ear / taro
  needles: C(2, 0, 0.5, 0.5, 1), // pine branchlet with needle tufts
  scale: C(2, 0.5, 0.5, 1, 1), // cypress scale foliage
  // page 3: far-LOD crown masses, flowers
  denseBroad: C(3, 0, 0, 0.5, 0.5),
  denseNeedle: C(3, 0.5, 0, 1, 0.5),
  bougain: C(3, 0, 0.5, 0.5, 1),
  daisy: C(3, 0.5, 0.5, 0.75, 0.75),
  yellow: C(3, 0.75, 0.5, 1, 0.75),
  pink: C(3, 0.5, 0.75, 0.75, 1),
  hibiscus: C(3, 0.75, 0.75, 1, 1),
} as const;
export type CellName = keyof typeof CELL;
const PAGES = 4;

/** uv inside a cell: s 0..1 left -> right, t 0..1 bottom -> top of the painting. */
export function cellUV(c: Cell, s: number, t: number): [number, number] {
  return [c.x0 + (c.x1 - c.x0) * s, c.y0 + (c.y1 - c.y0) * (1 - t)];
}
export const leafLayer = (c: Cell) => LEAF_BASE + c.page;

export const BARK = { palm: 0, smooth: 1, furrow: 2, pine: 3 } as const;
const BARK_FILES = ["palm_tree_bark", "chinese_hackberry_bark", "bark_brown_02", "pine_bark"];
const BARK_FALLBACK = [[150, 140, 125], [120, 110, 95], [110, 95, 80], [120, 85, 65]];

// ------------------------------------------------------------------ painting
type Ctx = OffscreenCanvasRenderingContext2D;
type RGB = [number, number, number];
type Rnd = () => number;
const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const css = (c: RGB, a = 1) => `rgba(${cl(c[0])},${cl(c[1])},${cl(c[2])},${a})`;
const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const jit = (c: RGB, r: Rnd, v = 0.1, hue = 0.06): RGB => {
  const k = 1 + (r() - 0.5) * 2 * v, h = (r() - 0.5) * 2 * hue;
  return [c[0] * k * (1 + h), c[1] * k, c[2] * k * (1 - h)];
};

/** Leaf outline along +x from the base (0,0) to the tip (L,0). */
function leafPath(ctx: Ctx, L: number, W: number, widest = 0.45, tip = 0.5, base = 0.5) {
  const m = L * widest;
  const b1 = m * (0.12 + base * 0.12), bw = W * (0.3 + base * 0.65);
  const t1 = L - (L - m) * (0.12 + tip * 0.25), tw = W * (0.5 - tip * 0.38);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(b1, -bw, m * 0.55, -W, m, -W);
  ctx.bezierCurveTo(m + (L - m) * 0.45, -W, t1, -tw, L, 0);
  ctx.bezierCurveTo(t1, tw, m + (L - m) * 0.45, W, m, W);
  ctx.bezierCurveTo(m * 0.55, W, b1, bw, 0, 0);
  ctx.closePath();
}

interface LeafStyle {
  base: RGB; tip: RGB; rib: RGB; edge: RGB;
  shape?: [number, number, number]; // widest, tip, base
  veins?: number; gloss?: number;
}

/** One leaf with a folded midrib, veins, tip color, darker rim and a soft gloss. shade < 1 for leaves deeper in a cluster. */
function paintLeaf(ctx: Ctx, x: number, y: number, ang: number, L: number, W: number, st: LeafStyle, shade: number, r: Rnd, detail = true) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  if (r() < 0.5) ctx.scale(1, -1);
  const [wd, tp, bs] = st.shape ?? [0.45, 0.5, 0.5];
  leafPath(ctx, L, W, wd, tp, bs);
  const base = jit(mul(st.base, shade), r, 0.08, 0.05);
  if (!detail) {
    const g = ctx.createLinearGradient(0, -W, 0, W);
    g.addColorStop(0, css(mul(base, 1.08)));
    g.addColorStop(1, css(mul(base, 0.8)));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.clip();
  // across: the half facing the light is brighter, the fold darker
  const g = ctx.createLinearGradient(0, -W, 0, W);
  g.addColorStop(0, css(mul(base, 1.0)));
  g.addColorStop(0.46, css(mul(base, 1.14)));
  g.addColorStop(0.54, css(mul(base, 0.84)));
  g.addColorStop(1, css(mul(base, 0.74)));
  ctx.fillStyle = g;
  ctx.fillRect(-2, -W - 2, L + 4, 2 * W + 4);
  // along: darker at the base, sun-bleached / yellower toward the tip
  const g2 = ctx.createLinearGradient(0, 0, L, 0);
  g2.addColorStop(0, css(mul(base, 0.7), 0.45));
  g2.addColorStop(0.45, css(st.tip, 0));
  g2.addColorStop(1, css(mul(st.tip, shade), 0.5));
  ctx.fillStyle = g2;
  ctx.fillRect(-2, -W - 2, L + 4, 2 * W + 4);
  // secondary veins
  const nv = st.veins ?? 5;
  ctx.strokeStyle = css(mul(st.rib, shade), 0.22);
  ctx.lineWidth = Math.max(0.6, W * 0.05);
  ctx.beginPath();
  for (let k = 0; k < nv; k++) {
    const x0 = L * (0.12 + (0.75 * k) / nv);
    const d = W * 1.1;
    ctx.moveTo(x0, 0); ctx.quadraticCurveTo(x0 + d * 0.5, -d * 0.45, x0 + d * 0.9, -d);
    ctx.moveTo(x0, 0); ctx.quadraticCurveTo(x0 + d * 0.5, d * 0.45, x0 + d * 0.9, d);
  }
  ctx.stroke();
  // midrib
  ctx.strokeStyle = css(mul(st.rib, shade), 0.6);
  ctx.lineWidth = Math.max(0.8, W * 0.09);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(L * 0.5, W * 0.04, L * 0.93, 0); ctx.stroke();
  // darker rim
  leafPath(ctx, L, W, wd, tp, bs);
  ctx.lineWidth = Math.max(1, W * 0.22);
  ctx.strokeStyle = css(mul(st.edge, shade), 0.2);
  ctx.stroke();
  // soft gloss on the lit half
  if (st.gloss) {
    const rg = ctx.createRadialGradient(L * 0.42, -W * 0.38, 0, L * 0.42, -W * 0.38, L * 0.35);
    rg.addColorStop(0, `rgba(255,255,240,${st.gloss * shade})`);
    rg.addColorStop(1, "rgba(255,255,240,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(-2, -W - 2, L + 4, 2 * W + 4);
  }
  ctx.restore();
  ctx.restore();
}

function twig(ctx: Ctx, pts: [number, number][], w0: number, w1: number, c: RGB) {
  for (let i = 0; i < pts.length - 1; i++) {
    ctx.strokeStyle = css(c);
    ctx.lineWidth = w0 + (w1 - w0) * (i / (pts.length - 1));
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
  }
}

interface SprayOpts {
  twigs: number; leaves: number; L: number; W: number; reach: number; style: LeafStyle; twigC: RGB;
  layers?: number[]; spread?: number; detail?: boolean; tipLeaf?: boolean;
}

/** Round cluster of twigs radiating from the center with leaves along them, painted back to front. */
function spray(ctx: Ctx, cx: number, cy: number, R: number, r: Rnd, o: SprayOpts) {
  const layers = o.layers ?? [0.56, 0.74, 0.9, 1.04];
  const per = Math.ceil(o.twigs / layers.length);
  for (let li = 0; li < layers.length; li++) {
    const shade = layers[li];
    const a0 = r() * Math.PI * 2;
    for (let k = 0; k < per; k++) {
      const a = a0 + ((k + (r() - 0.5) * 0.7) / per) * Math.PI * 2;
      const len = R * o.reach * (0.55 + r() * 0.45) * (li === layers.length - 1 ? 0.85 : 1);
      const bend = (r() - 0.5) * 0.8;
      const st0 = R * 0.08 * r();
      const pts: [number, number][] = [];
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const t = i / n, aa = a + bend * t;
        const d = st0 + len * t;
        pts.push([cx + Math.cos(aa) * d, cy + Math.sin(aa) * d]);
      }
      // skip the inner stretch: the hub where all twigs meet reads as a dark star on the card
      twig(ctx, pts.slice(2), Math.max(1, R * 0.012), 0.7, mul(o.twigC, shade));
      const nl = o.leaves;
      for (let j = 0; j < nl; j++) {
        const t = 0.25 + (0.75 * j) / nl + r() * 0.04;
        const i = Math.min(n - 1, Math.floor(t * n));
        const f = t * n - i;
        const px = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, py = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
        const dir = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
        const side = j % 2 ? 1 : -1;
        const spread = (o.spread ?? 0.75) * (0.7 + r() * 0.6);
        const s = (0.75 + r() * 0.4) * (1 - t * 0.25);
        paintLeaf(ctx, px, py, dir + side * spread, o.L * s, o.W * s, o.style, shade * (0.92 + r() * 0.16), r, o.detail ?? true);
      }
      if (o.tipLeaf ?? true) {
        const e = pts[n], p = pts[n - 1];
        paintLeaf(ctx, e[0], e[1], Math.atan2(e[1] - p[1], e[0] - p[0]) + (r() - 0.5) * 0.3, o.L * 0.95, o.W * 0.95, o.style, shade, r, o.detail ?? true);
      }
    }
  }
  // a few leaves over the middle
  for (let k = 0; k < 5; k++) {
    const a = r() * Math.PI * 2;
    paintLeaf(ctx, cx + Math.cos(a) * R * 0.05, cy + Math.sin(a) * R * 0.05, a, o.L * 0.9, o.W * 0.9, o.style, layers[layers.length - 2], r, o.detail ?? true);
  }
}

/** Bipinnate twig: rachis lines with many tiny paired leaflets (monkeypod / albizia). */
function fineSpray(ctx: Ctx, cx: number, cy: number, R: number, r: Rnd, base: RGB, tip: RGB) {
  const layers = [0.55, 0.72, 0.88, 1.02];
  for (let li = 0; li < layers.length; li++) {
    const shade = layers[li];
    const a0 = r() * Math.PI * 2;
    for (let k = 0; k < 9; k++) {
      const a = a0 + ((k + (r() - 0.5) * 0.7) / 9) * Math.PI * 2;
      const len = R * (0.45 + r() * 0.4);
      const st0 = li === layers.length - 1 ? R * (0.05 + 0.3 * r()) : R * 0.1 * r();
      const x0 = cx + Math.cos(a + 0.4) * st0, y0 = cy + Math.sin(a + 0.4) * st0;
      const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
      twig(ctx, [[x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.3], [x1, y1]], 1.1, 0.6, mul([70, 74, 40], shade));
      // pinnae
      const np = 4 + Math.floor(r() * 3);
      for (let p = 0; p < np; p++) {
        const t = 0.12 + (0.88 * p) / np;
        const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
        for (const side of [-1, 1]) {
          const pa = a + side * (0.5 + r() * 0.5);
          const pl = len * (0.3 + r() * 0.2);
          const qx = px + Math.cos(pa) * pl, qy = py + Math.sin(pa) * pl;
          ctx.strokeStyle = css(mul([90, 100, 50], shade), 0.8);
          ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qx, qy); ctx.stroke();
          const nlf = 9;
          for (let q = 0; q < nlf; q++) {
            const u = (q + 0.5) / nlf;
            const lx = px + (qx - px) * u, ly = py + (qy - py) * u;
            const c = jit(mix(mul(base, shade), mul(tip, shade), u * 0.6), r, 0.1, 0.05);
            for (const s2 of [-1, 1]) {
              const la = pa + s2 * 1.1;
              const ll = pl * 0.16 * (1 - u * 0.35);
              ctx.fillStyle = css(mul(c, s2 > 0 ? 1.05 : 0.86));
              ctx.beginPath();
              ctx.ellipse(lx + Math.cos(la) * ll * 0.5, ly + Math.sin(la) * ll * 0.5, ll * 0.55, ll * 0.24, la, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
    }
  }
}

/** Needle tuft: thin curved needles fanning from a point. */
function tuft(ctx: Ctx, x: number, y: number, dir: number, len: number, n: number, fan: number, base: RGB, tip: RGB, shade: number, r: Rnd, lw = 1.5) {
  for (let i = 0; i < n; i++) {
    const a = dir + (r() - 0.5) * 2 * fan;
    const l = len * (0.65 + r() * 0.35);
    const c = jit(mul(mix(base, tip, r() * 0.7), shade), r, 0.12, 0.04);
    const bend = (r() - 0.5) * 0.25;
    const g = ctx.createLinearGradient(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.addColorStop(0, css(mul(c, 0.7)));
    g.addColorStop(1, css(mix(c, mul(tip, shade), 0.5)));
    ctx.strokeStyle = g;
    ctx.lineWidth = lw * (0.8 + r() * 0.4);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + bend) * l * 0.5, y + Math.sin(a + bend) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
}

// --------------------------------------------------------------- cell painters
type Painter = (ctx: Ctx, x: number, y: number, w: number, h: number, r: Rnd) => void;

const TROPIC: LeafStyle = { base: hex(0x3f7a2c), tip: hex(0x9bbf4a), rib: hex(0xb8d07a), edge: hex(0x1f3f18), shape: [0.42, 0.6, 0.45], veins: 6, gloss: 0.22 };
const SMALL: LeafStyle = { base: hex(0x3d6a2f), tip: hex(0x8aa850), rib: hex(0x9ab070), edge: hex(0x1d3517), shape: [0.45, 0.4, 0.6], veins: 3, gloss: 0.16 };
const OLIVE_TOP: LeafStyle = { base: hex(0x5d6b45), tip: hex(0x93a070), rib: hex(0xa8b090), edge: hex(0x2e3a24), shape: [0.5, 0.7, 0.3], veins: 0, gloss: 0.08 };
const OLIVE_UNDER: LeafStyle = { base: hex(0x9aa58c), tip: hex(0xc2c8b0), rib: hex(0xd5d8c8), edge: hex(0x6a7360), shape: [0.5, 0.7, 0.3], veins: 0, gloss: 0 };

const paintBroad: Painter = (ctx, x, y, w, h, r) => {
  spray(ctx, x + w / 2, y + h / 2, w * 0.5, r, { twigs: 16, leaves: 6, L: w * 0.17, W: w * 0.06, reach: 0.62, style: TROPIC, twigC: hex(0x6a5a3a) });
};
const paintSmall: Painter = (ctx, x, y, w, h, r) => {
  spray(ctx, x + w / 2, y + h / 2, w * 0.5, r, { twigs: 22, leaves: 9, L: w * 0.085, W: w * 0.036, reach: 0.78, style: SMALL, twigC: hex(0x5a4a34), layers: [0.55, 0.68, 0.8, 0.92, 1.04] });
};
const paintFine: Painter = (ctx, x, y, w, h, r) => {
  fineSpray(ctx, x + w / 2, y + h / 2, w * 0.47, r, hex(0x3f6e2a), hex(0x8fb24c));
};
const paintOlive: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2, R = w * 0.5;
  const layers = [0.62, 0.78, 0.92, 1.05];
  for (const shade of layers) {
    for (let k = 0; k < 6; k++) {
      const a = r() * Math.PI * 2, len = R * (0.5 + r() * 0.35);
      const pts: [number, number][] = [];
      for (let i = 0; i <= 5; i++) { const t = i / 5; pts.push([cx + Math.cos(a + t * 0.3) * len * t, cy + Math.sin(a + t * 0.3) * len * t]); }
      twig(ctx, pts.slice(1), 1.4, 0.7, mul(hex(0x6e6450), shade));
      for (let j = 0; j < 12; j++) {
        const t = 0.2 + (0.8 * j) / 12, i = Math.min(4, Math.floor(t * 5)), f = t * 5 - i;
        const px = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, py = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
        const st = r() < 0.38 ? OLIVE_UNDER : OLIVE_TOP;
        paintLeaf(ctx, px, py, a + t * 0.3 + (j % 2 ? 1 : -1) * (0.45 + r() * 0.35), w * 0.12, w * 0.018, st, shade * (0.92 + r() * 0.15), r);
      }
    }
  }
};

/** One side of a pinnate frond in a band: leaflets from the rachis (bottom edge) sweeping toward the tip (right). */
function pinnateBand(ctx: Ctx, x: number, y: number, w: number, h: number, r: Rnd, o: {
  n: number; ang0: number; ang1: number; len: (s: number) => number; width: number; style: LeafStyle; lobed?: boolean; brownTips?: number;
}) {
  const y0 = y + h - 1;
  for (let i = 0; i < o.n; i++) {
    const s = 0.015 + (0.965 * (i + r() * 0.5)) / o.n;
    const px = x + s * w;
    const ang = -(o.ang0 + (o.ang1 - o.ang0) * s) + (r() - 0.5) * 0.08; // up-right
    const L = o.len(s) * (0.9 + r() * 0.15);
    // leaflet as a long narrow leaf; arc slightly
    const shade = 0.88 + r() * 0.2;
    const st = o.brownTips && r() < o.brownTips ? { ...o.style, tip: hex(0xa08a4a) } : o.style;
    if (o.lobed) {
      // fern pinna: overlapping rounded lobes (pinnules) along a tapering axis
      const nl = Math.max(5, Math.round(L / (o.width * 0.55)));
      const c0 = jit(mul(st.base, shade), r, 0.06, 0.03);
      for (let k = 0; k < nl; k++) {
        const u = (k + 0.5) / nl;
        const lw = o.width * (1 - u * 0.7);
        const lx = px + Math.cos(ang) * L * u, ly = y0 + Math.sin(ang) * L * u;
        const c = mix(c0, mul(st.tip, shade), u * 0.7);
        for (const side of [-1, 1]) {
          const la = ang + side * 1.05;
          ctx.fillStyle = css(mul(c, side < 0 ? 1.08 : 0.84));
          ctx.beginPath();
          ctx.ellipse(lx + Math.cos(la) * lw * 0.62, ly + Math.sin(la) * lw * 0.62, lw * 0.78, lw * 0.4, la + 0.45 * side, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.strokeStyle = css(mul(st.rib, shade * 0.8), 0.7);
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px + Math.cos(ang) * L * 0.97, y0 + Math.sin(ang) * L * 0.97); ctx.stroke();
    } else {
      paintLeaf(ctx, px, y0, ang, L, o.width * (0.85 + r() * 0.3), { ...st, shape: [0.38, 0.9, 0.15], veins: 0, gloss: 0.12 }, shade, r);
    }
  }
  // rachis edge
  ctx.fillStyle = css(mix(o.style.rib, o.style.base, 0.3));
  ctx.fillRect(x, y0 - 3, w, 4);
}

const paintPalm: Painter = (ctx, x, y, w, h, r) => {
  pinnateBand(ctx, x, y, w, h, r, {
    n: 46, ang0: 1.0, ang1: 0.62, width: h * 0.034,
    len: (s) => h * 1.02 * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * s)), 0.55) * (1 - s * 0.3) + h * 0.1,
    style: { base: hex(0x4a8a2c), tip: hex(0xb0c458), rib: hex(0xd8d690), edge: hex(0x2c4a1a), veins: 0 },
    brownTips: 0.14,
  });
};
const paintFern: Painter = (ctx, x, y, w, h, r) => {
  pinnateBand(ctx, x, y, w, h, r, {
    n: 40, ang0: 1.15, ang1: 0.8, width: h * 0.075, lobed: true,
    len: (s) => h * 0.98 * Math.pow(Math.sin(Math.PI * (0.06 + 0.94 * s)), 0.7) + h * 0.06,
    style: { base: hex(0x2f6a26), tip: hex(0x84b84a), rib: hex(0x9ab868), edge: hex(0x183a14), veins: 0 },
  });
};

/** Half a banana leaf: blade from the midrib (bottom) to the wavy edge, parallel veins, wind tears. */
const paintBanana: Painter = (ctx, x, y, w, h, r) => {
  const y0 = y + h - 1;
  const wav = [r() * 6, r() * 6, r() * 6];
  const edgeAt = (s: number) => {
    const taper = Math.min(1, s / 0.06) * (s > 0.86 ? Math.sqrt(Math.max(0, 1 - ((s - 0.86) / 0.14) ** 2)) : 1);
    return h * 0.94 * taper * (0.965 + 0.02 * Math.sin(s * 23 + wav[0]) + 0.012 * Math.sin(s * 57 + wav[1]) + 0.006 * Math.sin(s * 131 + wav[2]));
  };
  ctx.beginPath();
  ctx.moveTo(x, y0);
  const N = 160;
  for (let i = 0; i <= N; i++) { const s = i / N; ctx.lineTo(x + s * w, y0 - edgeAt(s)); }
  ctx.lineTo(x + w, y0);
  ctx.closePath();
  ctx.save();
  ctx.clip();
  const g = ctx.createLinearGradient(0, y0, 0, y0 - h);
  g.addColorStop(0, css(hex(0x9cbc52)));
  g.addColorStop(0.12, css(hex(0x5e9a34)));
  g.addColorStop(0.7, css(hex(0x4c8a2c)));
  g.addColorStop(1, css(hex(0x3a6e24)));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // lengthwise light variation
  for (let i = 0; i < 14; i++) {
    const s = r(), ww = w * (0.04 + r() * 0.08);
    ctx.fillStyle = `rgba(${r() < 0.5 ? "255,250,200" : "20,40,10"},${0.05 + r() * 0.06})`;
    ctx.fillRect(x + s * w, y, ww, h);
  }
  // parallel veins slanting toward the tip
  ctx.lineWidth = 1;
  for (let vx = -h; vx < w; vx += 5 + r() * 3) {
    ctx.strokeStyle = r() < 0.5 ? "rgba(200,230,140,0.16)" : "rgba(20,50,15,0.14)";
    ctx.beginPath(); ctx.moveTo(x + vx, y0); ctx.lineTo(x + vx + h * 0.45, y0 - h); ctx.stroke();
  }
  // dried brown margins in patches
  for (let i = 0; i < 6; i++) {
    const s = r(), ww = w * (0.03 + r() * 0.1);
    const gg = ctx.createLinearGradient(0, y0 - edgeAt(s), 0, y0 - edgeAt(s) + h * 0.18);
    gg.addColorStop(0, "rgba(140,110,55,0.85)");
    gg.addColorStop(1, "rgba(140,110,55,0)");
    ctx.fillStyle = gg;
    ctx.fillRect(x + s * w, y, ww, h);
  }
  ctx.restore();
  // midrib
  ctx.fillStyle = css(hex(0xc8d690));
  ctx.fillRect(x, y0 - 4, w, 5);
  // tears along the veins from the edge inward
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 16; i++) {
    const s = 0.08 + r() * 0.82;
    const depth = edgeAt(s) * (0.25 + r() * 0.7);
    const ex = x + s * w, ey = y0 - edgeAt(s) - 2;
    ctx.lineWidth = 1.2 + r() * 2.2;
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - depth * 0.45, ey + depth); ctx.stroke();
  }
  ctx.restore();
};

function strapLeaf(ctx: Ctx, x: number, y: number, w: number, h: number, r: Rnd, base: RGB, tip: RGB, rib: RGB, stripes: number) {
  const cy = y + h / 2, W = h * 0.46;
  ctx.save();
  ctx.translate(x + 2, cy);
  leafPath(ctx, w - 4, W, 0.4, 0.75, 0.2);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, css(mul(base, 0.8)));
  g.addColorStop(0.5, css(base));
  g.addColorStop(1, css(tip));
  ctx.fillStyle = g;
  ctx.fillRect(0, -W, w, 2 * W);
  const g2 = ctx.createLinearGradient(0, -W, 0, W);
  g2.addColorStop(0, "rgba(255,255,230,0.12)");
  g2.addColorStop(0.5, "rgba(255,255,230,0.0)");
  g2.addColorStop(0.55, "rgba(0,0,0,0.12)");
  g2.addColorStop(1, "rgba(0,0,0,0.25)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, -W, w, 2 * W);
  ctx.lineWidth = 1;
  for (let i = 0; i < stripes; i++) {
    const off = (r() - 0.5) * 2 * W;
    ctx.strokeStyle = css(rib, 0.12 + r() * 0.1);
    ctx.beginPath(); ctx.moveTo(0, off * 0.3); ctx.quadraticCurveTo(w * 0.4, off, w, 0); ctx.stroke();
  }
  ctx.strokeStyle = css(rib, 0.55);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w * 0.95, 0); ctx.stroke();
  ctx.restore();
}
const paintStrap: Painter = (ctx, x, y, w, h, r) => strapLeaf(ctx, x, y, w, h, r, hex(0x3f7f2e), hex(0x7aa840), hex(0xa8c878), 10);
const paintTi: Painter = (ctx, x, y, w, h, r) => strapLeaf(ctx, x, y, w, h, r, hex(0x5a1e2c), hex(0x9a2e4a), hex(0xd0607a), 8);

/** Monstera deliciosa: heart-shaped, deep irregular splits and a few holes. Petiole at the bottom center. */
const paintMonstera: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, R = w * 0.47;
  const tipY = y + h * 0.03, sinusY = y + h * 0.8, lobeY = y + h * 0.97;
  const pc: [number, number] = [cx, y + h * 0.78]; // petiole attachment
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, sinusY);
  ctx.bezierCurveTo(cx - R * 0.3, lobeY, cx - R * 1.0, lobeY, cx - R * 0.99, y + h * 0.55);
  ctx.bezierCurveTo(cx - R * 0.97, y + h * 0.22, cx - R * 0.45, tipY + h * 0.02, cx, tipY);
  ctx.bezierCurveTo(cx + R * 0.45, tipY + h * 0.02, cx + R * 0.97, y + h * 0.22, cx + R * 0.99, y + h * 0.55);
  ctx.bezierCurveTo(cx + R * 1.0, lobeY, cx + R * 0.3, lobeY, cx, sinusY);
  ctx.closePath();
  ctx.clip();
  const g = ctx.createRadialGradient(cx - R * 0.2, y + h * 0.4, R * 0.1, cx, y + h * 0.5, R * 1.1);
  g.addColorStop(0, css(hex(0x3a8432)));
  g.addColorStop(1, css(hex(0x1c5420)));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // primary veins fanning from the petiole attachment
  const nv = 8;
  const veins: { a: number; side: number }[] = [];
  for (const side of [-1, 1]) for (let k = 0; k < nv; k++) veins.push({ side, a: -Math.PI / 2 + side * (0.18 + (k / (nv - 1)) * 1.75 + (r() - 0.5) * 0.08) });
  ctx.strokeStyle = "rgba(160,205,115,0.5)";
  ctx.lineWidth = 3.2;
  ctx.beginPath(); ctx.moveTo(pc[0], pc[1]); ctx.lineTo(cx, tipY); ctx.stroke();
  ctx.lineWidth = 1.7;
  for (const v of veins) {
    ctx.beginPath(); ctx.moveTo(pc[0], pc[1]);
    ctx.quadraticCurveTo(pc[0] + Math.cos(v.a) * R * 0.5, pc[1] + Math.sin(v.a) * R * 0.75, pc[0] + Math.cos(v.a) * R * 1.3, pc[1] + Math.sin(v.a) * R * 1.0);
    ctx.stroke();
  }
  // gloss
  const gl = ctx.createRadialGradient(cx - R * 0.35, y + h * 0.35, 0, cx - R * 0.35, y + h * 0.35, R * 0.6);
  gl.addColorStop(0, "rgba(255,255,230,0.2)");
  gl.addColorStop(1, "rgba(255,255,230,0)");
  ctx.fillStyle = gl;
  ctx.fillRect(x, y, w, h);
  // rim
  ctx.lineWidth = 7;
  ctx.strokeStyle = "rgba(10,40,10,0.25)";
  ctx.stroke();
  // splits between neighbouring veins (from the margin, irregular depth) and a few holes
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.lineCap = "round";
  for (let i = 0; i < veins.length - 1; i++) {
    if (veins[i].side !== veins[i + 1].side || r() < 0.18) continue;
    const a = (veins[i].a + veins[i + 1].a) / 2 + (r() - 0.5) * 0.06;
    const inner = 0.45 + r() * 0.35;
    ctx.lineWidth = 4 + r() * 5;
    ctx.beginPath();
    ctx.moveTo(pc[0] + Math.cos(a) * R * 1.4, pc[1] + Math.sin(a) * R * 1.1);
    ctx.lineTo(pc[0] + Math.cos(a) * R * inner, pc[1] + Math.sin(a) * R * inner * 0.8);
    ctx.stroke();
    if (r() < 0.5) {
      const d = R * (0.22 + r() * 0.12);
      ctx.beginPath();
      ctx.ellipse(pc[0] + Math.cos(a) * d, pc[1] + Math.sin(a) * d * 0.8, R * 0.06, R * 0.025, a, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
};

/** Elephant ear / taro: arrow-heart leaf, pale veins. Petiole attaches near the notch (bottom center). */
const paintHeart: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, R = w * 0.46;
  const tipY = y + h * 0.04, notchY = y + h * 0.72, lobeY = y + h * 0.96;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, notchY);
  ctx.bezierCurveTo(cx - R * 0.35, lobeY, cx - R * 1.05, lobeY, cx - R * 1.0, y + h * 0.62);
  ctx.bezierCurveTo(cx - R * 0.95, y + h * 0.3, cx - R * 0.4, y + h * 0.1, cx, tipY);
  ctx.bezierCurveTo(cx + R * 0.4, y + h * 0.1, cx + R * 0.95, y + h * 0.3, cx + R * 1.0, y + h * 0.62);
  ctx.bezierCurveTo(cx + R * 1.05, lobeY, cx + R * 0.35, lobeY, cx, notchY);
  ctx.closePath();
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, css(hex(0x5c9a3c)));
  g.addColorStop(1, css(hex(0x2e6a28)));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const pc: [number, number] = [cx, y + h * 0.66];
  ctx.strokeStyle = "rgba(200,230,160,0.55)";
  for (let k = 0; k < 11; k++) {
    const a = -Math.PI / 2 + (k - 5) * 0.32;
    ctx.lineWidth = k === 5 ? 3 : 1.6;
    ctx.beginPath(); ctx.moveTo(pc[0], pc[1]);
    ctx.quadraticCurveTo(pc[0] + Math.cos(a) * R * 0.5, pc[1] + Math.sin(a) * R * 0.6, pc[0] + Math.cos(a) * R * 1.2, pc[1] + Math.sin(a) * R * 1.2 * (Math.abs(k - 5) > 3 ? 0.7 : 1));
    ctx.stroke();
  }
  const gl = ctx.createRadialGradient(cx - R * 0.3, y + h * 0.35, 0, cx - R * 0.3, y + h * 0.35, R * 0.7);
  gl.addColorStop(0, "rgba(255,255,230,0.2)");
  gl.addColorStop(1, "rgba(255,255,230,0)");
  ctx.fillStyle = gl;
  ctx.fillRect(x, y, w, h);
  // rim
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(20,50,15,0.25)";
  ctx.stroke();
  ctx.restore();
};

const PINE_N: RGB = hex(0x3f5f2c), PINE_T: RGB = hex(0x8aa058);
/** Pine branch end: twig from the bottom center with needle tufts along and at the tips. */
const paintNeedles: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2;
  for (const shade of [0.6, 0.78, 0.92, 1.05]) {
    for (let k = 0; k < 7; k++) {
      const a = r() * Math.PI * 2, len = w * (0.18 + r() * 0.2);
      const sx = cx + Math.cos(a) * w * 0.05 * r(), sy = cy + Math.sin(a) * w * 0.05 * r();
      const ex = sx + Math.cos(a) * len, ey = sy + Math.sin(a) * len;
      twig(ctx, [[sx, sy], [ex, ey]], 2.2, 1.2, mul(hex(0x6a4a32), shade));
      for (let j = 0; j < 3; j++) {
        const t = 0.35 + j * 0.3;
        tuft(ctx, sx + (ex - sx) * t, sy + (ey - sy) * t, a + (j % 2 ? 0.7 : -0.7), w * 0.11, 26, 0.55, PINE_N, PINE_T, shade, r, 1.6);
      }
      tuft(ctx, ex, ey, a, w * 0.14, 44, 0.9, PINE_N, PINE_T, shade, r, 1.7);
    }
  }
};
/** Cypress / juniper scale foliage: flattened sprays of tiny rounded scales. */
const paintScale: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2;
  const base = hex(0x2e5028), tip = hex(0x6f8e48);
  for (const shade of [0.55, 0.72, 0.88, 1.02]) {
    for (let k = 0; k < 10; k++) {
      const a = r() * Math.PI * 2, len = w * (0.2 + r() * 0.22);
      const sx = cx + Math.cos(a) * w * 0.06 * r(), sy = cy + Math.sin(a) * w * 0.06 * r();
      // main sprig and side sprigs, each a chain of overlapping scales
      const sprig = (x0: number, y0: number, aa: number, L: number, wd: number) => {
        const n = Math.max(3, Math.round(L / (wd * 0.9)));
        for (let i = 0; i < n; i++) {
          const u = i / n;
          const c = jit(mul(mix(base, tip, u * 0.8), shade), r, 0.08, 0.03);
          ctx.fillStyle = css(c);
          ctx.beginPath();
          ctx.ellipse(x0 + Math.cos(aa) * L * u, y0 + Math.sin(aa) * L * u, wd * (1 - u * 0.5), wd * 0.6 * (1 - u * 0.5), aa, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      sprig(sx, sy, a, len, w * 0.022);
      for (let j = 1; j < 6; j++) {
        const t = j / 6, px = sx + Math.cos(a) * len * t, py = sy + Math.sin(a) * len * t;
        sprig(px, py, a + (j % 2 ? 0.8 : -0.8), len * 0.35 * (1 - t * 0.5), w * 0.016);
      }
    }
  }
};

/** Far-LOD crown mass: a disc packed with small leaves, ragged leafy rim. */
const paintDenseBroad: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2, R = w * 0.44;
  const st: LeafStyle = { ...TROPIC, veins: 0, gloss: 0 };
  for (const [shade, n, rr] of [[0.55, 260, 0.82], [0.72, 260, 0.9], [0.88, 220, 0.95], [1.02, 160, 1.0]] as const) {
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R * rr;
      paintLeaf(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r() * Math.PI * 2, w * 0.075, w * 0.03, st, shade * (0.9 + r() * 0.2), r, false);
    }
  }
};
const paintDenseNeedle: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2, R = w * 0.4;
  for (const [shade, n] of [[0.55, 70], [0.72, 70], [0.88, 60], [1.02, 45]] as const) {
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R;
      tuft(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r() * Math.PI * 2, w * 0.07, 16, 1.4, PINE_N, PINE_T, shade, r, 1.5);
    }
  }
};

const BOUG_LEAF: LeafStyle = { base: hex(0x3f7a30), tip: hex(0x7aa848), rib: hex(0x9ac070), edge: hex(0x1f3f18), shape: [0.4, 0.55, 0.7], veins: 3, gloss: 0.12 };
/** Bougainvillea: leafy spray covered in clusters of papery magenta bracts. */
const paintBougain: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2, R = w * 0.46;
  spray(ctx, cx, cy, R, r, { twigs: 12, leaves: 5, L: w * 0.11, W: w * 0.05, reach: 0.65, style: BOUG_LEAF, twigC: hex(0x5a4a34), layers: [0.6, 0.8, 1.0] });
  const cols = [hex(0xd02f8c), hex(0xe0489c), hex(0xb8287c), hex(0xe86ab0)];
  for (let i = 0; i < 34; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R * 0.85;
    const bx = cx + Math.cos(a) * d, by = cy + Math.sin(a) * d;
    const c = cols[Math.floor(r() * cols.length)];
    const s = w * (0.03 + r() * 0.02);
    const shade = 0.8 + r() * 0.3;
    for (let b = 0; b < 3; b++) {
      const ba = r() * 0.4 + (b * Math.PI * 2) / 3;
      ctx.fillStyle = css(jit(mul(c, shade), r, 0.08, 0.04));
      ctx.beginPath();
      ctx.ellipse(bx + Math.cos(ba) * s * 0.6, by + Math.sin(ba) * s * 0.6, s * 0.75, s * 0.55, ba, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = css(mul(c, shade * 0.75), 0.4);
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(250,245,225,0.9)";
    ctx.beginPath(); ctx.arc(bx, by, s * 0.15, 0, Math.PI * 2); ctx.fill();
  }
};

function petals(ctx: Ctx, cx: number, cy: number, n: number, R: number, wr: number, c0: RGB, c1: RGB, r: Rnd, rot = 0) {
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.15;
    const px = cx + Math.cos(a) * R * 0.5, py = cy + Math.sin(a) * R * 0.5;
    const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.addColorStop(0, css(c0));
    g.addColorStop(1, css(c1));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(px, py, R * 0.52, R * wr, a, 0, Math.PI * 2);
    ctx.fill();
  }
}
const paintDaisy: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2;
  petals(ctx, cx, cy, 14, w * 0.42, 0.11, hex(0xe8e4d0), hex(0xfffdf4), r);
  ctx.fillStyle = css(hex(0xe8b020)); ctx.beginPath(); ctx.arc(cx, cy, w * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(150,90,10,0.5)"; ctx.beginPath(); ctx.arc(cx + w * 0.02, cy + w * 0.02, w * 0.06, 0, Math.PI * 2); ctx.fill();
};
const paintYellow: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2;
  petals(ctx, cx, cy, 5, w * 0.44, 0.24, hex(0xe0a010), hex(0xffe060), r, 0.3);
  ctx.fillStyle = css(hex(0xc87810)); ctx.beginPath(); ctx.arc(cx, cy, w * 0.07, 0, Math.PI * 2); ctx.fill();
};
const paintPink: Painter = (ctx, x, y, w, h, r) => {
  // a dome of small florets (lantana-like cluster), pinks and oranges
  const cx = x + w / 2, cy = y + h / 2;
  const cs = [hex(0xf06aa0), hex(0xf89ac0), hex(0xffc060), hex(0xf8e070)];
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * w * 0.36;
    const c = d < w * 0.15 ? cs[2 + Math.floor(r() * 2)] : cs[Math.floor(r() * 2)];
    petals(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 4, w * 0.12, 0.3, mul(c, 0.85), c, r, r() * 3);
  }
};
const paintHibiscus: Painter = (ctx, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2;
  petals(ctx, cx, cy, 5, w * 0.46, 0.33, hex(0x9a1020), hex(0xf03a3a), r, 0.2);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.14);
  g.addColorStop(0, "rgba(90,0,20,0.9)"); g.addColorStop(1, "rgba(90,0,20,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, w * 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = css(hex(0xf8d040)); ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + w * 0.2, cy - w * 0.16); ctx.stroke();
};

const PAINTERS: Record<CellName, Painter> = {
  broad: paintBroad, small: paintSmall, fine: paintFine, olive: paintOlive,
  palm: paintPalm, fern: paintFern, banana: paintBanana, strap: paintStrap, ti: paintTi,
  monstera: paintMonstera, heart: paintHeart, needles: paintNeedles, scale: paintScale,
  denseBroad: paintDenseBroad, denseNeedle: paintDenseNeedle, bougain: paintBougain,
  daisy: paintDaisy, yellow: paintYellow, pink: paintPink, hibiscus: paintHibiscus,
};

/**
 * Fill the color of transparent texels from their opaque neighbors (pull-push
 * over a mip pyramid) so mipmapping doesn't bleed black into leaf edges.
 */
function dilate(px: Uint8ClampedArray, n: number) {
  // pull: premultiplied color + coverage pyramid
  const levels: { c: Float32Array; w: Float32Array; n: number }[] = [];
  let c = new Float32Array(n * n * 3), w = new Float32Array(n * n);
  for (let i = 0, j = 0; i < n * n; i++, j += 3) {
    const a = px[i * 4 + 3] * (1 / 255);
    w[i] = a;
    c[j] = px[i * 4] * a; c[j + 1] = px[i * 4 + 1] * a; c[j + 2] = px[i * 4 + 2] * a;
  }
  levels.push({ c, w, n });
  let s = n;
  while (s > 1) {
    const h = s >> 1;
    const c2 = new Float32Array(h * h * 3), w2 = new Float32Array(h * h);
    for (let y = 0; y < h; y++) {
      const r0 = y * 2 * s, r1 = r0 + s;
      for (let x = 0; x < h; x++) {
        const i0 = r0 + x * 2, i1 = i0 + 1, i2 = r1 + x * 2, i3 = i2 + 1, o = y * h + x;
        w2[o] = w[i0] + w[i1] + w[i2] + w[i3];
        const o3 = o * 3, a0 = i0 * 3, a1 = i1 * 3, a2 = i2 * 3, a3 = i3 * 3;
        c2[o3] = c[a0] + c[a1] + c[a2] + c[a3];
        c2[o3 + 1] = c[a0 + 1] + c[a1 + 1] + c[a2 + 1] + c[a3 + 1];
        c2[o3 + 2] = c[a0 + 2] + c[a1 + 2] + c[a2 + 2] + c[a3 + 2];
      }
    }
    c = c2; w = w2; s = h;
    levels.push({ c, w, n: s });
  }
  // push: normalized color per level, falling back to the coarser level where empty
  const top = levels[levels.length - 1];
  const tw = Math.max(top.w[0], 1e-6);
  let up = Float32Array.from([top.c[0] / tw, top.c[1] / tw, top.c[2] / tw]);
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], N = L.n, out = new Float32Array(N * N * 3);
    const pn = N >> 1;
    for (let y = 0; y < N; y++) {
      const prow = Math.min(pn - 1, y >> 1) * pn;
      for (let x = 0; x < N; x++) {
        const i = y * N + x, p = (prow + Math.min(pn - 1, x >> 1)) * 3, i3 = i * 3;
        const wv = L.w[i];
        if (wv >= 1) { out[i3] = L.c[i3] / wv; out[i3 + 1] = L.c[i3 + 1] / wv; out[i3 + 2] = L.c[i3 + 2] / wv; }
        else if (wv > 1e-6) {
          const k = 1 - wv; // own normalized color weighted by coverage, rest from above
          out[i3] = L.c[i3] + up[p] * k; out[i3 + 1] = L.c[i3 + 1] + up[p + 1] * k; out[i3 + 2] = L.c[i3 + 2] + up[p + 2] * k;
        } else { out[i3] = up[p]; out[i3 + 1] = up[p + 1]; out[i3 + 2] = up[p + 2]; }
      }
    }
    up = out;
  }
  for (let i = 0; i < n * n; i++) {
    const a = px[i * 4 + 3];
    if (a < 250) {
      const k = a / 255, i3 = i * 3;
      px[i * 4] = px[i * 4] * k + up[i3] * (1 - k);
      px[i * 4 + 1] = px[i * 4 + 1] * k + up[i3 + 1] * (1 - k);
      px[i * 4 + 2] = px[i * 4 + 2] * k + up[i3 + 2] * (1 - k);
    }
  }
}

export interface FoliageTextures {
  leaf: THREE.DataArrayTexture;
  bark: { value: THREE.Texture };
  /** mean bark color per layer (linear), to normalize photo detail around 1 */
  barkMean: THREE.Vector3[];
  paintMs: number;
  dispose(): void;
}

let shared: FoliageTextures | null = null;
let users = 0;

/** Paint (once) and return the foliage atlas + bark array. Shared across world views. */
export function foliageTextures(): FoliageTextures {
  users++;
  if (shared) return shared;
  const t0 = performance.now();
  const N = LEAF_RES;
  const data = new Uint8Array(N * N * 4 * PAGES);
  const cv = new OffscreenCanvas(N, N);
  const ctx = cv.getContext("2d", { willReadFrequently: false })!;
  for (let p = 0; p < PAGES; p++) {
    ctx.clearRect(0, 0, N, N);
    for (const [name, c] of Object.entries(CELL) as [CellName, Cell][]) {
      if (c.page !== p) continue;
      const x = c.x0 * N, y = c.y0 * N, w = (c.x1 - c.x0) * N, h = (c.y1 - c.y0) * N;
      ctx.save();
      ctx.beginPath(); ctx.rect(x + 1, y + 1, w - 2, h - 2); ctx.clip();
      PAINTERS[name](ctx, x, y, w, h, rng(0x5eed + name.length * 977 + Math.round(c.x0 * 13 + c.y0 * 29)));
      ctx.restore();
    }
    const img = ctx.getImageData(0, 0, N, N).data;
    dilate(img, N);
    data.set(img, p * N * N * 4);
  }
  const leaf = new THREE.DataArrayTexture(data, N, N, PAGES);
  leaf.format = THREE.RGBAFormat;
  leaf.type = THREE.UnsignedByteType;
  leaf.colorSpace = THREE.SRGBColorSpace;
  leaf.wrapS = leaf.wrapT = THREE.ClampToEdgeWrapping;
  leaf.magFilter = THREE.LinearFilter;
  leaf.minFilter = THREE.LinearMipmapLinearFilter;
  leaf.generateMipmaps = true;
  leaf.anisotropy = 4;
  leaf.needsUpdate = true;
  const paintMs = performance.now() - t0;

  const arr = loadTextureArray(BARK_FILES.map((f) => texUrl(`${f}/${f}_diff_512.jpg`)), 512, { srgb: true, fallback: BARK_FALLBACK, anisotropy: 4 });
  const bark = { value: arr.texture as THREE.Texture };
  const barkMean = arr.mean.map(() => new THREE.Vector3());
  const syncMean = () => arr.mean.forEach((m, i) => {
    const c = new THREE.Color().setRGB(m.x, m.y, m.z, THREE.SRGBColorSpace); // stored sRGB -> linear
    barkMean[i].set(Math.max(0.02, c.r), Math.max(0.02, c.g), Math.max(0.02, c.b));
  });
  syncMean();
  arr.ready.then(() => { bark.value = arr.texture; syncMean(); });
  shared = {
    leaf, bark, barkMean, paintMs,
    dispose() {
      if (--users > 0) return;
      leaf.dispose();
      arr.texture.dispose();
      shared = null;
    },
  };
  return shared;
}

/** Debug: the painted pages as a data URL (tools). */
export function atlasPreview(page: number): string {
  const t = foliageTextures();
  const N = LEAF_RES;
  const cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  img.data.set((t.leaf.image.data as Uint8Array).subarray(page * N * N * 4, (page + 1) * N * N * 4));
  ctx.putImageData(img, 0, 0);
  users--;
  return cv.toDataURL();
}
