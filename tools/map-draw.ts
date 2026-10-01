// Rendering helpers for the 2D map tool: the rasterized base image
// (biome x hillshade x contours, sea by depth, fresh water, paths, holes),
// a cached props layer, and vector overlays drawn in screen space.
// Display-only code: Math.sin/cos etc. are fine here.
import {
  Biome, CELL, GRID_RES, Material, NO_WATER, PickupKind, PropKind, PROP_STRIDE, VehicleKind, WORLD_HALF,
  type Structure, type World,
} from "../shared/world/types";

// ---------------------------------------------------------------- colors ---
export type RGB = [number, number, number];
export const rgb = (hex: number): RGB => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
export const css = (hex: number, a = 1) => {
  const [r, g, b] = rgb(hex);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
};

export const BIOME_INFO: { biome: Biome; name: string; color: number }[] = [
  { biome: Biome.DeepOcean, name: "Deep ocean", color: 0x145d96 },
  { biome: Biome.Shallows, name: "Shallows", color: 0x4fd6d0 },
  { biome: Biome.Beach, name: "Beach", color: 0xf3dcaa },
  { biome: Biome.PalmGrove, name: "Palm grove", color: 0x9cc65a },
  { biome: Biome.Jungle, name: "Jungle", color: 0x4f9a3a },
  { biome: Biome.Mangrove, name: "Mangrove", color: 0x6b8f4e },
  { biome: Biome.Meadow, name: "Meadow", color: 0xb3cf6e },
  { biome: Biome.Scrub, name: "Scrub", color: 0xb0a861 },
  { biome: Biome.Rock, name: "Rock", color: 0xb0a393 },
  { biome: Biome.Cliff, name: "Cliff", color: 0x9a8574 },
  { biome: Biome.Riverbank, name: "Riverbank", color: 0x86b95c },
  { biome: Biome.Village, name: "Village", color: 0xdcbf94 },
  { biome: Biome.Forest, name: "Forest", color: 0x5e7a3a },
];
const BIOME_RGB: RGB[] = [];
for (const b of BIOME_INFO) BIOME_RGB[b.biome] = rgb(b.color);
export const biomeName = (b: number) => BIOME_INFO.find((x) => x.biome === b)?.name ?? `#${b}`;

const C_SHALLOW = rgb(0x5fdcd2);
const C_SEA = rgb(0x1d8fc4);
const C_DEEP = rgb(0x123f73);
const C_FRESH = rgb(0x3f9fdc);
const C_FRESH_DEEP = rgb(0x2a73b8);
const C_DIRT = rgb(0xc49a6c);
const C_HOLE = rgb(0x2a2124);
const C_ELEV = rgb(0xf4eee0);
const VEGETATED = new Set<number>([Biome.PalmGrove, Biome.Jungle, Biome.Mangrove, Biome.Meadow, Biome.Scrub, Biome.Riverbank, Biome.Forest]);

export const MATERIAL_COLOR: Record<Material, number> = {
  [Material.Stucco]: 0xffffff,
  [Material.Stone]: 0xb8ad9c,
  [Material.Brick]: 0xb86a4e,
  [Material.Terracotta]: 0xc8643c,
  [Material.Wood]: 0x9b6b43,
  [Material.WoodDark]: 0x6b4428,
  [Material.Metal]: 0x8a9099,
  [Material.Plaster]: 0xf4efe6,
  [Material.PaintedWood]: 0xd8d0c0,
  [Material.Corrugated]: 0x9aa0a4,
  [Material.Thatch]: 0xc4a868,
  [Material.LavaRock]: 0x4a4644,
  [Material.Rust]: 0x8a4a2a,
  [Material.Glass]: 0x2b3d4a,
  [Material.Railing]: 0xe8e4da,
  [Material.Cloth]: 0xe0d8c8,
  [Material.Sign]: 0x7a3a32,
  [Material.Foliage]: 0x5f8a3c,
  [Material.Lamp]: 0xffd27a,
};

