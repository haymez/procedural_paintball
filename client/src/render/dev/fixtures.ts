// Synthetic world features for developing the renderer before the real
// generator lands: a lake + river with a waterfall and a gorge, a cave with a
// hillside mouth, a hamlet, lighthouse, chapel, dock, arch, bridge, dirt paths,
// biome/moisture refinement and scattered props. Mutates the world in place.
// Not deterministic across engines and never used by the game.
import {
  Biome, CELL, GRID_RES, Material, NO_WATER, PropKind, PROP_STRIDE, StructureKind, WORLD_HALF,
  type Cave, type PropSet, type River, type Solid, type Structure, type World,
} from "../../../../shared/world/types";
import { PALETTE } from "../style";

const N = GRID_RES;
const gx = (x: number) => (x + WORLD_HALF) / CELL;
const wx = (i: number) => -WORLD_HALF + i * CELL;

function mulberry(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(seed: number) {
  const r = mulberry(seed);
  const P = 256;
  const g = new Float32Array(P * P);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const i0 = ((xi % P) + P) % P, j0 = ((yi % P) + P) % P, i1 = (i0 + 1) % P, j1 = (j0 + 1) % P;
    const a = g[j0 * P + i0], b = g[j0 * P + i1], c = g[j1 * P + i0], d = g[j1 * P + i1];
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  return (x: number, y: number) => at(x, y) * 0.6 + at(x * 2.1, y * 2.1) * 0.3 + at(x * 4.3, y * 4.3) * 0.1;
}

export interface FixtureReport { filled: string[] }

/**
 * mode "full": carve lake/river/waterfall/cave and add everything (stub world).
 * mode "fill": only fill layers the given world is missing (biomes, moisture,
 * structures, paths, props) without touching the terrain.
 */
export function addFixtures(world: World, mode: "full" | "fill" = "full"): FixtureReport {
  const filled: string[] = [];
  const full = mode === "full";
  const rnd = mulberry(world.seed * 7919 + 13);
  const H = world.height;
  const hAt = (x: number, z: number) => {
    const fx = gx(x), fz = gx(z);
    const ix = Math.max(0, Math.min(N - 2, Math.floor(fx))), iz = Math.max(0, Math.min(N - 2, Math.floor(fz)));
    const tx = fx - ix, tz = fz - iz;
    const i = iz * N + ix;
    return H[i] * (1 - tx) * (1 - tz) + H[i + 1] * tx * (1 - tz) + H[i + N] * (1 - tx) * tz + H[i + N + 1] * tx * tz;
  };
  const grad = (x: number, z: number) => [(hAt(x + 2, z) - hAt(x - 2, z)) / 4, (hAt(x, z + 2) - hAt(x, z - 2)) / 4];
  const forCells = (x: number, z: number, r: number, fn: (i: number, x: number, z: number, d: number) => void) => {
    const i0 = Math.max(0, Math.floor(gx(x - r))), i1 = Math.min(N - 1, Math.ceil(gx(x + r)));
    const j0 = Math.max(0, Math.floor(gx(z - r))), j1 = Math.min(N - 1, Math.ceil(gx(z + r)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = wx(i), cz = wx(j);
      const d = Math.hypot(cx - x, cz - z);
      if (d <= r) fn(j * N + i, cx, cz, d);
    }
  };

  if (full) world.name = "Isola di Prova";

  // summit
  let summit = 0;
  for (let i = 0; i < H.length; i++) if (H[i] > H[summit]) summit = i;
  const sx = wx(summit % N), sz = wx(Math.floor(summit / N));

  const distToRiver = (x: number, z: number) => {
    let best = 1e9;
    for (const rv of world.rivers) for (const p of rv.points) best = Math.min(best, Math.hypot(p.x - x, p.z - z) - p.width / 2);
    return best;
  };
  const bestD = new Float32Array(N * N).fill(1e9);
  let ex = 0, ez = 0, lakeX = 1e6, lakeZ = 1e6;
  const lakeR = 20;
  if (full) {
    // ------------------------------------------------------------ lake + river
    const riverAng = rnd() * Math.PI * 2;
    lakeX = sx + Math.cos(riverAng) * 90; lakeZ = sz + Math.sin(riverAng) * 90;
    const lakeLevel = hAt(lakeX, lakeZ) - 1.5;
    forCells(lakeX, lakeZ, lakeR + 16, (i, _x, _z, d) => {
      const bed = d < lakeR ? lakeLevel - 0.4 - 3 * (1 - (d / lakeR) ** 2) : lakeLevel + (d - lakeR) * 0.6;
      H[i] = Math.min(H[i], bed);
    });
    forCells(lakeX, lakeZ, lakeR + 2, (i) => { world.water[i] = lakeLevel; });
    world.lakes.push({ level: lakeLevel, x: lakeX, z: lakeZ });

    // river: meandering descent from the lake to the sea
    const pts: { x: number; z: number }[] = [];
    let px = lakeX + Math.cos(riverAng) * (lakeR - 4), pz = lakeZ + Math.sin(riverAng) * (lakeR - 4);
    let dx = Math.cos(riverAng), dz = Math.sin(riverAng);
    const meander = valueNoise(world.seed + 5);
    for (let step = 0; step < 400; step++) {
      pts.push({ x: px, z: pz });
      if (hAt(px, pz) < -2.5) break;
      const [gX, gZ] = grad(px, pz);
      const gl = Math.hypot(gX, gZ) || 1;
      const m = (meander(step * 0.05, 3.3) - 0.5) * 1.6;
      let ndx = dx * 0.85 - (gX / gl) * 0.15 + -dz * m * 0.12;
      let ndz = dz * 0.85 - (gZ / gl) * 0.15 + dx * m * 0.12;
      const l = Math.hypot(ndx, ndz);
      ndx /= l; ndz /= l;
      dx = ndx; dz = ndz;
      px += dx * 3; pz += dz * 3;
    }
    const river: River = { points: [] };
    const fallAt = Math.floor(pts.length * 0.22);
    let y = lakeLevel;
    let fallTop = 0, fallBottom = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const t = k / (pts.length - 1);
      const width = 3.5 + t * 6;
      const depth = 1.1 + t * 0.8;
      const terr = hAt(p.x, p.z);
      let ny = Math.min(y - (k === 0 ? 0 : 0.03), terr - 0.6);
      if (k === fallAt) { fallTop = y; ny = y - 7.5; fallBottom = ny; }
      ny = Math.max(ny, 0.05);
      if (terr < -0.5) ny = 0;
      y = ny;
      river.points.push({ x: p.x, z: p.z, y, width, depth });
    }
    world.rivers.push(river);
    // carve bed + gorge banks, write water & flow
    const carved = new Float32Array(H);
    for (let k = 0; k < river.points.length; k++) {
      const p = river.points[k];
      const q = river.points[Math.min(river.points.length - 1, k + 1)];
      const r0 = river.points[Math.max(0, k - 1)];
      let fx = q.x - r0.x, fz = q.z - r0.z;
      const fl = Math.hypot(fx, fz) || 1;
      fx /= fl; fz /= fl;
      const slope = Math.max(0, (r0.y - q.y) / fl);
      const speed = Math.min(5, 0.8 + slope * 25);
      const hw = p.width / 2;
      forCells(p.x, p.z, hw + 22, (i, _x, _z, d) => {
        const target = d < hw ? p.y - p.depth * (1 - 0.6 * (d / hw) ** 2) : p.y - p.depth * 0.4 + (d - hw) * 1.25;
        if (target < carved[i]) carved[i] = target;
        if (d < hw + 1.5 && d < bestD[i]) {
          bestD[i] = d;
          world.water[i] = p.y;
          world.flow[i * 2] = fx * speed;
          world.flow[i * 2 + 1] = fz * speed;
        }
      });
    }
    H.set(carved);
    const fp = river.points[fallAt];
    const fn = river.points[Math.min(river.points.length - 1, fallAt + 1)];
    const fb = river.points[Math.max(0, fallAt - 1)];
    world.waterfalls.push({
      x: fb.x + (fp.x - fb.x) * 0.5, z: fb.z + (fp.z - fb.z) * 0.5,
      top: fallTop, bottom: fallBottom, width: fp.width + 1,
      dir: Math.atan2(fn.x - fb.x, fn.z - fb.z),
    });
    world.landmarks.push({ name: "Cascata del Drago", x: fp.x, z: fp.z, kind: "falls" });
    world.landmarks.push({ name: "Lago Verde", x: lakeX, z: lakeZ, kind: "lake" });


    // ------------------------------------------------------------ cave
    let caveAng = riverAng + Math.PI * 0.8;
    for (let tries = 0; tries < 40; tries++) {
      for (let r = 60; r < 300; r += 4) {
        const x = sx + Math.cos(caveAng) * r, z = sz + Math.sin(caveAng) * r;
        if (hAt(x, z) < 24) { ex = x; ez = z; break; }
      }
      if (distToRiver(ex, ez) > 60) break;
      caveAng += 0.4;
    }
    const inX = -Math.cos(caveAng), inZ = -Math.sin(caveAng); // into the mountain
    const perpX = -inZ, perpZ = inX;
    const eh = hAt(ex, ez);
    const cave: Cave = {
      nodes: [
        { x: ex - inX * 2, y: eh - 1.0, z: ez - inZ * 2, r: 3.2 },
        { x: ex + inX * 9, y: eh - 3.5, z: ez + inZ * 9, r: 3.8 },
        { x: ex + inX * 21 + perpX * 4, y: eh - 7, z: ez + inZ * 21 + perpZ * 4, r: 6.5 },
        { x: ex + inX * 33 - perpX * 6, y: eh - 8, z: ez + inZ * 33 - perpZ * 6, r: 4.2 },
        { x: ex + inX * 46 - perpX * 2, y: eh - 9.5, z: ez + inZ * 46 - perpZ * 2, r: 8 },
        { x: ex + inX * 26 + perpX * 16, y: eh - 5, z: ez + inZ * 26 + perpZ * 16, r: 3.6 },
      ],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]],
      entrances: [{ x: ex, y: eh, z: ez, dx: -inX, dz: -inZ }],
    };
    // keep the interior under the hill
    for (let k = 1; k < cave.nodes.length; k++) {
      const n = cave.nodes[k];
      const top = hAt(n.x, n.z);
      if (n.y + n.r + 3 > top) n.y = top - n.r - 3;
    }
    world.caves.push(cave);
    const caveDist = (x: number, y2: number, z: number) => {
      let d = 1e9;
      for (const n of cave.nodes) d = Math.min(d, Math.hypot(x - n.x, y2 - n.y, z - n.z) - n.r);
      for (const [a, b] of cave.edges) {
        const A = cave.nodes[a], B = cave.nodes[b];
        const bx = B.x - A.x, by = B.y - A.y, bz = B.z - A.z;
        const t = Math.max(0, Math.min(1, ((x - A.x) * bx + (y2 - A.y) * by + (z - A.z) * bz) / (bx * bx + by * by + bz * bz)));
        const r = A.r + (B.r - A.r) * t;
        d = Math.min(d, Math.hypot(x - A.x - bx * t, y2 - A.y - by * t, z - A.z - bz * t) - r);
      }
      return d;
    };
    forCells(ex, ez, 20, (i, x, z) => { if (caveDist(x, H[i], z) < -0.4) world.holes[i] = 1; });
    world.landmarks.push({ name: "Grotta Azzurra", x: ex, z: ez, kind: "cave" });


  }
  // distance to any river (fixture or generator)
  for (const rv of world.rivers) for (const p of rv.points) {
    forCells(p.x, p.z, p.width / 2 + 10, (i, _x, _z, d) => {
      const dd = d - p.width / 2;
      if (dd < bestD[i]) bestD[i] = dd;
    });
  }
  if (!full && world.caves[0]?.entrances[0]) { ex = world.caves[0].entrances[0].x; ez = world.caves[0].entrances[0].z; }

  // ------------------------------------------------------------ helpers for sites
  const slopeAround = (x: number, z: number, r: number) => {
    let mn = 1e9, mx = -1e9;
    for (let a = 0; a < 8; a++) {
      const h = hAt(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    return mx - mn;
  };
  const used: { x: number; z: number; r: number }[] = [
    { x: ex, z: ez, r: 25 }, { x: lakeX, z: lakeZ, r: lakeR + 10 },
  ];
  const free = (x: number, z: number, r: number) => used.every((u) => Math.hypot(u.x - x, u.z - z) > u.r + r) && distToRiver(x, z) > r + 6;
  const findSite = (minH: number, maxH: number, r: number, score: (x: number, z: number) => number) => {
    let best: { x: number; z: number; s: number } | null = null;
    for (let k = 0; k < 900; k++) {
      const x = (rnd() - 0.5) * 820, z = (rnd() - 0.5) * 820;
      const h = hAt(x, z);
      if (h < minH || h > maxH || !free(x, z, r)) continue;
      const s = -slopeAround(x, z, r) + score(x, z);
      if (!best || s > best.s) best = { x, z, s };
    }
    return best;
  };
  const flatten = (x: number, z: number, r: number, level: number, blend = 10) => {
    if (!full) return;
    forCells(x, z, r + blend, (i, _x, _z, d) => {
      const t = d < r ? 1 : 1 - (d - r) / blend;
      const s = t * t * (3 - 2 * t);
      H[i] = H[i] + (level - H[i]) * s;
      world.holes[i] = 0;
    });
  };
  const village = new Uint8Array(N * N);
  const markVillage = (x: number, z: number, r: number) => forCells(x, z, r, (i) => { village[i] = 1; });

  let sid = 0;
  const S = (s: Partial<Solid> & { shape: Solid["shape"] }): Solid => ({ cx: 0, cy: 0, cz: 0, hx: 1, hy: 1, hz: 1, rotY: 0, mat: Material.Stucco, tint: 0xffffff, ...s });
  /** place a local-space solid into a structure frame */
  const place = (ox: number, oy: number, oz: number, rot: number, s: Solid): Solid => {
    const c = Math.cos(rot), sn = Math.sin(rot);
    return { ...s, cx: ox + s.cx * c + s.cz * sn, cy: oy + s.cy, cz: oz - s.cx * sn + s.cz * c, rotY: s.rotY + rot };
  };
  const stucco = () => PALETTE.stuccoWarm[Math.floor(rnd() * PALETTE.stuccoWarm.length)];

  function cottage(ox: number, oz: number, level: number, rot: number, w: number, d: number, stories: number, ruin: number): Solid[] {
    const out: Solid[] = [];
    const t = 0.35, wallH = 3.1 * stories;
    const tint = stucco();
    const add = (s: Solid) => out.push(place(ox, level, oz, rot, s));
    add(S({ shape: "box", cx: 0, cy: 0.15, cz: 0, hx: w / 2 + 0.3, hy: 0.3, hz: d / 2 + 0.3, mat: Material.Stone, tint: 0xd8cfc0 }));
    // front wall with a door gap
    const door = 1.3;
    const seg = (w - door) / 2;
    add(S({ shape: "box", cx: -(door / 2 + seg / 2), cy: wallH / 2, cz: d / 2 - t / 2, hx: seg / 2, hy: wallH / 2, hz: t / 2, tint }));
    add(S({ shape: "box", cx: door / 2 + seg / 2, cy: wallH / 2, cz: d / 2 - t / 2, hx: seg / 2, hy: wallH / 2, hz: t / 2, tint }));
    add(S({ shape: "box", cx: 0, cy: (2.3 + wallH) / 2, cz: d / 2 - t / 2, hx: door / 2, hy: (wallH - 2.3) / 2, hz: t / 2, tint }));
    // back + sides (a ruin loses part of one)
    const backH = ruin > 0.6 ? wallH * 0.55 : wallH;
    add(S({ shape: "box", cx: 0, cy: backH / 2, cz: -d / 2 + t / 2, hx: w / 2, hy: backH / 2, hz: t / 2, tint }));
    add(S({ shape: "box", cx: -w / 2 + t / 2, cy: wallH / 2, cz: 0, hx: t / 2, hy: wallH / 2, hz: d / 2 - t, tint }));
    const sideH = ruin > 0.8 ? wallH * 0.4 : wallH;
    add(S({ shape: "box", cx: w / 2 - t / 2, cy: sideH / 2, cz: 0, hx: t / 2, hy: sideH / 2, hz: d / 2 - t, tint }));
    // stone plinth band
    add(S({ shape: "box", cx: 0, cy: 0.45, cz: d / 2 - t / 2, hx: w / 2 + 0.05, hy: 0.3, hz: t / 2 + 0.06, mat: Material.Stone, tint: 0xe0d6c4 }));
    // roof: whole, or half-collapsed
    const roofH = Math.min(w, d) * 0.28;
    if (ruin < 0.6) {
      add(S({ shape: "wedge", cx: 0, cy: wallH + roofH / 2, cz: 0, hx: w / 2 + 0.35, hy: roofH / 2, hz: d / 2 + 0.45, mat: Material.Terracotta, tint: 0xffffff }));
    } else {
      add(S({ shape: "box", cx: -w / 4, cy: wallH + 0.1, cz: 0, hx: w / 4, hy: 0.1, hz: d / 2 - 0.1, mat: Material.WoodDark }));
    }
    // front step
    add(S({ shape: "box", cx: 0, cy: 0.12, cz: d / 2 + 0.45, hx: door / 2 + 0.3, hy: 0.12, hz: 0.35, mat: Material.Stone, tint: 0xd8cfc0 }));
    return out;
  }
  const addStructs = world.structures.length === 0;
  if (addStructs) filled.push("structures");
  const addStructure = (kind: StructureKind, x: number, yy: number, z: number, rot: number, solids: Solid[]) => {
    if (!addStructs) return;
    world.structures.push({ id: sid++, kind, x, y: yy, z, rotY: rot, solids } as Structure);
  };

  // hamlet around a piazza
  const hamlet = findSite(6, 22, 26, (x, z) => -Math.abs(hAt(x, z) - 12) * 0.2);
  if (hamlet) {
    const level = hAt(hamlet.x, hamlet.z) + 0.2;
    flatten(hamlet.x, hamlet.z, 24, level, 14);
    markVillage(hamlet.x, hamlet.z, 30);
    used.push({ x: hamlet.x, z: hamlet.z, r: 32 });
    const houses = 4;
    for (let k = 0; k < houses; k++) {
      const a = (k / houses) * Math.PI * 2 + rnd() * 0.4;
      const r = 13 + rnd() * 3;
      const hx = hamlet.x + Math.cos(a) * r, hz = hamlet.z + Math.sin(a) * r;
      const rot = Math.atan2(hamlet.x - hx, hamlet.z - hz); // face the piazza (+Z local)
      const w = 6 + rnd() * 2.5, d = 5 + rnd() * 2;
      addStructure(StructureKind.Cottage, hx, level, hz, rot, cottage(hx, hz, level, rot, w, d, k === 0 ? 2 : 1, k === 2 ? 0.7 : k === 3 ? 0.9 : 0.2));
    }
    // well in the middle
    addStructure(StructureKind.Well, hamlet.x, level, hamlet.z, 0, [
      S({ shape: "cylinder", cx: hamlet.x, cy: level + 0.5, cz: hamlet.z, hx: 1.0, hy: 0.5, mat: Material.Stone, tint: 0xe6dccb }),
      S({ shape: "box", cx: hamlet.x - 0.9, cy: level + 1.4, cz: hamlet.z, hx: 0.08, hy: 0.9, hz: 0.08, mat: Material.WoodDark }),
      S({ shape: "box", cx: hamlet.x + 0.9, cy: level + 1.4, cz: hamlet.z, hx: 0.08, hy: 0.9, hz: 0.08, mat: Material.WoodDark }),
      S({ shape: "wedge", cx: hamlet.x, cy: level + 2.5, cz: hamlet.z, hx: 1.2, hy: 0.25, hz: 0.8, mat: Material.Terracotta }),
    ]);
    world.landmarks.push({ name: "Borgo San Pietro", x: hamlet.x, z: hamlet.z, kind: "village" });
  }

  // lighthouse on the coast
  let lh: { x: number; z: number } | null = null;
  {
    let best = -1e9;
    for (let k = 0; k < 600; k++) {
      const a = rnd() * Math.PI * 2;
      for (let r = 450; r > 150; r -= 3) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = hAt(x, z);
        if (h > 5) {
          const s = r * 0.1 + h * 0.5 - slopeAround(x, z, 6) * 2;
          if (s > best && free(x, z, 12)) { best = s; lh = { x, z }; }
          break;
        }
      }
    }
    if (lh) {
      const level = hAt(lh.x, lh.z) + 0.1;
      flatten(lh.x, lh.z, 7, level, 6);
      used.push({ x: lh.x, z: lh.z, r: 12 });
      const L = (cy: number, hx: number, hy: number, mat: Material, tint: number) =>
        S({ shape: "cylinder", cx: lh!.x, cy: level + cy, cz: lh!.z, hx, hy, mat, tint });
      addStructure(StructureKind.Lighthouse, lh.x, level, lh.z, 0, [
        L(0.6, 4.2, 0.6, Material.Stone, 0xe2d8c6),
        L(1.2 + 5, 2.6, 5, Material.Plaster, 0xffffff),
        L(11.2 + 1.2, 2.3, 1.2, Material.Plaster, 0xd9483b),
        L(13.6 + 2.5, 2.1, 2.5, Material.Plaster, 0xffffff),
        L(18.1 + 0.25, 2.8, 0.25, Material.Stone, 0xe2d8c6),
        L(18.35 + 1.1, 1.5, 1.1, Material.Metal, 0x3c4a4f),
        L(19.45 + 0.6, 1.7, 0.6, Material.Terracotta, 0xffffff),
      ]);
      // keeper's cottage next to it
      const cx2 = lh.x + 7, cz2 = lh.z + 2;
      addStructure(StructureKind.Cottage, cx2, level, cz2, 0.3, cottage(cx2, cz2, level, 0.3, 5, 4.5, 1, 0.1));
      world.landmarks.push({ name: "Faro Vecchio", x: lh.x, z: lh.z, kind: "point" });
    }
  }

  // chapel on high ground
  const ch = findSite(26, 48, 12, (x, z) => hAt(x, z) * 0.05);
  if (ch) {
    const level = hAt(ch.x, ch.z) + 0.1;
    flatten(ch.x, ch.z, 10, level, 8);
    used.push({ x: ch.x, z: ch.z, r: 14 });
    markVillage(ch.x, ch.z, 12);
    const rot = rnd() * Math.PI;
    const add = (s: Solid) => place(ch.x, level, ch.z, rot, s);
    const tint = 0xf5e6c8;
    addStructure(StructureKind.Chapel, ch.x, level, ch.z, rot, [
      add(S({ shape: "box", cx: 0, cy: 0.2, cz: 0, hx: 3.6, hy: 0.2, hz: 5.6, mat: Material.Stone, tint: 0xd8cfc0 })),
      add(S({ shape: "box", cx: -3, cy: 2.6, cz: 0, hx: 0.4, hy: 2.4, hz: 5, tint })),
      add(S({ shape: "box", cx: 3, cy: 2.6, cz: 0, hx: 0.4, hy: 2.4, hz: 5, tint })),
      add(S({ shape: "box", cx: 0, cy: 2.6, cz: -5, hx: 3.4, hy: 2.4, hz: 0.4, tint })),
      add(S({ shape: "box", cx: -2, cy: 2.6, cz: 5, hx: 1.4, hy: 2.4, hz: 0.4, tint })),
      add(S({ shape: "box", cx: 2, cy: 2.6, cz: 5, hx: 1.4, hy: 2.4, hz: 0.4, tint })),
      add(S({ shape: "box", cx: 0, cy: 4.1, cz: 5, hx: 0.6, hy: 0.9, hz: 0.4, tint })),
      add(S({ shape: "wedge", cx: 0, cy: 5.0 + 1.3, cz: 0, hx: 3.8, hy: 1.3, hz: 5.6, rotY: Math.PI / 2, mat: Material.Terracotta })),
      add(S({ shape: "box", cx: 2.6, cy: 4.5, cz: -4.6, hx: 1.1, hy: 4.5, hz: 1.1, tint })),
      add(S({ shape: "wedge", cx: 2.6, cy: 9.4, cz: -4.6, hx: 1.3, hy: 0.4, hz: 1.3, mat: Material.Terracotta })),
    ]);
    world.landmarks.push({ name: "Cappella di Santa Lucia", x: ch.x, z: ch.z, kind: "ruin" });
  }

  // dock + boathouse on a beach
  {
    let best: { x: number; z: number; ang: number } | null = null;
    for (let k = 0; k < 400 && !best; k++) {
      const a = rnd() * Math.PI * 2;
      let prev = 0;
      for (let r = 470; r > 120; r -= 2) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = hAt(x, z);
        if (h > 0.4 && prev <= 0.4) {
          if (slopeAround(x, z, 8) < 3 && free(x, z, 15)) best = { x, z, ang: a };
          break;
        }
        prev = h;
      }
    }
    if (best) {
      const ox = Math.cos(best.ang), oz = Math.sin(best.ang); // outward
      const rot = Math.atan2(ox, oz);
      const len = 16;
      const cx = best.x + ox * len / 2, cz = best.z + oz * len / 2;
      const solids: Solid[] = [];
      const add = (s: Solid) => solids.push(place(cx, 0, cz, rot, s));
      add(S({ shape: "box", cx: 0, cy: 1.05, cz: 0, hx: 1.3, hy: 0.12, hz: len / 2, mat: Material.Wood, tint: 0xffffff }));
      for (let k = 0; k < 5; k++) {
        const zz = -len / 2 + 1 + k * (len - 2) / 4;
        add(S({ shape: "cylinder", cx: -1.2, cy: -0.5, cz: zz, hx: 0.16, hy: 1.8, mat: Material.WoodDark }));
        add(S({ shape: "cylinder", cx: 1.2, cy: -0.5, cz: zz, hx: 0.16, hy: 1.8, mat: Material.WoodDark }));
      }
      addStructure(StructureKind.Dock, cx, 1, cz, rot, solids);
      used.push({ x: best.x, z: best.z, r: 14 });
      const bx = best.x - ox * 6, bz = best.z - oz * 6;
      const level = hAt(bx, bz) + 0.2;
      flatten(bx, bz, 6, level, 6);
      addStructure(StructureKind.Boathouse, bx, level, bz, rot + Math.PI, cottage(bx, bz, level, rot + Math.PI, 5.5, 5, 1, 0.3));
      world.landmarks.push({ name: "Porticciolo", x: best.x, z: best.z, kind: "bay" });
    }
  }

  // lone arch
  const ar = findSite(10, 40, 6, () => 0);
  if (ar) {
    const level = hAt(ar.x, ar.z);
    const rot = rnd() * Math.PI;
    const add = (s: Solid) => place(ar.x, level, ar.z, rot, s);
    addStructure(StructureKind.Arch, ar.x, level, ar.z, rot, [
      add(S({ shape: "box", cx: -2, cy: 2.2, cz: 0, hx: 0.6, hy: 2.8, hz: 0.7, mat: Material.Stone, tint: 0xe8dcc6 })),
      add(S({ shape: "box", cx: 2, cy: 2.2, cz: 0, hx: 0.6, hy: 2.8, hz: 0.7, mat: Material.Stone, tint: 0xe8dcc6 })),
      add(S({ shape: "box", cx: 0, cy: 5.4, cz: 0, hx: 2.8, hy: 0.5, hz: 0.75, mat: Material.Brick, tint: 0xffffff })),
      add(S({ shape: "box", cx: 5, cy: 1.2, cz: 0, hx: 0.6, hy: 1.8, hz: 0.7, mat: Material.Stone, tint: 0xe8dcc6 })),
    ]);
    used.push({ x: ar.x, z: ar.z, r: 8 });
  }

  // footbridge over the river
  const rv0 = world.rivers[0];
  if (rv0 && rv0.points.length > 4) {
    const k = Math.floor(rv0.points.length * 0.6);
    const p = rv0.points[k], q = rv0.points[k + 1] ?? p;
    const rot = Math.atan2(q.x - p.x, q.z - p.z) + Math.PI / 2;
    const span = p.width + 6;
    const deckY = p.y + 1.6;
    const solids: Solid[] = [];
    const add = (s: Solid) => solids.push(place(p.x, deckY, p.z, rot, s));
    add(S({ shape: "box", cx: 0, cy: 0, cz: 0, hx: 1.1, hy: 0.12, hz: span / 2, mat: Material.Wood }));
    add(S({ shape: "box", cx: -1.05, cy: 0.55, cz: 0, hx: 0.06, hy: 0.45, hz: span / 2, mat: Material.WoodDark }));
    add(S({ shape: "box", cx: 1.05, cy: 0.55, cz: 0, hx: 0.06, hy: 0.45, hz: span / 2, mat: Material.WoodDark }));
    addStructure(StructureKind.Bridge, p.x, deckY, p.z, rot, solids);
  }

  // ------------------------------------------------------------ paths
  const sites = [hamlet, lh, ch, ar].filter(Boolean) as { x: number; z: number }[];
  const pathTo = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const pts2: { x: number; z: number }[] = [];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4);
    const wig = valueNoise(Math.floor(a.x * 13 + b.z));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const off = (wig(t * 4, 0.5) - 0.5) * 30 * Math.sin(t * Math.PI);
      const x = a.x + (b.x - a.x) * t + -(b.z - a.z) / (n * 4) * off;
      const z = a.z + (b.z - a.z) * t + (b.x - a.x) / (n * 4) * off;
      pts2.push({ x, z });
    }
    world.paths.push({ points: pts2, width: 2.6 });
    for (const p of pts2) forCells(p.x, p.z, 3.2, (i, _x, _z, d) => {
      const v = Math.round(255 * Math.min(1, Math.max(0, (3.2 - d) / 1.6)));
      if (v > world.path[i]) world.path[i] = v;
    });
  };
  if (addStructs && hamlet && world.path.every((v) => v === 0)) {
    filled.push("paths");
    for (const s of sites) if (s !== hamlet) pathTo(hamlet, s);
  }

  // ------------------------------------------------------------ biomes + moisture
  const moistN = valueNoise(world.seed + 99);
  const needBiomes = full || world.biome.every((b) => b === world.biome[0]);
  const needMoist = full || world.moisture.every((m) => m === 0);
  if (needBiomes) filled.push("biomes");
  if (needMoist) filled.push("moisture");
  if (needBiomes || needMoist) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const x = wx(i), z = wx(j);
    const h = H[k];
    const hl = H[j * N + Math.max(0, i - 1)], hr = H[j * N + Math.min(N - 1, i + 1)];
    const hd = H[Math.max(0, j - 1) * N + i], hu = H[Math.min(N - 1, j + 1) * N + i];
    const sl = Math.hypot((hr - hl) / (2 * CELL), (hu - hd) / (2 * CELL));
    let m = moistN(x * 0.006 + 10, z * 0.006 + 10);
    const wet = world.water[k] !== NO_WATER;
    const nearRiver = wet || (h < 30 && distToRiverFast(i, j) < 8);
    if (nearRiver) m = Math.max(m, 0.85);
    m = Math.min(1, Math.max(0, m * 1.3 - 0.1 - Math.max(0, h - 30) * 0.01));
    if (needMoist) world.moisture[k] = Math.round(m * 255);
    if (!needBiomes) continue;
    let b: Biome;
    if (h < -4) b = Biome.DeepOcean;
    else if (h < -0.2) b = Biome.Shallows;
    else if (sl > 1.0 && h > 1) b = Biome.Cliff;
    else if (h < 2.4) b = Biome.Beach;
    else if (village[k]) b = Biome.Village;
    else if (nearRiver && h > 1) b = Biome.Riverbank;
    else if (h < 7) b = m > 0.7 && h < 3.5 ? Biome.Mangrove : Biome.PalmGrove;
    else if (h < 26) b = m > 0.42 ? Biome.Jungle : Biome.Meadow;
    else if (h < 44) b = m > 0.5 ? Biome.Meadow : m > 0.34 ? Biome.Forest : Biome.Scrub;
    else if (h < 56) b = Biome.Scrub;
    else b = Biome.Rock;
    world.biome[k] = b;
  }
  function distToRiverFast(i: number, j: number) {
    const k = j * N + i;
    return bestD[k] < 1e8 ? bestD[k] : 99;
  }

  // ------------------------------------------------------------ props
  if (world.props.length > 0) return { filled };
  filled.push("props");
  const lists = new Map<PropKind, number[]>();
  const push = (kind: PropKind, x: number, z: number, scale: number) => {
    let l = lists.get(kind);
    if (!l) { l = []; lists.set(kind, l); }
    l.push(x, hAt(x, z), z, rnd() * Math.PI * 2, scale);
  };
  type Rule = [PropKind, number, number, number]; // kind, prob per cell, min scale, max scale
  const R: Partial<Record<Biome, Rule[]>> = {
    [Biome.Beach]: [[PropKind.PalmLeaning, 0.006, 0.8, 1.2], [PropKind.Driftwood, 0.003, 0.8, 1.3], [PropKind.RockSmall, 0.004, 0.6, 1.3], [PropKind.GrassTuft, 0.01, 0.7, 1.1]],
    [Biome.PalmGrove]: [[PropKind.Palm, 0.03, 0.8, 1.25], [PropKind.PalmLeaning, 0.012, 0.8, 1.2], [PropKind.Bush, 0.03, 0.7, 1.3], [PropKind.GrassTuft, 0.25, 0.7, 1.3], [PropKind.Fern, 0.02, 0.7, 1.2], [PropKind.Banana, 0.012, 0.8, 1.2], [PropKind.Flowers, 0.04, 0.8, 1.2], [PropKind.Bougainvillea, 0.004, 0.8, 1.2]],
    [Biome.Jungle]: [[PropKind.JungleGiant, 0.0025, 0.85, 1.15], [PropKind.TreeFern, 0.02, 0.8, 1.2], [PropKind.Understory, 0.04, 0.8, 1.3], [PropKind.Log, 0.004, 0.8, 1.2], [PropKind.Broadleaf, 0.03, 0.8, 1.3], [PropKind.Banana, 0.03, 0.8, 1.3], [PropKind.Fern, 0.14, 0.7, 1.4], [PropKind.Bush, 0.05, 0.8, 1.4], [PropKind.Palm, 0.012, 0.9, 1.3], [PropKind.GrassTuft, 0.1, 0.8, 1.3], [PropKind.RockMedium, 0.003, 0.7, 1.2], [PropKind.Boulder, 0.0015, 0.7, 1.1], [PropKind.Flowers, 0.02, 0.8, 1.2]],
    [Biome.Forest]: [[PropKind.HolmOak, 0.03, 0.8, 1.25], [PropKind.Pine, 0.012, 0.85, 1.2], [PropKind.UmbrellaPine, 0.003, 0.9, 1.2], [PropKind.Bush, 0.04, 0.7, 1.3], [PropKind.Log, 0.004, 0.8, 1.2], [PropKind.RockMedium, 0.004, 0.7, 1.2], [PropKind.GrassTuft, 0.08, 0.6, 1.0]],
    [Biome.Meadow]: [[PropKind.UmbrellaPine, 0.005, 0.8, 1.2], [PropKind.Olive, 0.01, 0.8, 1.2], [PropKind.Cypress, 0.004, 0.8, 1.2], [PropKind.GrassTuft, 0.4, 0.7, 1.3], [PropKind.Flowers, 0.1, 0.8, 1.3], [PropKind.Bush, 0.02, 0.7, 1.2], [PropKind.RockSmall, 0.01, 0.6, 1.3], [PropKind.Agave, 0.003, 0.8, 1.2], [PropKind.LemonTree, 0.002, 0.8, 1.1]],
    [Biome.Scrub]: [[PropKind.Agave, 0.02, 0.7, 1.3], [PropKind.Bush, 0.05, 0.6, 1.2], [PropKind.Olive, 0.008, 0.7, 1.1], [PropKind.GrassTuft, 0.18, 0.6, 1.1], [PropKind.RockSmall, 0.03, 0.6, 1.4], [PropKind.RockMedium, 0.01, 0.6, 1.2], [PropKind.Cypress, 0.004, 0.8, 1.2], [PropKind.UmbrellaPine, 0.002, 0.8, 1.1]],
    [Biome.Rock]: [[PropKind.RockMedium, 0.012, 0.6, 1.3], [PropKind.Boulder, 0.005, 0.6, 1.2], [PropKind.Agave, 0.004, 0.7, 1.1], [PropKind.RockSmall, 0.02, 0.6, 1.4]],
    [Biome.Cliff]: [[PropKind.Bush, 0.01, 0.6, 1.1], [PropKind.RockSmall, 0.01, 0.6, 1.2]],
    [Biome.Riverbank]: [[PropKind.Reed, 0.18, 0.7, 1.3], [PropKind.Fern, 0.08, 0.7, 1.3], [PropKind.GrassTuft, 0.2, 0.7, 1.2], [PropKind.Banana, 0.015, 0.8, 1.2], [PropKind.RockSmall, 0.02, 0.6, 1.3]],
    [Biome.Village]: [[PropKind.LemonTree, 0.008, 0.8, 1.1], [PropKind.Cypress, 0.006, 0.8, 1.2], [PropKind.Flowers, 0.05, 0.8, 1.2], [PropKind.Bougainvillea, 0.012, 0.8, 1.3], [PropKind.GrassTuft, 0.08, 0.6, 1.0]],
    [Biome.Mangrove]: [[PropKind.Mangrove, 0.03, 0.8, 1.2], [PropKind.Reed, 0.06, 0.7, 1.2], [PropKind.Fern, 0.03, 0.7, 1.1]],
  };
  const clump = valueNoise(world.seed + 7);
  const structs = world.structures.map((s) => ({ x: s.x, z: s.z, r: s.kind === StructureKind.Lighthouse ? 7 : s.kind === StructureKind.Dock ? 10 : 6 }));
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    const rules = R[world.biome[k] as Biome];
    if (!rules) continue;
    if (world.holes[k] || world.path[k] > 90) continue;
    const x0 = wx(i), z0 = wx(j);
    const wet = world.water[k] !== NO_WATER && world.water[k] > H[k] - 0.1;
    const cl = clump(x0 * 0.03, z0 * 0.03);
    for (const [kind, p, s0, s1] of rules) {
      let prob = p;
      if (kind === PropKind.GrassTuft || kind === PropKind.Flowers || kind === PropKind.Fern) prob *= Math.max(0, cl * 2 - 0.3);
      if (kind === PropKind.Reed && !wet && bestD[k] > 3) prob *= 0.15;
      if (wet && kind !== PropKind.Reed && kind !== PropKind.Mangrove) continue;
      if (rnd() >= prob) continue;
      const x = x0 + (rnd() - 0.5) * CELL, z = z0 + (rnd() - 0.5) * CELL;
      let blocked = false;
      for (const s of structs) if (Math.hypot(s.x - x, s.z - z) < s.r + (kind <= PropKind.Olive ? 4 : 1)) { blocked = true; break; }
      if (blocked) continue;
      push(kind, x, z, s0 + (s1 - s0) * rnd());
    }
  }
  // bougainvillea hugging cottage walls, potted lemons in the piazza
  for (const s of world.structures) {
    if (s.kind !== StructureKind.Cottage) continue;
    for (let k = 0; k < 2; k++) {
      const a = s.rotY + (k ? 0.9 : -0.9);
      push(PropKind.Bougainvillea, s.x + Math.sin(a) * 4.2, s.z + Math.cos(a) * 4.2, 1 + rnd() * 0.3);
    }
  }
  world.props = [...lists.entries()].map(([kind, l]): PropSet => ({ kind, count: l.length / PROP_STRIDE, data: new Float32Array(l) }));

  if (full && hamlet) world.spawns = [{ x: hamlet.x, y: hAt(hamlet.x, hamlet.z) + 1, z: hamlet.z }];
  return { filled };
}
