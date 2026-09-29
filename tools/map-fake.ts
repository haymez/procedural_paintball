// `?fake=1` data for the map tool: the stub island plus plausible fake
// features, so every overlay can be exercised before the real generator lands.
import { stubWorld } from "../shared/world/stub";
import {
  CELL, GRID_RES, Material, NO_WATER, PickupKind, PropKind, PROP_STRIDE, StructureKind, VehicleKind, WORLD_HALF,
  type Cave, type Landmark, type PropSet, type River, type Solid, type Structure, type World,
} from "../shared/world/types";
import { sampleGrid } from "./map-draw";

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fakeWorld(seed: number, skipDecor = false): { world: World; timings: { stage: string; ms: number }[]; totalMs: number } {
  const t0 = performance.now();
  const w = stubWorld(seed);
  const t1 = performance.now();
  const rnd = mulberry32(seed * 9973 + 17);
  const h = (x: number, z: number) => sampleGrid(w.height, x, z);
  const landPoint = (min = 2, max = 999): [number, number] => {
    for (let k = 0; k < 500; k++) {
      const x = (rnd() * 2 - 1) * 440, z = (rnd() * 2 - 1) * 440;
      const y = h(x, z);
      if (y > min && y < max) return [x, z];
    }
    return [0, 0];
  };

  // rivers: walk downhill from high points
  const rivers: River[] = [];
  for (let r = 0; r < 3; r++) {
    let [x, z] = landPoint(30);
    const pts = [];
    for (let s = 0; s < 80; s++) {
      const y = h(x, z);
      pts.push({ x, z, y: y + 0.3, width: 2.5 + s * 0.12, depth: 1 });
      if (y < 0) break;
      let best = 0, bh = Infinity;
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const hh = h(x + Math.cos(ang) * 10, z + Math.sin(ang) * 10);
        if (hh < bh) { bh = hh; best = ang; }
      }
      x += Math.cos(best) * 10 + (rnd() - 0.5) * 4;
      z += Math.sin(best) * 10 + (rnd() - 0.5) * 4;
    }
    rivers.push({ points: pts });
  }

  // one lake: flood cells around a mid-height point
  const [lx, lz] = landPoint(15, 30);
  const level = h(lx, lz) + 2.5;
  for (let iz = 0; iz < GRID_RES; iz++) {
    for (let ix = 0; ix < GRID_RES; ix++) {
      const x = -WORLD_HALF + ix * CELL, z = -WORLD_HALF + iz * CELL;
      const i = iz * GRID_RES + ix;
      if (Math.hypot(x - lx, z - lz) < 40 && w.height[i] < level) w.water[i] = level;
    }
  }
  for (const r of rivers) {
    for (const p of r.points) {
      const i = Math.round((p.z + WORLD_HALF) / CELL) * GRID_RES + Math.round((p.x + WORLD_HALF) / CELL);
      if (w.water[i] === NO_WATER && p.y > 0) w.water[i] = w.height[i] + 0.4;
    }
  }

  const waterfalls = rivers.slice(0, 2).map((r) => {
    const p = r.points[Math.min(8, r.points.length - 2)], q = r.points[Math.min(9, r.points.length - 1)];
    return { x: p.x, z: p.z, top: p.y, bottom: p.y - 6, width: p.width, dir: Math.atan2(q.x - p.x, q.z - p.z) };
  });

  // caves
  const caves: Cave[] = [];
  for (let c = 0; c < 2; c++) {
    const [cx, cz] = landPoint(20);
    const nodes = [];
    for (let k = 0; k < 6; k++) nodes.push({ x: cx + k * 14 + (rnd() - 0.5) * 10, y: h(cx, cz) - 8, z: cz + (rnd() - 0.5) * 30, r: 3 + rnd() * 4 });
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]];
    const entrances = [nodes[0], nodes[4]].map((n, k) => ({ x: n.x, y: n.y, z: n.z, dx: k ? 1 : -1, dz: 0.3 }));
    caves.push({ nodes, edges, entrances });
  }

  // structures
  const structures: Structure[] = [];
  const stucco = [0xf2c68c, 0xe8a87c, 0xf5e0b5, 0xe89f8f, 0xf7d9a0, 0xb8d8c8];
  for (let s = 0; s < 18; s++) {
    const [x, z] = landPoint(3, 40);
    const y = h(x, z);
    const rotY = rnd() * Math.PI * 2;
    const kind = s % 5 === 0 ? StructureKind.Watchtower : s % 7 === 0 ? StructureKind.Dock : StructureKind.Cottage;
    const solids: Solid[] = [];
    const c = Math.cos(rotY), n = Math.sin(rotY);
    const at = (lx: number, lz: number) => ({ cx: x + lx * c + lz * n, cz: z - lx * n + lz * c });
    if (kind === StructureKind.Watchtower) {
      solids.push({ shape: "cylinder", ...at(0, 0), cy: y + 6, hx: 3, hy: 6, hz: 3, rotY, mat: Material.Stone, tint: 0xffffff });
    } else {
      const tint = stucco[s % stucco.length];
      solids.push({ shape: "box", ...at(0, 0), cy: y + 2, hx: 5, hy: 2, hz: 3.5, rotY, mat: Material.Stucco, tint });
      solids.push({ shape: "wedge", ...at(0, 0), cy: y + 5, hx: 5.4, hy: 1, hz: 3.9, rotY, mat: Material.Terracotta, tint: 0xffffff });
      solids.push({ shape: "box", ...at(0, 7), cy: y + 0.2, hx: 1.2, hy: 0.2, hz: 3, rotY, mat: Material.Wood, tint: 0xffffff });
    }
    structures.push({ id: s, kind, x, y, z, rotY, solids });
  }

  // paths between consecutive structures, stamped into the path grid
  const paths = [];
  for (let p = 0; p + 1 < structures.length && p < 8; p++) {
    const a = structures[p], b = structures[p + 1];
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      pts.push({ x: a.x + (b.x - a.x) * t + Math.sin(t * Math.PI) * 20, z: a.z + (b.z - a.z) * t });
    }
    paths.push({ points: pts, width: 3 });
  }
  for (const p of paths) {
    for (let k = 1; k < p.points.length; k++) {
      const a = p.points[k - 1], b = p.points[k];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps, z = a.z + ((b.z - a.z) * s) / steps;
        const i = Math.round((z + WORLD_HALF) / CELL) * GRID_RES + Math.round((x + WORLD_HALF) / CELL);
        w.path[i] = 230;
        w.path[i + 1] = Math.max(w.path[i + 1], 120);
      }
    }
  }

  // props
  const props: PropSet[] = [];
  const kinds = Object.values(PropKind).filter((v) => typeof v === "number") as PropKind[];
  for (const kind of kinds) {
    if (skipDecor && (kind === PropKind.GrassTuft || kind === PropKind.Flowers || kind === PropKind.Fern)) continue;
    const count = kind === PropKind.GrassTuft ? 12000 : kind === PropKind.Palm || kind === PropKind.Broadleaf ? 4000 : 1500;
    const data = new Float32Array(count * PROP_STRIDE);
    for (let i = 0; i < count; i++) {
      const [x, z] = landPoint(kind === PropKind.Palm || kind === PropKind.Driftwood ? 0.5 : 4, kind === PropKind.Palm ? 12 : 999);
      data.set([x, h(x, z), z, rnd() * 6.28, 0.7 + rnd() * 0.6], i * PROP_STRIDE);
    }
    props.push({ kind, count, data });
  }

  const pickups = [];
  for (let i = 0; i < 40; i++) {
    const [x, z] = landPoint();
    pickups.push({ kind: PickupKind.Ammo, x, y: h(x, z), z });
  }
  for (let i = 0; i < 14; i++) {
    const [x, z] = landPoint();
    pickups.push({ kind: (1 + (i % 7)) as PickupKind, x, y: h(x, z), z });
  }
  const vehicles = [];
  for (let i = 0; i < 7; i++) {
    const kind = i < 3 ? VehicleKind.Rowboat : i < 4 ? VehicleKind.Gondola : VehicleKind.Vespa;
    const [x, z] = kind === VehicleKind.Vespa ? landPoint(5) : landPoint(-2, -0.5);
    vehicles.push({ kind, x, y: h(x, z), z, rotY: rnd() * Math.PI * 2 });
  }
  const ziplines = [];
  for (let i = 0; i < 3; i++) {
    const [ax, az] = landPoint(40);
    const [bx, bz] = [ax + (rnd() - 0.5) * 240, az + (rnd() - 0.5) * 240];
    ziplines.push({ ax, ay: h(ax, az) + 6, az, bx, by: Math.max(h(bx, bz), 0) + 2, bz });
  }
  const spawns = [];
  for (let i = 0; i < 20; i++) {
    const [x, z] = landPoint(1);
    spawns.push({ x, y: h(x, z), z });
  }
  const names: [string, Landmark["kind"]][] = [
    ["Monte Scuro", "peak"], ["Baia dei Coralli", "bay"], ["Cala Rossa", "cove"], ["Borgo Vecchio", "village"],
    ["Torre Mozza", "ruin"], ["Lago Verde", "lake"], ["Cascata Bianca", "falls"], ["Grotta del Drago", "cave"],
    ["Spiaggia Lunga", "beach"], ["Punta Faro", "point"],
  ];
  const landmarks: Landmark[] = names.map(([name, kind]) => {
    const [x, z] = kind === "bay" || kind === "cove" || kind === "point" ? landPoint(-6, -1) : landPoint(5);
    return { name, kind, x, z };
  });

  const world: World = {
    ...w,
    name: `Isola di San Finto ${seed}`,
    rivers, lakes: [{ level, x: lx, z: lz }], waterfalls, caves, structures, paths, props, pickups, vehicles, ziplines, spawns, landmarks,
  };
  const t2 = performance.now();
  return {
    world,
    timings: [{ stage: "terrain (stub)", ms: t1 - t0 }, { stage: "fake features", ms: t2 - t1 }],
    totalMs: t2 - t0,
  };
}