export const PROP_INFO: { kind: PropKind; name: string; color: number; px: number }[] = [
  { kind: PropKind.Palm, name: "Palm", color: 0x2e8a3c, px: 3 },
  { kind: PropKind.PalmLeaning, name: "Palm (leaning)", color: 0x46a043, px: 3 },
  { kind: PropKind.Broadleaf, name: "Broadleaf", color: 0x1b5227, px: 4 },
  { kind: PropKind.UmbrellaPine, name: "Umbrella pine", color: 0x3b6b3a, px: 4 },
  { kind: PropKind.Cypress, name: "Cypress", color: 0x1f3d27, px: 3 },
  { kind: PropKind.Olive, name: "Olive", color: 0x8f9e62, px: 3 },
  { kind: PropKind.Banana, name: "Banana", color: 0x74c43c, px: 2.5 },
  { kind: PropKind.Fern, name: "Fern", color: 0x3f8f4c, px: 1.5 },
  { kind: PropKind.Bush, name: "Bush", color: 0x557f36, px: 2 },
  { kind: PropKind.Bougainvillea, name: "Bougainvillea", color: 0xd8398e, px: 2 },
  { kind: PropKind.Agave, name: "Agave", color: 0x79a89c, px: 2 },
  { kind: PropKind.GrassTuft, name: "Grass tuft", color: 0x9ccb5e, px: 1.2 },
  { kind: PropKind.Flowers, name: "Flowers", color: 0xf6d34c, px: 1.2 },
  { kind: PropKind.RockSmall, name: "Rock (small)", color: 0x8c8378, px: 1.2 },
  { kind: PropKind.RockMedium, name: "Rock (medium)", color: 0x6e655b, px: 2 },
  { kind: PropKind.Boulder, name: "Boulder", color: 0x544b43, px: 3.5 },
  { kind: PropKind.Driftwood, name: "Driftwood", color: 0xc2a57f, px: 2 },
  { kind: PropKind.Reed, name: "Reed", color: 0xaab35f, px: 1.5 },
  { kind: PropKind.Mangrove, name: "Mangrove", color: 0x46663a, px: 3 },
  { kind: PropKind.LemonTree, name: "Lemon tree", color: 0xf2d027, px: 3 },
];
export const propInfo = (k: number) => PROP_INFO.find((p) => p.kind === k) ?? { kind: k, name: `Prop ${k}`, color: 0xff00ff, px: 2 };

export const PICKUP_INFO: { kind: PickupKind; name: string; letter: string; color: number }[] = [
  { kind: PickupKind.Ammo, name: "Ammo", letter: "", color: 0xffd23f },
  { kind: PickupKind.BigHopper, name: "Big hopper", letter: "H", color: 0xff7a3d },
  { kind: PickupKind.RapidFire, name: "Rapid fire", letter: "R", color: 0xef3e5c },
  { kind: PickupKind.LongBarrel, name: "Long barrel", letter: "L", color: 0x9b5de5 },
  { kind: PickupKind.Scope, name: "Scope", letter: "S", color: 0x3a86ff },
  { kind: PickupKind.Vest, name: "Vest", letter: "V", color: 0x2ec4b6 },
  { kind: PickupKind.QuickFeet, name: "Quick feet", letter: "Q", color: 0x8ac926 },
  { kind: PickupKind.Snorkel, name: "Snorkel", letter: "K", color: 0x00b4d8 },
];
export const pickupInfo = (k: number) => PICKUP_INFO.find((p) => p.kind === k) ?? PICKUP_INFO[0];
export const VEHICLE_NAMES: Record<VehicleKind, string> = {
  [VehicleKind.Jetski]: "Jetski",
  [VehicleKind.Speedboat]: "Speedboat",
  [VehicleKind.Vespa]: "Vespa",
  [VehicleKind.Gyrocopter]: "Gyrocopter",
};

// ------------------------------------------------------------- sampling ---
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/** Bilinear sample of a GRID_RES² field at world (x, z). */
export function sampleGrid(f: ArrayLike<number>, x: number, z: number): number {
  const gx = Math.min(Math.max((x + WORLD_HALF) / CELL, 0), GRID_RES - 1.0001);
  const gz = Math.min(Math.max((z + WORLD_HALF) / CELL, 0), GRID_RES - 1.0001);
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const i = iz * GRID_RES + ix;
  const a = f[i] + (f[i + 1] - f[i]) * fx;
  const b = f[i + GRID_RES] + (f[i + GRID_RES + 1] - f[i + GRID_RES]) * fx;
  return a + (b - a) * fz;
}
export function nearestIndex(x: number, z: number): number {
  const ix = Math.min(Math.max(Math.round((x + WORLD_HALF) / CELL), 0), GRID_RES - 1);
  const iz = Math.min(Math.max(Math.round((z + WORLD_HALF) / CELL), 0), GRID_RES - 1);
  return iz * GRID_RES + ix;
}

