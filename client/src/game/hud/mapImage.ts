// A painted poster-style map of the island (for the minimap and the big map):
// biome colors, hill shading, soft contour lines, rivers, paths and ruins.
import { Biome, GRID_RES, NO_WATER, WORLD_HALF, WORLD_SIZE, type World } from "../../../../shared/world/types";

const BIOME_RGB: Record<number, [number, number, number]> = {
  [Biome.DeepOcean]: [58, 150, 190],
  [Biome.Shallows]: [104, 205, 204],
  [Biome.Beach]: [246, 226, 178],
  [Biome.PalmGrove]: [170, 204, 110],
  [Biome.Jungle]: [84, 146, 72],
  [Biome.Forest]: [112, 136, 78],
  [Biome.Mangrove]: [118, 150, 96],
  [Biome.Meadow]: [186, 210, 122],
  [Biome.Scrub]: [196, 184, 120],
  [Biome.Rock]: [196, 182, 164],
  [Biome.Cliff]: [170, 150, 132],
  [Biome.Riverbank]: [150, 196, 118],
  [Biome.Village]: [232, 206, 160],
};

/** Map pixel size of the returned canvas. 1 px ≈ WORLD_SIZE / size meters. */
export function renderMapImage(world: World, size = 1024): HTMLCanvasElement {
  const N = GRID_RES;
  const src = document.createElement("canvas");
  src.width = N;
  src.height = N;
  const ctx = src.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  const h = world.height, wtr = world.water, bio = world.biome, path = world.path;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const y = h[i];
      let r: number, g: number, b: number;
      const fresh = wtr[i] !== NO_WATER && wtr[i] > y;
      if (y < 0 || fresh) {
        const depth = fresh ? wtr[i] - y : -y;
        const k = Math.min(1, depth / 14);
        r = 120 - 70 * k; g = 214 - 70 * k; b = 214 - 30 * k;
        if (fresh) { r = 104; g = 200; b = 214; }
        // shallow foam line
        if (!fresh && y > -0.6) { r = 196; g = 238; b = 232; }
      } else {
        const c = BIOME_RGB[bio[i]] ?? [180, 200, 120];
        r = c[0]; g = c[1]; b = c[2];
        // hill shade (light from the north-west)
        const hx = h[i + (ix < N - 1 ? 1 : 0)] - h[i - (ix > 0 ? 1 : 0)];
        const hz = h[i + (iz < N - 1 ? N : 0)] - h[i - (iz > 0 ? N : 0)];
        const shade = Math.max(-0.35, Math.min(0.3, (-hx - hz) * 0.06));
        r *= 1 + shade; g *= 1 + shade; b *= 1 + shade;
        // altitude tint: higher = paler
        const alt = Math.min(1, y / 120);
        r += (250 - r) * alt * 0.25; g += (240 - g) * alt * 0.25; b += (220 - b) * alt * 0.25;
        // contour every 12 m
        const c0 = Math.floor(y / 12), c1 = Math.floor(h[i + (ix < N - 1 ? 1 : 0)] / 12), c2 = Math.floor(h[i + (iz < N - 1 ? N : 0)] / 12);
        if (c0 !== c1 || c0 !== c2) { r *= 0.86; g *= 0.86; b *= 0.84; }
        const pv = path[i] / 255;
        if (pv > 0.2) { r += (226 - r) * pv * 0.8; g += (196 - g) * pv * 0.8; b += (140 - b) * pv * 0.8; }
      }
      const o = i * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const c = out.getContext("2d")!;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(src, 0, 0, size, size);
  const k = size / WORLD_SIZE;
  const X = (x: number) => (x + WORLD_HALF) * k;
  // rivers
  c.lineCap = "round";
  c.lineJoin = "round";
  for (const rv of world.rivers) {
    c.strokeStyle = "rgba(90, 190, 214, 0.95)";
    for (let i = 1; i < rv.points.length; i++) {
      const a = rv.points[i - 1], b = rv.points[i];
      c.lineWidth = Math.max(1.5, b.width * k);
      c.beginPath();
      c.moveTo(X(a.x), X(a.z));
      c.lineTo(X(b.x), X(b.z));
      c.stroke();
    }
  }
  // paths (dashed)
  c.setLineDash([4 * k * 2, 3 * k * 2]);
  c.strokeStyle = "rgba(160, 110, 60, 0.55)";
  c.lineWidth = Math.max(1, 1.2 * k * 2);
  for (const p of world.paths) {
    c.beginPath();
    p.points.forEach((q, i) => (i ? c.lineTo(X(q.x), X(q.z)) : c.moveTo(X(q.x), X(q.z))));
    c.stroke();
  }
  c.setLineDash([]);
  // structures: little terracotta roofs
  for (const s of world.structures) {
    c.fillStyle = "#c8643c";
    c.strokeStyle = "#23374b";
    c.lineWidth = 1.5;
    for (const so of s.solids) {
      if (so.hy < 0.3) continue;
      c.save();
      c.translate(X(so.cx), X(so.cz));
      c.rotate(-so.rotY);
      const w = Math.max(2, so.hx * 2 * k), d = Math.max(2, (so.shape === "cylinder" ? so.hx : so.hz) * 2 * k);
      c.globalAlpha = 0.85;
      c.fillRect(-w / 2, -d / 2, w, d);
      c.restore();
    }
  }
  return out;
}
