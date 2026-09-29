// Preset viewpoints derived from the world data (works for fixtures and the
// real generator): beach, jungle, peak overlook, river valley, cave, ruin.
import { Biome, CELL, GRID_RES, WORLD_HALF, type World } from "../../../../shared/world/types";
import { heightAt } from "../worldTextures";

export interface Viewpoint { name: string; x: number; y: number; z: number; yaw: number; pitch: number }

const deg = (r: number) => (r * 180) / Math.PI;
/** yaw (deg) looking from a to b, matching tools/view.ts (0 = +Z) */
const yawTo = (ax: number, az: number, bx: number, bz: number) => deg(Math.atan2(bx - ax, bz - az));

export function tourViewpoints(world: World): Viewpoint[] {
  const N = GRID_RES;
  const out: Viewpoint[] = [];
  const wx = (i: number) => -WORLD_HALF + i * CELL;
  const find = (pred: (i: number) => boolean, prefer: (i: number) => number) => {
    let best = -1, bs = -Infinity;
    for (let k = 0; k < N * N; k += 7) if (pred(k)) { const s = prefer(k); if (s > bs) { bs = s; best = k; } }
    return best < 0 ? null : { x: wx(best % N), z: wx(Math.floor(best / N)) };
  };
  let peak = 0;
  for (let i = 0; i < world.height.length; i++) if (world.height[i] > world.height[peak]) peak = i;
  const px = wx(peak % N), pz = wx(Math.floor(peak / N));

  // 0 beach level: beach cell far from centre, looking along the shore
  const beach = find((i) => world.biome[i] === Biome.Beach && world.height[i] > 0.8, (i) => -Math.abs(world.height[i] - 1.2) + Math.sin(i) * 0.3)
    ?? find((i) => world.height[i] > 0.8 && world.height[i] < 2, (i) => Math.sin(i) * 0.3);
  if (!beach) out.push({ name: "beach (none)", x: 0, y: 40, z: 0, yaw: 0, pitch: -10 });
  else {
    const ang = Math.atan2(beach.z - pz, beach.x - px);
    const lookX = beach.x - Math.sin(ang) * 30 + Math.cos(ang) * 12, lookZ = beach.z + Math.cos(ang) * 30 + Math.sin(ang) * 12;
    out.push({ name: "beach", x: beach.x, y: heightAt(world, beach.x, beach.z) + 1.6, z: beach.z, yaw: yawTo(beach.x, beach.z, lookX, lookZ), pitch: -2 });
  }
  // 1 jungle
  const jungle = find((i) => world.biome[i] === Biome.Jungle, (i) => world.moisture[i] + Math.sin(i * 1.7) * 20)
    ?? find((i) => world.height[i] > 8 && world.height[i] < 20, (i) => Math.sin(i * 1.7));
  if (!jungle) out.push({ name: "jungle (none)", x: 0, y: 40, z: 0, yaw: 0, pitch: -10 });
  else out.push({ name: "jungle", x: jungle.x, y: heightAt(world, jungle.x, jungle.z) + 1.6, z: jungle.z, yaw: yawTo(jungle.x, jungle.z, px, pz) + 40, pitch: 3 });
  // 2 peak overlook
  out.push({ name: "peak overlook", x: px + 8, y: world.height[peak] + 14, z: pz + 8, yaw: yawTo(px, pz, 0, 0) + 200, pitch: -14 });
  // 3 river valley
  const river = world.rivers[0];
  if (river && river.points.length > 4) {
    const k = Math.floor(river.points.length * 0.3);
    const a = river.points[k], b = river.points[Math.min(river.points.length - 1, k + 6)];
    const bx = a.x - (b.x - a.x) * 0.8, bz = a.z - (b.z - a.z) * 0.8;
    out.push({ name: "river valley", x: bx, y: Math.max(a.y, heightAt(world, bx, bz)) + 6, z: bz, yaw: yawTo(bx, bz, b.x, b.z), pitch: -10 });
  } else out.push({ name: "river valley (none)", x: px / 2, y: 40, z: pz / 2, yaw: 0, pitch: -10 });
  // 4 cave interior
  let bestCave: { c: typeof world.caves[0]; i: number } | null = null;
  for (const c of world.caves) c.nodes.forEach((n, i) => { if (n.y > 1 && (!bestCave || n.r > bestCave.c.nodes[bestCave.i].r)) bestCave = { c, i }; });
  if (bestCave) {
    const { c, i } = bestCave as { c: typeof world.caves[0]; i: number };
    const a = c.nodes[i];
    const e = c.edges.find(([p, q]) => p === i || q === i);
    const b = e ? c.nodes[e[0] === i ? e[1] : e[0]] : a;
    // stand in the chamber on the far side, looking back toward the tunnel mouth
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const cx = a.x - (dx / l) * a.r * 0.5, cz = a.z - (dz / l) * a.r * 0.5;
    out.push({ name: "cave interior", x: cx, y: a.y - 0.45 * a.r + 2.2, z: cz, yaw: yawTo(cx, cz, b.x, b.z) - 15, pitch: 2 });
  } else out.push({ name: "cave (none)", x: 0, y: 30, z: 0, yaw: 0, pitch: -10 });
  // 5 ruin close-up
  const st = world.structures.find((s) => s.kind === 1 || s.kind === 0) ?? world.structures[0];
  if (st) {
    const a = st.rotY;
    const cx = st.x + Math.sin(a) * 15 + Math.cos(a) * 5, cz = st.z + Math.cos(a) * 15 - Math.sin(a) * 5;
    out.push({ name: "ruin close-up", x: cx, y: Math.max(heightAt(world, cx, cz), st.y) + 2.6, z: cz, yaw: yawTo(cx, cz, st.x, st.z), pitch: 2 });
  } else out.push({ name: "ruin (none)", x: 0, y: 30, z: 0, yaw: 0, pitch: -10 });
  // 6 mid-height coast flyover
  if (beach) out.push({ name: "coast mid-height", x: beach.x * 1.25, y: 35, z: beach.z * 1.25, yaw: yawTo(beach.x, beach.z, px, pz) + 25, pitch: -12 });
  // 7 underwater near the shore
  if (beach) {
    const ux = beach.x * 1.08, uz = beach.z * 1.08;
    out.push({ name: "underwater", x: ux, y: Math.min(-1.2, heightAt(world, ux, uz) + 1.5), z: uz, yaw: yawTo(ux, uz, px, pz), pitch: 5 });
  }
  // 8 waterfall, seen from downstream
  const wf = world.waterfalls[0];
  if (wf) {
    const dx = Math.sin(wf.dir), dz = Math.cos(wf.dir);
    const d = 14 + (wf.top - wf.bottom);
    const cx = wf.x + dx * d + dz * 4, cz = wf.z + dz * d - dx * 4;
    out.push({ name: "waterfall", x: cx, y: Math.max(heightAt(world, cx, cz), wf.bottom) + 3, z: cz, yaw: yawTo(cx, cz, wf.x, wf.z), pitch: 10 });
  } else out.push({ name: "waterfall (none)", x: 0, y: 40, z: 0, yaw: 0, pitch: -10 });
  // 9 meadow at eye level
  const meadow = find((i) => world.biome[i] === Biome.Meadow && world.path[i] === 0, (i) => -Math.abs(world.height[i] - 22) + Math.sin(i * 3.1) * 4);
  if (meadow) out.push({ name: "meadow", x: meadow.x, y: heightAt(world, meadow.x, meadow.z) + 1.7, z: meadow.z, yaw: yawTo(meadow.x, meadow.z, px, pz) + 120, pitch: 0 });
  else out.push({ name: "meadow (none)", x: 0, y: 40, z: 0, yaw: 0, pitch: -10 });
  return out;
}