// ------------------------------------------------------------ base image ---
/** True when no land cell carries a land biome (generator hasn't filled the biome grid yet). */
export function biomeMissing(world: World): boolean {
  const { height: H, biome: B } = world;
  for (let i = 0; i < H.length; i++) if (H[i] > 0.5 && B[i] > Biome.Shallows) return false;
  return true;
}
function fallbackBiome(h: number, slope: number): Biome {
  if (slope > 1.1) return Biome.Cliff;
  if (h < 2.5) return Biome.Beach;
  if (h < 30) return Biome.Jungle;
  if (h < 65) return Biome.Meadow;
  if (h < 100) return Biome.Scrub;
  return Biome.Rock;
}
export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Rasterize the terrain into an N×N canvas covering the whole world
 * (+X right, +Z down, so -Z / "north" is at the top).
 */
export function renderBase(world: World, N: number, opts: { contours?: boolean } = {}): HTMLCanvasElement {
  const R = GRID_RES;
  const n = R * R;
  const { height: H, water: W, biome: B, moisture: M, path: P, holes: HO } = world;

  // Per grid sample: hillshade, pre-shade land color, fresh-water depth.
  const shade = new Float32Array(n);
  const lr = new Float32Array(n), lg = new Float32Array(n), lb = new Float32Array(n);
  const fresh = new Float32Array(n);
  const noBiome = biomeMissing(world);
  const LX = -0.5, LY = 0.7071, LZ = -0.5; // toward the light (NW, 45° up)
  const EX = 1.6; // vertical exaggeration for the shading
  for (let iz = 0; iz < R; iz++) {
    const zm = Math.max(iz - 1, 0), zp = Math.min(iz + 1, R - 1);
    for (let ix = 0; ix < R; ix++) {
      const i = iz * R + ix;
      const xm = Math.max(ix - 1, 0), xp = Math.min(ix + 1, R - 1);
      const dx = ((H[iz * R + xp] - H[iz * R + xm]) / ((xp - xm) * CELL)) * EX;
      const dz = ((H[zp * R + ix] - H[zm * R + ix]) / ((zp - zm) * CELL)) * EX;
      const len = Math.sqrt(dx * dx + 1 + dz * dz);
      const d = (-dx * LX + LY - dz * LZ) / len;
      shade[i] = 0.3 + 0.7 * Math.max(d, 0) / LY;

      const h = H[i];
      const bi = noBiome ? fallbackBiome(h, Math.sqrt(dx * dx + dz * dz) / EX) : B[i];
      const c = BIOME_RGB[bi] ?? BIOME_RGB[Biome.Rock];
      let r = c[0], g = c[1], b = c[2];
      if (VEGETATED.has(bi)) {
        const m = M[i] / 255 - 0.5;
        r *= 1 - 0.22 * m;
        g *= 1 + 0.04 * m;
        b *= 1 - 0.18 * m;
      }
      const e = clamp01(h / 140) * 0.22;
      r += (C_ELEV[0] - r) * e;
      g += (C_ELEV[1] - g) * e;
      b += (C_ELEV[2] - b) * e;
      const p = (P[i] / 255) * 0.85;
      r += (C_DIRT[0] - r) * p;
      g += (C_DIRT[1] - g) * p;
      b += (C_DIRT[2] - b) * p;
      lr[i] = r;
      lg[i] = g;
      lb[i] = b;
      const w = W[i];
      fresh[i] = w === NO_WATER || w < -500 ? -0.75 : w - h;
    }
  }

  const img = new ImageData(N, N);
  const px = img.data;
  const hp = new Float32Array(N * N);
  const isLand = new Uint8Array(N * N);
  const k = (R - 1) / N;
  for (let y = 0; y < N; y++) {
    let gz = (y + 0.5) * k;
    if (gz > R - 1.0001) gz = R - 1.0001;
    const iz = Math.floor(gz), fz = gz - iz;
    for (let x = 0; x < N; x++) {
      let gx = (x + 0.5) * k;
      if (gx > R - 1.0001) gx = R - 1.0001;
      const ix = Math.floor(gx), fx = gx - ix;
      const i00 = iz * R + ix, i10 = i00 + 1, i01 = i00 + R, i11 = i01 + 1;
      const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
      const h = H[i00] * w00 + H[i10] * w10 + H[i01] * w01 + H[i11] * w11;
      const s = shade[i00] * w00 + shade[i10] * w10 + shade[i01] * w01 + shade[i11] * w11;
      const fw = fresh[i00] * w00 + fresh[i10] * w10 + fresh[i01] * w01 + fresh[i11] * w11;
      const o = (y * N + x) * 4;
      const pi = y * N + x;
      hp[pi] = h;
      let r: number, g: number, b: number;
      const ni = (fz < 0.5 ? iz : iz + 1) * R + (fx < 0.5 ? ix : ix + 1);
      if (HO[ni]) {
        [r, g, b] = C_HOLE;
      } else if (fw > 0.05) {
        const t = smooth(fw / 4);
        r = C_FRESH[0] + (C_FRESH_DEEP[0] - C_FRESH[0]) * t;
        g = C_FRESH[1] + (C_FRESH_DEEP[1] - C_FRESH[1]) * t;
        b = C_FRESH[2] + (C_FRESH_DEEP[2] - C_FRESH[2]) * t;
        const edge = 1 - smooth(fw / 0.5);
        r += (235 - r) * edge * 0.45;
        g += (250 - g) * edge * 0.45;
        b += (255 - b) * edge * 0.45;
      } else if (h < 0) {
        const d = -h;
        const t1 = smooth(d / 6);
        const t2 = smooth((d - 6) / 38);
        r = C_SHALLOW[0] + (C_SEA[0] - C_SHALLOW[0]) * t1;
        g = C_SHALLOW[1] + (C_SEA[1] - C_SHALLOW[1]) * t1;
        b = C_SHALLOW[2] + (C_SEA[2] - C_SHALLOW[2]) * t1;
        r += (C_DEEP[0] - r) * t2;
        g += (C_DEEP[1] - g) * t2;
        b += (C_DEEP[2] - b) * t2;
        const sm = 0.9 + 0.1 * s;
        r *= sm;
        g *= sm;
        b *= sm;
        // foam line hugging the shore, plus a soft light band
        const foam = clamp01(1 - Math.abs(d - 0.35) / 0.3);
        const band = clamp01(1 - d / 1.6) * 0.35;
        const f = Math.max(foam * 0.9, band);
        r += (255 - r) * f;
        g += (255 - g) * f;
        b += (250 - b) * f;
      } else {
        r = (lr[i00] * w00 + lr[i10] * w10 + lr[i01] * w01 + lr[i11] * w11) * s;
        g = (lg[i00] * w00 + lg[i10] * w10 + lg[i01] * w01 + lg[i11] * w11) * s;
        b = (lb[i00] * w00 + lb[i10] * w10 + lb[i01] * w01 + lb[i11] * w11) * s;
        isLand[pi] = 1;
      }
      px[o] = r > 255 ? 255 : r;
      px[o + 1] = g > 255 ? 255 : g;
      px[o + 2] = b > 255 ? 255 : b;
      px[o + 3] = 255;
    }
  }

  if (opts.contours !== false) {
    for (let y = 0; y < N - 1; y++) {
      for (let x = 0; x < N - 1; x++) {
        const pi = y * N + x;
        if (!isLand[pi]) continue;
        const h = hp[pi];
        const hr = hp[pi + 1], hd = hp[pi + N];
        const l = Math.floor(h / 10);
        let f = 1;
        if (Math.floor(h / 50) !== Math.floor(hr / 50) || Math.floor(h / 50) !== Math.floor(hd / 50)) f = 0.55;
        else if (l !== Math.floor(hr / 10) || l !== Math.floor(hd / 10)) f = 0.78;
        if (f < 1) {
          const o = pi * 4;
          px[o] *= f;
          px[o + 1] *= f;
          px[o + 2] *= f * 0.97;
        }
      }
    }
  }

  const c = makeCanvas(N, N);
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}

/** Props as colored dots on an N×N transparent canvas. */
export function renderProps(world: World, N: number, visible: (k: PropKind) => boolean): HTMLCanvasElement {
  const c = makeCanvas(N, N);
  const ctx = c.getContext("2d")!;
  const s = N / (2 * WORLD_HALF);
  // Draw small things first so trees sit on top.
  const sets = [...world.props].sort((a, b) => propInfo(a.kind).px - propInfo(b.kind).px);
  for (const set of sets) {
    if (!visible(set.kind)) continue;
    const info = propInfo(set.kind);
    ctx.fillStyle = css(info.color);
    const d = set.data;
    const base = info.px * (N / 2052);
    for (let i = 0; i < set.count; i++) {
      const o = i * PROP_STRIDE;
      const sz = Math.max(1, base * Math.sqrt(Math.max(d[o + 4], 0.3)));
      ctx.fillRect((d[o] + WORLD_HALF) * s - sz / 2, (d[o + 2] + WORLD_HALF) * s - sz / 2, sz, sz);
    }
  }
  return c;
}

// -------------------------------------------------------------- overlays ---
/** Maps world XZ to CSS pixels. scale = CSS px per meter. */
export interface View {
  scale: number;
  ox: number;
  oy: number;
}
export const sx = (v: View, x: number) => v.ox + (x + WORLD_HALF) * v.scale;
export const sy = (v: View, z: number) => v.oy + (z + WORLD_HALF) * v.scale;

const FONT = `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, font: string, halo = "rgba(255,255,255,0.85)", hw = 3) {
  ctx.font = font;
  ctx.lineJoin = "round";
  ctx.strokeStyle = halo;
  ctx.lineWidth = hw;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

export function drawRivers(ctx: CanvasRenderingContext2D, w: World, v: View, minPx = 1.5) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const pass of [0, 1]) {
    for (const r of w.rivers) {
      const pts = r.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const width = ((a.width + b.width) / 2) * v.scale;
        ctx.beginPath();
        ctx.moveTo(sx(v, a.x), sy(v, a.z));
        ctx.lineTo(sx(v, b.x), sy(v, b.z));
        if (pass === 0) {
          ctx.strokeStyle = "rgba(20,70,120,0.55)";
          ctx.lineWidth = Math.max(minPx, width) + 1.5;
        } else {
          ctx.strokeStyle = "#48aee6";
          ctx.lineWidth = Math.max(minPx, width);
        }
        ctx.stroke();
      }
    }
  }
}

export function drawLakes(ctx: CanvasRenderingContext2D, w: World, v: View) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  w.lakes.forEach((l, i) => {
    const x = sx(v, l.x), y = sy(v, l.z);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#e9f7ff";
    ctx.fill();
    ctx.strokeStyle = "#1f5f96";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    haloText(ctx, `lake ${i + 1} · ${l.level.toFixed(1)} m`, x, y + 11, "#16507f", `italic 600 10.5px ${FONT}`, "rgba(235,248,255,0.85)");
  });
}

export function drawWaterfalls(ctx: CanvasRenderingContext2D, w: World, v: View) {
  for (const f of w.waterfalls) {
    const x = sx(v, f.x), y = sy(v, f.z);
    const dx = Math.sin(f.dir), dy = Math.cos(f.dir);
    const s = 6;
    ctx.save();
    ctx.translate(x, y);
    ctx.transform(dy, -dx, dx, dy, 0, 0); // local +y -> screen (dx, dy)
    ctx.beginPath();
    for (const off of [-3.5, 1.5]) {
      ctx.moveTo(-s, off - s * 0.6);
      ctx.lineTo(0, off + s * 0.4);
      ctx.lineTo(s, off - s * 0.6);
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(15,50,90,0.8)";
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();
    if (v.scale > 1.6) {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      haloText(ctx, `${(f.top - f.bottom).toFixed(0)} m`, x + 10, y, "#14476f", `600 10px ${FONT}`);
    }
  }
}

export function drawCaves(ctx: CanvasRenderingContext2D, w: World, v: View, entrancesOnly = false) {
  for (const c of w.caves) {
    if (!entrancesOnly) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "rgba(40,22,52,0.9)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (const [a, b] of c.edges) {
        const na = c.nodes[a], nb = c.nodes[b];
        if (!na || !nb) continue;
        ctx.moveTo(sx(v, na.x), sy(v, na.z));
        ctx.lineTo(sx(v, nb.x), sy(v, nb.z));
      }
      ctx.stroke();
      ctx.restore();
      for (const n of c.nodes) {
        ctx.beginPath();
        ctx.arc(sx(v, n.x), sy(v, n.z), Math.max(2.5, n.r * v.scale), 0, Math.PI * 2);
        ctx.fillStyle = "rgba(70,40,90,0.28)";
        ctx.fill();
        ctx.strokeStyle = "rgba(55,28,70,0.85)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    for (const e of c.entrances) {
      const x = sx(v, e.x), y = sy(v, e.z);
      const len = Math.hypot(e.dx, e.dz) || 1;
      const dx = e.dx / len, dy = e.dz / len;
      const s = entrancesOnly ? 4.5 : 6.5;
      ctx.beginPath();
      ctx.moveTo(x + dx * s * 1.3, y + dy * s * 1.3);
      ctx.lineTo(x - dx * s * 0.7 - dy * s * 0.9, y - dy * s * 0.7 + dx * s * 0.9);
      ctx.lineTo(x - dx * s * 0.7 + dy * s * 0.9, y - dy * s * 0.7 - dx * s * 0.9);
      ctx.closePath();
      ctx.fillStyle = "#ff8f3d";
      ctx.fill();
      ctx.strokeStyle = "#2b1633";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }
}

function mulTint(hex: number, tint: number): string {
  const a = rgb(hex), t = rgb(tint);
  return `rgb(${Math.round((a[0] * t[0]) / 255)},${Math.round((a[1] * t[1]) / 255)},${Math.round((a[2] * t[2]) / 255)})`;
}

export function drawStructures(ctx: CanvasRenderingContext2D, structs: Structure[], v: View, compact = false) {
  const solids = structs.flatMap((s) => s.solids).sort((a, b) => a.cy + a.hy - (b.cy + b.hy));
  ctx.lineJoin = "round";
  for (const s of solids) {
    const cx = sx(v, s.cx), cy = sy(v, s.cz);
    ctx.fillStyle = mulTint(MATERIAL_COLOR[s.mat] ?? 0xcccccc, s.tint ?? 0xffffff);
    ctx.strokeStyle = compact ? "rgba(40,30,25,0.8)" : "rgba(40,30,25,0.75)";
    ctx.lineWidth = compact ? 0.6 : 0.9;
    ctx.beginPath();
    if (s.shape === "cylinder") {
      ctx.arc(cx, cy, Math.max(0.8, s.hx * v.scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      continue;
    }
    const c = Math.cos(s.rotY), n = Math.sin(s.rotY);
    const hx = Math.max(s.hx * v.scale, 0.5), hz = Math.max(s.hz * v.scale, 0.5);
    const pt = (lx: number, lz: number): [number, number] => [cx + lx * c + lz * n, cy - lx * n + lz * c];
    const corners = [pt(-hx, -hz), pt(hx, -hz), pt(hx, hz), pt(-hx, hz)];
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (s.shape === "wedge" && !compact) {
      const a = pt(-hx, 0), b = pt(hx, 0);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = "rgba(60,25,15,0.8)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

export function drawPaths(ctx: CanvasRenderingContext2D, w: World, v: View, compact = false) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of w.paths) {
    if (p.points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(sx(v, p.points[0].x), sy(v, p.points[0].z));
    for (let i = 1; i < p.points.length; i++) ctx.lineTo(sx(v, p.points[i].x), sy(v, p.points[i].z));
    if (!compact) {
      ctx.strokeStyle = "rgba(120,80,45,0.35)";
      ctx.lineWidth = Math.max(2, p.width * v.scale);
      ctx.stroke();
      ctx.setLineDash([4, 3]);
    }
    ctx.strokeStyle = compact ? "rgba(110,70,40,0.9)" : "rgba(95,58,30,0.95)";
    ctx.lineWidth = compact ? 0.9 : 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function drawPickups(ctx: CanvasRenderingContext2D, w: World, v: View) {
  for (const p of w.pickups) {
    if (p.kind !== PickupKind.Ammo) continue;
    ctx.beginPath();
    ctx.arc(sx(v, p.x), sy(v, p.z), 2.4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd23f";
    ctx.fill();
    ctx.strokeStyle = "rgba(80,50,0,0.9)";
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const p of w.pickups) {
    if (p.kind === PickupKind.Ammo) continue;
    const info = pickupInfo(p.kind);
    const x = sx(v, p.x), y = sy(v, p.z), s = 7;
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fillStyle = css(info.color);
    ctx.fill();
    ctx.strokeStyle = "#1a1a22";
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.font = `800 8.5px ${FONT}`;
    ctx.fillStyle = "#fff";
    ctx.fillText(info.letter, x, y + 0.5);
  }
}

export function drawVehicles(ctx: CanvasRenderingContext2D, w: World, v: View) {
  for (const veh of w.vehicles) {
    ctx.save();
    ctx.translate(sx(v, veh.x), sy(v, veh.z));
    const c = Math.cos(veh.rotY), n = Math.sin(veh.rotY);
    ctx.transform(c, -n, n, c, 0, 0); // local (lx, lz) -> world rotation; local +lz = forward
    const k = Math.max(1, Math.min(2.2, v.scale * 0.9));
    ctx.scale(k, k);
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.2 / k;
    ctx.strokeStyle = "#1c1410";
    ctx.beginPath();
    if (veh.kind === VehicleKind.Jetski) {
      ctx.moveTo(0, 6);
      ctx.quadraticCurveTo(2.8, 2, 2.4, -4.5);
      ctx.lineTo(-2.4, -4.5);
      ctx.quadraticCurveTo(-2.8, 2, 0, 6);
      ctx.fillStyle = "#9fd8c8";
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(-1, -3.5, 2, 4, 1);
      ctx.fillStyle = "#fff0d2";
      ctx.fill();
    } else if (veh.kind === VehicleKind.Speedboat) {
      ctx.moveTo(0, 10);
      ctx.quadraticCurveTo(4, 4, 3.4, -8);
      ctx.lineTo(-3.4, -8);
      ctx.quadraticCurveTo(-4, 4, 0, 10);
      ctx.fillStyle = "#a4552f";
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.rect(-2.4, -1, 4.8, 3);
      ctx.rect(-2.4, -5.5, 4.8, 3);
      ctx.fillStyle = "#fff4dc";
      ctx.fill();
    } else if (veh.kind === VehicleKind.Gyrocopter) {
      ctx.ellipse(0, 1, 2.6, 4.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#f7d77a";
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-9, -2);
      ctx.lineTo(9, 2);
      ctx.moveTo(0, -3);
      ctx.lineTo(0, -9);
      ctx.moveTo(-3, -9);
      ctx.lineTo(3, -9);
      ctx.lineWidth = 1.8 / k;
      ctx.strokeStyle = "#e0644f";
      ctx.stroke();
    } else {
      ctx.roundRect(-2.2, -4.5, 4.4, 9, 2.2);
      ctx.fillStyle = "#7fd1c7";
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-3.5, 3.5);
      ctx.lineTo(3.5, 3.5);
      ctx.lineWidth = 1.6 / k;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 5.5, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = "#fff6c8";
      ctx.fill();
    }
    ctx.restore();
  }
}

export function drawZiplines(ctx: CanvasRenderingContext2D, w: World, v: View) {
  for (const z of w.ziplines) {
    const ax = sx(v, z.ax), ay = sy(v, z.az), bx = sx(v, z.bx), by = sy(v, z.bz);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = "rgba(20,20,30,0.75)";
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.strokeStyle = "#ffe066";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    for (const [x, y, hi] of [[ax, ay, z.ay >= z.by], [bx, by, z.by > z.ay]] as const) {
      ctx.beginPath();
      if (hi) ctx.arc(x, y, 3.8, 0, Math.PI * 2);
      else ctx.rect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = hi ? "#ffe066" : "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#1c1c26";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    const drop = Math.abs(z.ay - z.by);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    haloText(ctx, `↓${drop.toFixed(0)} m`, (ax + bx) / 2, (ay + by) / 2 - 8, "#3a2e00", `700 10px ${FONT}`, "rgba(255,250,215,0.9)");
  }
}

export function drawSpawns(ctx: CanvasRenderingContext2D, w: World, v: View) {
  for (const s of w.spawns) {
    ctx.beginPath();
    ctx.arc(sx(v, s.x), sy(v, s.z), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#1b1b24";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

const LANDMARK_STYLE: Record<string, { color: string; font: string; halo: string; prefix?: string; upper?: boolean }> = {
  peak: { color: "#3b2414", font: `800 12.5px ${FONT}`, halo: "rgba(255,248,235,0.9)", prefix: "▲ " },
  village: { color: "#5a2618", font: `800 12px ${FONT}`, halo: "rgba(255,244,228,0.92)", upper: true },
  ruin: { color: "#5b3d2a", font: `italic 700 11.5px ${FONT}`, halo: "rgba(255,244,228,0.9)" },
  bay: { color: "#0b3e66", font: `italic 700 13px ${FONT}`, halo: "rgba(220,244,255,0.75)" },
  cove: { color: "#0b3e66", font: `italic 600 11.5px ${FONT}`, halo: "rgba(220,244,255,0.75)" },
  point: { color: "#0b3e66", font: `italic 600 11.5px ${FONT}`, halo: "rgba(220,244,255,0.75)" },
  beach: { color: "#7a4a12", font: `italic 600 11.5px ${FONT}`, halo: "rgba(255,248,225,0.9)" },
  lake: { color: "#14507f", font: `italic 700 11.5px ${FONT}`, halo: "rgba(230,246,255,0.9)" },
  falls: { color: "#14507f", font: `italic 700 11px ${FONT}`, halo: "rgba(230,246,255,0.9)" },
  cave: { color: "#3c1f4d", font: `700 11px ${FONT}`, halo: "rgba(245,235,255,0.9)", prefix: "◗ " },
};

const LABEL_PRIORITY: Record<string, number> = { village: 0, peak: 1, bay: 2, lake: 3, ruin: 4, cave: 5, point: 6, falls: 7, cove: 8, beach: 9 };

/** Draws landmark labels, nudging each to the first free slot around its anchor (greedy, by priority). */
export function drawLandmarks(ctx: CanvasRenderingContext2D, w: World, v: View) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const order = w.landmarks.slice().sort((a, b) => (LABEL_PRIORITY[a.kind] ?? 9) - (LABEL_PRIORITY[b.kind] ?? 9));
  const offsets = [[0, 0], [0, -14], [0, 14], [0, -26], [0, 26], [-40, 0], [40, 0], [-40, -14], [40, 14], [-40, 14], [40, -14]];
  for (const l of order) {
    const st = LANDMARK_STYLE[l.kind] ?? LANDMARK_STYLE.ruin;
    const text = (st.prefix ?? "") + (st.upper ? l.name.toUpperCase() : l.name);
    ctx.font = st.font;
    const tw = ctx.measureText(text).width + 6, th = 15;
    const ax = sx(v, l.x), ay = sy(v, l.z);
    let chosen: number[] | null = null;
    for (const [ox, oy] of offsets) {
      const x0 = ax + ox - tw / 2, y0 = ay + oy - th / 2;
      const box = { x0, y0, x1: x0 + tw, y1: y0 + th };
      if (!placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) {
        chosen = [ox, oy];
        placed.push(box);
        break;
      }
    }
    if (!chosen) continue; // too crowded at this zoom: skip the least important labels
    if (chosen[0] !== 0 || chosen[1] !== 0) {
      // leader dot at the true anchor
      ctx.beginPath();
      ctx.arc(ax, ay, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = st.color;
      ctx.fill();
    }
    haloText(ctx, text, ax + chosen[0], ay + chosen[1], st.color, st.font, st.halo, 3.5);
  }
}
