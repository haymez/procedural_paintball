// Stage 5: caves. Each cave is a small network under a massif:
//  - a main hall deep inside (two or three overlapping chambers joined by hall
//    edges, one flat floor),
//  - 2–4 entrances on hillsides / cliff bases (one may be a sea grotto opening
//    at water level), each reached by a winding tunnel; long approaches get a
//    room halfway (sometimes a second, smaller hall),
//  - ring passages between neighbouring approaches (and a bypass if that
//    fails), so there is always more than one way through,
//  - optional dead-end treasure rooms (an upgrade waits there),
//  - sometimes a skylight shaft over a chamber (a drop-in hole, also listed as
//    an entrance with sky = true),
//  - cover in every room: rock columns, boulder piles, low rock walls and
//    stalagmite groups (Cave.rocks), placed so all doorways of a room stay
//    connected; lava tubes (volcanic islands) get ledges along some tunnels.
// Rules: floor grades <= MAX_GRADE between joints; tunnels meet chambers at
// portal joints level with the chamber floor; everything stays under the
// terrain except at entrances and skylights; parts at different floor heights
// never overlap in plan; floors stay above sea level except on a grotto's
// approach.
import type { Rng } from "../../math/rng";
import { atan2, cos, sin } from "../../math/trig";
import { caveRockSdf, caveSdf, caveShellSdf, CAVE_FLOOR, CHAMBER_R, CHAMBER_SQUASH } from "../collide";
import type { Ctx } from "../context";
import { gx, N, sample, slopeAt, toI } from "../grid";
import { computeReach } from "../reach";
import { NO_WATER, type Cave, type CaveNode, type CaveRock, type World } from "../types";

interface Entr {
  x: number;
  z: number;
  floor: number;
  dx: number;
  dz: number;
  grotto: boolean;
}

const MAX_GRADE = 0.42;
const PI = 3.141592653589793;
const TAU = 6.283185307179586;
/** Radius of the joints where tunnels meet chambers. */
const PORTAL_R = 4;

const floorOf = (n: CaveNode) => (n.r >= CHAMBER_R ? n.y - 0.45 * n.r : n.y - CAVE_FLOOR * n.r);
const isCh = (n: CaveNode) => n.r >= CHAMBER_R;
const wrapA = (a: number) => {
  while (a > PI) a -= TAU;
  while (a < -PI) a += TAU;
  return a;
};
const hyp = (x: number, z: number) => Math.sqrt(x * x + z * z);

function cover(ctx: Ctx, x: number, z: number, r: number): number {
  // lowest terrain over two rings
  let m = sample(ctx.height, x, z);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU;
    const c = cos(a), s = sin(a);
    const v1 = sample(ctx.height, x + c * r, z + s * r);
    const v2 = sample(ctx.height, x + c * r * 0.55, z + s * r * 0.55);
    if (v1 < m) m = v1;
    if (v2 < m) m = v2;
  }
  return m;
}

export function cavesStage(ctx: Ctx, rng: Rng): void {
  const h = ctx.height;
  const target = rng.weighted([1, 2, 3], [0.25, 0.5, 0.25]);
  const lava = ctx.ch.climate === "lush" || ctx.ch.climate === "tropical";
  // entrances must open onto ground you can actually get to
  const reach = computeReach({ seed: ctx.seed, height: h, water: ctx.water, holes: ctx.holes, caves: [] } as unknown as World);

  // entrance candidates
  const cands: Entr[] = [];
  const grottos: Entr[] = [];
  for (let iz = 6; iz < N - 6; iz += 3)
    for (let ix = 6; ix < N - 6; ix += 3) {
      const i = iz * N + ix;
      const hv = h[i];
      if (ctx.water[i] !== NO_WATER || ctx.waterDist[i] < 10) continue;
      const x = gx(ix), z = gx(iz);
      // downhill direction
      const gxv = (h[i + 1] - h[i - 1]) / 4, gzv = (h[i + N] - h[i - N]) / 4;
      const gl = Math.sqrt(gxv * gxv + gzv * gzv);
      if (gl < 1e-4) continue;
      const dx = -gxv / gl, dz = -gzv / gl;
      const coast = ctx.coast[i];
      if (coast > 1 && coast < 9 && ctx.cliff[i] > 0.6 && hv > 4) {
        // sea grotto at the base of a cliff: floor under water
        const ex = x + dx * (coast - 1), ez = z + dz * (coast - 1);
        const inland = sample(h, x - dx * 16, z - dz * 16);
        if (inland > 12) grottos.push({ x: ex, z: ez, floor: -1.3, dx, dz, grotto: true });
        continue;
      }
      if (hv < 4 || hv > 120 || coast < 25) continue;
      const s = slopeAt(h, ix, iz);
      if (s < 0.5 || s > 1.7) continue;
      const in20 = sample(h, x - dx * 20, z - dz * 20);
      if (in20 - hv < 11) continue;
      // a walkable apron in front of the mouth, connected to the rest of the island
      if (slopeAt(h, toI(x + dx * 3), toI(z + dz * 3)) > 0.9 || slopeAt(h, toI(x + dx * 6), toI(z + dz * 6)) > 0.8) continue;
      if (!reach.at(x + dx * 5, z + dz * 5, 2)) continue;
      cands.push({ x, z, floor: hv - 0.4, dx, dz, grotto: false });
    }
  rng.shuffle(cands);
  rng.shuffle(grottos);

  const used: { x: number; z: number; r: number }[] = [];
  let grottoLeft = grottos.length > 0 && rng.chance(0.6) ? 1 : 0;

  // each cave: the best of a few successful layouts (more rooms, entrances and loops win)
  const score = (c: Cave) => {
    const ch = c.nodes.filter((n) => n.r >= CHAMBER_R).length;
    const walk = c.entrances.filter((e) => !e.sky).length;
    const loops = c.edges.length - c.nodes.length + 1;
    return ch * 2 + walk * 3 + Math.min(2, loops) * 4 + (c.shafts ? 2 : 0);
  };
  let attempt = 0;
  while (ctx.caves.length < target && attempt < 160) {
    let best: Cave | null = null, bestS = -1, bestGrotto = false;
    for (let tries = 0; attempt < 160 && tries < 5; attempt++) {
      let A: Entr;
      if (grottoLeft > 0 && attempt < 30) A = grottos[attempt % grottos.length];
      else {
        if (cands.length === 0) break;
        A = cands[rng.int(cands.length)];
      }
      let far = true;
      for (const u of used) if ((u.x - A.x) * (u.x - A.x) + (u.z - A.z) * (u.z - A.z) < u.r * u.r) far = false;
      if (!far) continue;
      const cave = new Net(ctx, rng.fork("cave" + attempt), lava).build(A, cands);
      if (!cave) continue;
      tries++;
      const sc = score(cave);
      if (sc > bestS) {
        best = cave;
        bestS = sc;
        bestGrotto = A.grotto;
      }
    }
    if (!best) break;
    if (bestGrotto) grottoLeft = 0;
    ctx.caves.push(best);
    const hub = best.nodes[0];
    used.push({ x: hub.x, z: hub.z, r: 200 });
  }

  // holes: terrain cells whose surface lies inside a cave void, plus the lower
  // cell of any steep face (cliff) that the tunnel passes through, so an
  // opening in a cliff is not covered by a stretched heightfield face.
  const tmp = { seed: ctx.seed, caves: ctx.caves } as unknown as World;
  for (const c of ctx.caves) {
    for (const e of c.entrances) {
      const R = e.sky ? 10 : 18;
      const i0 = toI(e.x - R), i1 = toI(e.x + R), j0 = toI(e.z - R), j1 = toI(e.z + R);
      for (let iz = j0; iz <= j1; iz++)
        for (let ix = i0; ix <= i1; ix++) {
          const i = iz * N + ix;
          const x = gx(ix), z = gx(iz);
          const ddx = x - e.x, ddz = z - e.z;
          if (ddx * ddx + ddz * ddz < 12 * 12) ctx.blocked[i] |= 4;
          if (caveSdf(tmp, x, h[i], z) < -0.15) {
            ctx.holes[i] = 1;
            continue;
          }
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const j = i + oz * N + ox;
            const lo = h[i], hi = h[j];
            if (hi - lo < 1.5) continue;
            const mx = x + ox, mz = z + oz; // midway between the two samples
            const steps = Math.min(20, Math.ceil((hi - lo) / 0.6));
            let cut = false;
            for (let k = 1; k < steps && !cut; k++) if (caveSdf(tmp, mx, lo + ((hi - lo) * k) / steps, mz) < -0.3) cut = true;
            if (cut) {
              ctx.holes[i] = 1;
              break;
            }
          }
        }
    }
  }
}

/** Plan-view sample of a cave part, for overlap checks. */
interface Samp {
  x: number;
  z: number;
  f: number; // floor
  r: number; // horizontal half-width
  a: number; // node indices of the part (a === b for chambers)
  b: number;
}

interface Room {
  lobes: number[];
  kind: "hall" | "room" | "treasure";
}

type PathFn = (t: number) => [number, number];

interface TunnelOpts {
  optional: boolean;
  path?: PathFn;
  rMin?: number;
  rMax?: number;
  minFloor?: number;
}

class Net {
  nodes: CaveNode[] = [];
  edges: [number, number][] = [];
  entrances: Cave["entrances"] = [];
  shafts: NonNullable<Cave["shafts"]> = [];
  rocks: CaveRock[] = [];
  spots: NonNullable<Cave["spots"]> = [];
  samp: Samp[] = [];
  rooms: Room[] = [];
  /** chamber node -> its portal nodes */
  portals = new Map<number, number[]>();
  /** entrance mouth joints */
  mouths = new Set<number>();
  /** route (entrance) records: mouth, inner joint, the room on it (or -1), a middle joint, the hub lobe it reaches */
  routes: { inner: number; room: number; mid: number; lobe: number; grotto: boolean }[] = [];
  hub = { x: 0, z: 0, floor: 0 };

  constructor(readonly ctx: Ctx, readonly rng: Rng, readonly lava: boolean) {}

  // ------------------------------------------------------------ bookkeeping
  mark(): number[] {
    return [this.nodes.length, this.edges.length, this.samp.length, this.rooms.length];
  }
  undo(m: number[]): false {
    this.nodes.length = m[0];
    this.edges.length = m[1];
    this.samp.length = m[2];
    this.rooms.length = m[3];
    for (const [k, v] of this.portals) {
      if (k >= m[0]) this.portals.delete(k);
      else this.portals.set(k, v.filter((p) => p < m[0]));
    }
    return false;
  }
  add(n: CaveNode): number {
    this.nodes.push(n);
    return this.nodes.length - 1;
  }
  link(a: number, b: number): void {
    this.edges.push([a, b]);
  }
  chamber(x: number, z: number, floor: number, r: number): number {
    return this.add({ x, y: floor + 0.45 * r, z, r });
  }

  /** Samples of edges [e0, ..) and chambers [n0, ..) */
  samplesFrom(e0: number, n0: number): Samp[] {
    const out: Samp[] = [];
    const nodes = this.nodes;
    for (let k = e0; k < this.edges.length; k++) {
      const [ia, ib] = this.edges[k];
      const A = nodes[ia], B = nodes[ib];
      const hall = isCh(A) && isCh(B);
      const ra = hall || !isCh(A) ? A.r : 4.5, rb = hall || !isCh(B) ? B.r : 4.5;
      const fa = floorOf(A), fb = floorOf(B);
      const L = hyp(B.x - A.x, B.z - A.z);
      const n = Math.max(1, Math.ceil(L / 1.5));
      for (let j = 0; j <= n; j++) {
        const t = j / n;
        out.push({ x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t, f: fa + (fb - fa) * t, r: ra + (rb - ra) * t, a: ia, b: ib });
      }
    }
    for (let i = n0; i < nodes.length; i++) if (isCh(nodes[i])) out.push({ x: nodes[i].x, z: nodes[i].z, f: floorOf(nodes[i]), r: nodes[i].r, a: i, b: i });
    return out;
  }

  /** Is a new part (samples S) compatible with everything accepted so far? */
  fits(S: Samp[], optional: boolean): boolean {
    const old = this.samp;
    const nodes = this.nodes;
    for (const P of S)
      for (const Q of old) {
        if (P.a === Q.a || P.a === Q.b || P.b === Q.a || P.b === Q.b) continue;
        const dx = P.x - Q.x, dz = P.z - Q.z;
        const lim = (P.r + Q.r) * 0.9 + (optional ? 2.5 : 0);
        if (dx * dx + dz * dz >= lim * lim) continue;
        const df = P.f - Q.f;
        if (df > 1.8 || df < -1.8) return false;
        if (!optional) continue;
        // optional parts may only merge with others around a chamber they both open into
        let shared = false;
        for (let i = 0; i < nodes.length && !shared; i++) {
          const n = nodes[i];
          if (!isCh(n)) continue;
          const lim2 = n.r * 1.45 + 4;
          const px = P.x - n.x, pz = P.z - n.z, qx = Q.x - n.x, qz = Q.z - n.z;
          if (px * px + pz * pz < lim2 * lim2 && qx * qx + qz * qz < lim2 * lim2) shared = true;
        }
        if (!shared) return false;
      }
    return true;
  }
  /** Accept everything added since mark m if it fits; otherwise roll back. */
  commit(m: number[], optional: boolean): boolean {
    const S = this.samplesFrom(m[1], m[0]);
    // never under a river or lake: the sim would think the cave is flooded
    const wd = this.ctx.waterDist;
    for (const s of S) if (wd[toI(s.z) * N + toI(s.x)] < s.r + 3) return this.undo(m);
    if (!this.fits(S, optional)) return this.undo(m);
    for (const s of S) this.samp.push(s);
    return true;
  }

  coverOk(x: number, z: number, floor: number, r: number, ch: boolean): boolean {
    const ceil = ch ? floor + r / CHAMBER_SQUASH + 0.45 * r : floor + (1 + CAVE_FLOOR) * r;
    return cover(this.ctx, x, z, ch ? r + 4 : r + 2) >= ceil + (ch ? 4 : 3.5);
  }
  /** Deepest floor a chamber of radius r can have at (x, z) with enough rock above. */
  maxFloor(x: number, z: number, r: number): number {
    return cover(this.ctx, x, z, r + 4) - 1.25 * r - 4;
  }

  // ------------------------------------------------------------ tunnels
  /** Joint where a tunnel leaves chamber c toward (tx, tz), level with the chamber floor. */
  portal(c: number, tx: number, tz: number): number {
    const C = this.nodes[c];
    let ang = atan2(tx - C.x, tz - C.z);
    const others = (this.portals.get(c) ?? []).map((p) => atan2(this.nodes[p].x - C.x, this.nodes[p].z - C.z));
    const minSep = 0.8;
    let ok = false;
    for (const d of [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75]) {
      const a = ang + d;
      if (others.every((o) => Math.abs(wrapA(a - o)) >= minSep)) {
        ang = a;
        ok = true;
        break;
      }
    }
    if (!ok) return -1;
    const fl = floorOf(C);
    const x = C.x + sin(ang) * C.r * 0.86, z = C.z + cos(ang) * C.r * 0.86;
    if (!this.coverOk(x, z, fl, PORTAL_R, false)) return -1;
    const p = this.add({ x, y: fl + CAVE_FLOOR * PORTAL_R, z, r: PORTAL_R });
    this.link(c, p);
    const l = this.portals.get(c) ?? [];
    l.push(p);
    this.portals.set(c, l);
    return p;
  }

  /** Winding tunnel from node i to node j (either may be a chamber). */
  tunnel(i: number, j: number, o: TunnelOpts): boolean {
    const rng = this.rng, ctx = this.ctx;
    const m = this.mark();
    const P = this.nodes[i], Q = this.nodes[j];
    let path = o.path;
    if (!path) {
      const dx = Q.x - P.x, dz = Q.z - P.z, D = hyp(dx, dz) || 1;
      const px = -dz / D, pz = dx / D;
      const wob = rng.range(4, 12) * (rng.chance(0.5) ? 1 : -1) * Math.min(1, D / 60);
      const ph = rng.range(0, 3);
      path = (t) => {
        const off = wob * sin(t * PI) + 2.2 * sin(ph + t * 8) * sin(t * PI);
        return [P.x + dx * t + px * off, P.z + dz * t + pz * off];
      };
    }
    // path length and the parameters where the portals sit
    const pts: [number, number][] = [];
    for (let k = 0; k <= 32; k++) pts.push(path(k / 32));
    const cum = [0];
    for (let k = 1; k <= 32; k++) cum.push(cum[k - 1] + hyp(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const L = cum[32];
    const tAt = (d: number) => {
      for (let k = 1; k <= 32; k++) if (cum[k] >= d) return (k - 1 + (d - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1])) / 32;
      return 1;
    };
    const t0 = isCh(P) ? tAt(P.r * 0.86) : 0, t1 = isCh(Q) ? tAt(L - Q.r * 0.86) : 1;
    if (t1 - t0 < 0.05 || L * (t1 - t0) < 6) return this.undo(m);
    let a = i, b = j;
    if (isCh(P)) {
      const [x, z] = path(t0);
      a = this.portal(i, x, z);
      if (a < 0) return this.undo(m);
    }
    if (isCh(Q)) {
      const [x, z] = path(t1);
      b = this.portal(j, x, z);
      if (b < 0) return this.undo(m);
    }
    const fa = floorOf(this.nodes[a]), fb = floorOf(this.nodes[b]);
    const span = L * (t1 - t0);
    const steps = Math.max(1, Math.round(span / 11));
    const minF = o.minFloor ?? 1;
    let prev = a, prevF = fa;
    for (let k = 1; k < steps; k++) {
      const t = t0 + ((t1 - t0) * k) / steps;
      const [x, z] = path(t);
      const r = rng.range(o.rMin ?? 3.0, o.rMax ?? 4.1);
      let fl = fa + ((fb - fa) * k) / steps + rng.range(-0.5, 0.5);
      // ensure cover: push the floor down if needed (within grade)
      const g = cover(ctx, x, z, r + 2);
      const need = fl + (1 + CAVE_FLOOR) * r + 3.5;
      if (g < need) fl -= need - g;
      const pn = this.nodes[prev];
      const hd = hyp(x - pn.x, z - pn.z);
      if (Math.abs(fl - prevF) > MAX_GRADE * hd) return this.undo(m);
      if (fl < minF) return this.undo(m);
      const n = this.add({ x, y: fl + CAVE_FLOOR * r, z, r });
      this.link(prev, n);
      prev = n;
      prevF = fl;
    }
    const B = this.nodes[b], pn = this.nodes[prev];
    if (Math.abs(fb - prevF) > MAX_GRADE * Math.max(1, hyp(B.x - pn.x, B.z - pn.z))) return this.undo(m);
    this.link(prev, b);
    return this.commit(m, o.optional);
  }

  // ------------------------------------------------------------ layout
  build(A: Entr, cands: Entr[]): Cave | null {
    if (!this.placeHub(A)) return null;
    const others = this.pickEntrances(A, cands);
    if (others.length === 0) return null;
    for (const E of [A, ...others]) if (!this.route(E)) return null;
    const walk = this.entrances.length;
    const loops = this.rings();
    if (loops === 0 && walk >= 3) return null;
    this.treasure();
    this.skylight();
    const cave: Cave = { nodes: this.nodes, edges: this.edges, entrances: this.entrances, style: this.lava ? "lava" : "karst" };
    if (this.shafts.length) cave.shafts = this.shafts;
    if (!this.validate(cave)) return null;
    this.cover(cave);
    if (this.rocks.length) cave.rocks = this.rocks;
    this.placeSpots(cave);
    cave.spots = this.spots;
    return cave;
  }

  /** Main hall inward from A: 2–3 overlapping chambers on one floor. */
  placeHub(A: Entr): boolean {
    const rng = this.rng;
    const R = A.grotto ? rng.range(8.5, 10) : rng.range(9.5, 12.5);
    let hx = 0, hz = 0, floor = 0, bestM = -1e9;
    const baseAng = atan2(-A.dx, -A.dz);
    for (let k = 0; k < 16; k++) {
      const ang = baseAng + rng.range(-0.6, 0.6);
      const L = rng.range(A.grotto ? 40 : 48, A.grotto ? 95 : 115);
      const x = A.x + sin(ang) * L, z = A.z + cos(ang) * L;
      const minFloor = A.grotto ? 1.2 : A.floor - MAX_GRADE * 0.6 * L;
      const maxFloor = A.floor + MAX_GRADE * 0.6 * L;
      let f = A.floor + rng.range(-0.15, 0.25) * L;
      if (f < minFloor) f = minFloor;
      if (f > maxFloor) f = maxFloor;
      const top = this.maxFloor(x, z, R + 6);
      if (f > top) f = top;
      if (f < minFloor || f > maxFloor || f < 1.2) continue;
      const m = top - f + rng.range(0, 3);
      if (m > bestM) {
        bestM = m;
        hx = x;
        hz = z;
        floor = f;
      }
    }
    if (bestM < -1e8) return false;
    this.hub = { x: hx, z: hz, floor };
    const m = this.mark();
    const n0 = this.chamber(hx, hz, floor, R);
    this.rooms.push({ lobes: [n0], kind: "hall" });
    // extra lobes make the hall long and irregular
    const extra = A.grotto ? 1 : rng.chance(0.55) ? 2 : 1;
    const toA = atan2(A.x - hx, A.z - hz);
    let last = n0;
    for (let e = 0; e < extra; e++) {
      const bi = e === 0 ? n0 : rng.chance(0.5) ? n0 : last;
      const base = this.nodes[bi];
      for (let tries = 0; tries < 8; tries++) {
        const r = rng.range(7.5, 10);
        const ang = toA + PI * 0.5 * (rng.chance(0.5) ? 1 : -1) + rng.range(-1.1, 1.1) + (e === 1 ? PI * 0.6 : 0);
        const d = (base.r + r) * rng.range(0.62, 0.85);
        const x = base.x + sin(ang) * d, z = base.z + cos(ang) * d;
        if (this.maxFloor(x, z, r) < floor) continue;
        // keep lobes from stacking on each other
        let clash = false;
        for (const li of this.rooms[0].lobes) {
          const L = this.nodes[li];
          if (li !== bi && hyp(L.x - x, L.z - z) < (L.r + r) * 0.75) clash = true;
        }
        if (clash) continue;
        const li = this.chamber(x, z, floor, r);
        this.link(bi, li);
        this.rooms[0].lobes.push(li);
        last = li;
        break;
      }
    }
    return this.commit(m, false);
  }

  pickEntrances(A: Entr, cands: Entr[]): Entr[] {
    const rng = this.rng;
    const { x: hx, z: hz, floor } = this.hub;
    const R = this.nodes[0].r;
    const others: Entr[] = [];
    const angs = [atan2(A.x - hx, A.z - hz)];
    const want = rng.weighted([1, 2, 3], [0.2, 0.45, 0.35]);
    const order = cands.slice();
    rng.shuffle(order);
    const otherCaves = this.ctx.caves;
    for (const B of order) {
      if (others.length >= want) break;
      const dx = B.x - hx, dz = B.z - hz;
      const d = hyp(dx, dz);
      if (d < 48 || d > 175) continue;
      const aB = atan2(dx, dz);
      if (angs.some((a) => Math.abs(wrapA(aB - a)) < 0.95)) continue;
      if ((B.dx * dx + B.dz * dz) / d < 0.3) continue; // must face away from the hub
      if (Math.abs(B.floor - floor) > MAX_GRADE * 0.7 * (d - R)) continue;
      if (hyp(B.x - A.x, B.z - A.z) < 45) continue;
      let near = false;
      for (const c of otherCaves) for (const e of c.entrances) if (hyp(e.x - B.x, e.z - B.z) < 60) near = true;
      if (near) continue;
      others.push(B);
      angs.push(aB);
    }
    return others;
  }

  /** Entrance E → (room) → nearest hub lobe. */
  route(E: Entr): boolean {
    const rng = this.rng;
    const m = this.mark();
    const r0 = E.grotto ? 3.8 : rng.range(3.2, 3.9);
    // mouth joint slightly outside the slope so the tube breaks the surface
    const mouth = this.add({ x: E.x + E.dx * 1.0, y: E.floor + CAVE_FLOOR * r0, z: E.z + E.dz * 1.0, r: r0 });
    const ri = rng.range(3.1, 3.7);
    const fi = E.floor + (E.grotto ? 0.6 : rng.range(-0.3, 1.0));
    const inner = this.add({ x: E.x - E.dx * 9, y: fi + CAVE_FLOOR * ri, z: E.z - E.dz * 9, r: ri });
    this.link(mouth, inner);
    if (!this.commit(m, false)) return false;
    // nearest hub lobe
    let lobe = this.rooms[0].lobes[0], bd = 1e9;
    for (const li of this.rooms[0].lobes) {
      const L = this.nodes[li];
      const d = hyp(L.x - E.x, L.z - E.z);
      if (d < bd) {
        bd = d;
        lobe = li;
      }
    }
    const I = this.nodes[inner], Lb = this.nodes[lobe];
    const D = hyp(Lb.x - I.x, Lb.z - I.z);
    const minFloor = E.grotto ? -1.5 : 1;
    let room = -1;
    if (D > 85 && rng.chance(0.85)) room = this.routeRoom(I, Lb, fi, D);
    let mid = -1;
    if (room >= 0) {
      const m2 = this.mark();
      if (!this.tunnel(inner, room, { optional: false, minFloor })) return this.undo(m);
      mid = this.nodes.length > m2[0] ? m2[0] + Math.floor((this.nodes.length - m2[0]) / 2) : -1;
      if (!this.tunnel(room, lobe, { optional: false })) return this.undo(m);
    } else {
      const m2 = this.mark();
      if (!this.tunnel(inner, lobe, { optional: false, minFloor, rMax: 4.2 })) return this.undo(m);
      mid = m2[0] + Math.floor((this.nodes.length - m2[0]) / 2);
    }
    if (mid >= 0 && isCh(this.nodes[mid])) mid = -1;
    this.entrances.push({ x: E.x, y: floorOf(this.nodes[mouth]), z: E.z, dx: E.dx, dz: E.dz });
    this.routes.push({ inner, room, mid, lobe, grotto: E.grotto });
    this.mouths.add(mouth);
    return true;
  }

  /** A room (sometimes a two-lobe hall) about halfway along a long approach. */
  routeRoom(I: CaveNode, Lb: CaveNode, fi: number, D: number): number {
    const rng = this.rng;
    const F = floorOf(Lb);
    const dx = I.x - Lb.x, dz = I.z - Lb.z;
    const px = -dz / D, pz = dx / D;
    for (let tries = 0; tries < 5; tries++) {
      const t = rng.range(0.4, 0.6), off = rng.range(-12, 12);
      const x = Lb.x + dx * t + px * off, z = Lb.z + dz * t + pz * off;
      const r = rng.range(7.2, 9.2);
      const d1 = hyp(x - Lb.x, z - Lb.z), d2 = hyp(I.x - x, I.z - z);
      let f = F + ((fi - F) * d1) / (d1 + d2) + rng.range(-1, 1);
      const top = this.maxFloor(x, z, r);
      if (f > top) f = top;
      if (f < 1.2) continue;
      if (Math.abs(f - F) > MAX_GRADE * 0.8 * (d1 - 0.86 * (Lb.r + r))) continue;
      if (Math.abs(f - fi) > MAX_GRADE * 0.8 * (d2 - 0.86 * r)) continue;
      const m = this.mark();
      const c = this.chamber(x, z, f, r);
      const room: Room = { lobes: [c], kind: "room" };
      // long approaches sometimes widen into a second hall
      if (D > 120 && rng.chance(0.45)) {
        const r2 = rng.range(7.2, 9);
        const s = rng.chance(0.5) ? 1 : -1;
        const x2 = x + px * s * (r + r2) * 0.7, z2 = z + pz * s * (r + r2) * 0.7;
        if (this.maxFloor(x2, z2, r2) >= f) {
          const c2 = this.chamber(x2, z2, f, r2);
          this.link(c, c2);
          room.kind = "hall";
          room.lobes.push(c2);
        }
      }
      this.rooms.push(room);
      if (this.commit(m, false)) return c;
    }
    return -1;
  }

  /** Ring passages between neighbouring approaches; returns the number of loops made. */
  rings(): number {
    const rng = this.rng;
    const { x: hx, z: hz } = this.hub;
    const anchors = this.routes
      .map((r) => (r.room >= 0 ? r.room : r.mid))
      .filter((a) => a >= 0)
      .map((a) => ({ a, ang: atan2(this.nodes[a].x - hx, this.nodes[a].z - hz), rad: hyp(this.nodes[a].x - hx, this.nodes[a].z - hz) }));
    anchors.sort((p, q) => p.ang - q.ang);
    let loops = 0;
    const hubR = Math.max(...this.rooms[0].lobes.map((l) => hyp(this.nodes[l].x - hx, this.nodes[l].z - hz) + this.nodes[l].r));
    const pairs: [number, number][] = [];
    if (anchors.length === 2) pairs.push([0, 1]);
    else for (let k = 0; k < anchors.length; k++) pairs.push([k, (k + 1) % anchors.length]);
    rng.shuffle(pairs);
    for (const [p, q] of pairs) {
      if (loops >= 2) break;
      const P = anchors[p], Q = anchors[q];
      // go the short way around the hub
      const da = wrapA(Q.ang - P.ang);
      if (Math.abs(da) > 2.5) continue;
      const r0 = Math.max(P.rad, hubR + 14), r1 = Math.max(Q.rad, hubR + 14);
      const bulge = rng.range(4, 14);
      const Pn = this.nodes[P.a], Qn = this.nodes[Q.a];
      const path: PathFn = (t) => {
        if (t <= 0) return [Pn.x, Pn.z];
        if (t >= 1) return [Qn.x, Qn.z];
        const a = P.ang + da * t;
        // blend from the anchor out onto the arc and back in
        const w = sin(t * PI);
        const rr = (P.rad + (Q.rad - P.rad) * t) * (1 - w) + (r0 + (r1 - r0) * t + bulge) * w;
        return [hx + sin(a) * rr, hz + cos(a) * rr];
      };
      const len = Math.abs(da) * (r0 + r1) * 0.5;
      if (len < 25 || len > 170) continue;
      if (this.tunnel(P.a, Q.a, { optional: true, path })) loops++;
    }
    if (loops > 0) return loops;
    // bypass: a second, strongly curving passage from an approach to another doorway of the hall
    for (const r of this.routes) {
      const a = r.room >= 0 ? r.room : r.mid >= 0 ? r.mid : r.inner;
      for (const s of [1, -1]) {
        const A = this.nodes[a];
        const lobes = this.rooms[0].lobes;
        const L = lobes[rng.int(lobes.length)];
        const B = this.nodes[L];
        const dx = B.x - A.x, dz = B.z - A.z, D = hyp(dx, dz) || 1;
        if (D < 35) continue;
        const px = -dz / D, pz = dx / D;
        const wob = s * rng.range(18, 28);
        const path: PathFn = (t) => [A.x + dx * t + px * wob * sin(t * PI), A.z + dz * t + pz * wob * sin(t * PI)];
        if (this.tunnel(a, L, { optional: true, path })) return 1;
      }
    }
    return 0;
  }

  /** Dead-end side rooms worth the detour. */
  treasure(): void {
    const rng = this.rng;
    const want = rng.weighted([0, 1, 2], [0.2, 0.55, 0.25]);
    let made = 0;
    const anchors: number[] = [];
    for (const r of this.routes) {
      if (r.room >= 0) anchors.push(r.room);
      if (r.mid >= 0) anchors.push(r.mid);
    }
    anchors.push(...this.rooms[0].lobes);
    rng.shuffle(anchors);
    for (const a of anchors) {
      if (made >= want) break;
      const A = this.nodes[a];
      const fa = floorOf(A);
      for (let tries = 0; tries < 6; tries++) {
        const ang = rng.range(0, TAU);
        const len = rng.range(26, 42) + (isCh(A) ? A.r : 0);
        const x = A.x + sin(ang) * len, z = A.z + cos(ang) * len;
        const r = rng.range(7, 8.4);
        let f = fa + rng.range(-0.25, 0.25) * MAX_GRADE * len;
        const top = this.maxFloor(x, z, r);
        if (f > top) f = top;
        if (f < 1.2 || Math.abs(f - fa) > MAX_GRADE * 0.75 * (len - 0.86 * r - (isCh(A) ? 0.86 * A.r : 0))) continue;
        const m = this.mark();
        const c = this.chamber(x, z, f, r);
        this.rooms.push({ lobes: [c], kind: "treasure" });
        if (!this.commit(m, true)) continue;
        if (this.tunnel(a, c, { optional: true, rMin: 2.9, rMax: 3.6 })) {
          made++;
          break;
        }
        this.undo(m);
      }
    }
  }

  /** Sometimes a shaft of daylight: a hole from the surface into a chamber's roof. */
  skylight(): void {
    const rng = this.rng, ctx = this.ctx, h = ctx.height;
    if (!rng.chance(0.6)) return;
    const lobes: number[] = [];
    for (const r of this.rooms) for (const l of r.lobes) if (this.nodes[l].r >= 8.2) lobes.push(l);
    rng.shuffle(lobes);
    for (const li of lobes) {
      const C = this.nodes[li];
      for (let tries = 0; tries < 5; tries++) {
        const a = rng.range(0, TAU), d = C.r * rng.range(0.25, 0.5);
        const x = C.x + sin(a) * d, z = C.z + cos(a) * d;
        const ceil = C.y + Math.sqrt(C.r * C.r - d * d) / CHAMBER_SQUASH;
        const g = sample(h, x, z);
        if (g - ceil < 4 || g - ceil > 30) continue;
        const ix = toI(x), iz = toI(z);
        if (slopeAt(h, ix, iz) > 0.55) continue;
        // dry, gentle ground around the hole, away from the other openings
        let ok = true;
        for (let k = 0; k < 12 && ok; k++) {
          const b = (k / 12) * TAU;
          const i = toI(z + cos(b) * 9) * N + toI(x + sin(b) * 9);
          if (ctx.water[i] !== NO_WATER || h[i] < 3 || Math.abs(h[i] - g) > 5) ok = false;
        }
        for (const e of this.entrances) if (hyp(e.x - x, e.z - z) < 30) ok = false;
        if (!ok) continue;
        const r = rng.range(2.3, 3.0);
        this.shafts.push({ x, z, y0: ceil - 2, y1: g + 4, r });
        const gxv = sample(h, x + 1, z) - sample(h, x - 1, z), gzv = sample(h, x, z + 1) - sample(h, x, z - 1);
        const gl = hyp(gxv, gzv);
        const dx = gl > 1e-3 ? -gxv / gl : sin(a), dz = gl > 1e-3 ? -gzv / gl : cos(a);
        const l = hyp(dx, dz);
        this.entrances.push({ x, y: g, z, dx: dx / l, dz: dz / l, sky: true });
        return;
      }
    }
  }

  /** Underground except at openings, openings on the surface, parts at different floors never overlap in plan. */
  validate(cave: Cave): boolean {
    const ctx = this.ctx, h = ctx.height;
    const tmp = { seed: ctx.seed, caves: [cave] } as unknown as World;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const n of cave.nodes) {
      if (Math.abs(n.x) > 480 || Math.abs(n.z) > 480) return false;
      x0 = Math.min(x0, n.x - n.r - 2);
      x1 = Math.max(x1, n.x + n.r + 2);
      z0 = Math.min(z0, n.z - n.r - 2);
      z1 = Math.max(z1, n.z + n.r + 2);
    }
    // keep clear of the other caves
    for (const c of ctx.caves)
      for (const a of c.nodes)
        for (const b of cave.nodes) if (hyp(a.x - b.x, a.z - b.z) < a.r + b.r + 20) return false;
    const open = cave.entrances.map((e) => ({ x: e.x, z: e.z, r: e.sky ? 5 : 16 }));
    for (let iz = toI(z0); iz <= toI(z1); iz++)
      for (let ix = toI(x0); ix <= toI(x1); ix++) {
        const x = gx(ix), z = gx(iz);
        // near an opening breaching is expected
        let nearE = false;
        for (const e of open) if ((x - e.x) * (x - e.x) + (z - e.z) * (z - e.z) < e.r * e.r) nearE = true;
        if (nearE) continue;
        // test a little above the surface too, to keep a solid roof
        if (caveSdf(tmp, x, h[iz * N + ix] - 1.5, z) < 0) return false;
      }
    // entrances must sit on the surface
    for (const e of cave.entrances) {
      const t = sample(h, e.x, e.z);
      if (Math.abs(t - e.y) > 2.5 && e.y > 0) return false;
    }
    // final overlap check over everything
    const S = this.samplesFrom(0, 0);
    for (let p = 0; p < S.length; p++)
      for (let q = p + 1; q < S.length; q++) {
        const P = S[p], Q = S[q];
        if (P.a === Q.a || P.a === Q.b || P.b === Q.a || P.b === Q.b) continue;
        const dx = P.x - Q.x, dz = P.z - Q.z;
        const rr = (P.r + Q.r) * 0.9;
        if (dx * dx + dz * dz >= rr * rr) continue;
        const df = P.f - Q.f;
        if (df > 1.8 || df < -1.8) return false;
      }
    return true;
  }

  // ------------------------------------------------------------ cover
  /** Rock features in every room, and ledges along lava tubes. */
  cover(cave: Cave): void {
    const rng = this.rng;
    const world = { seed: this.ctx.seed, caves: [...this.ctx.caves, cave] } as unknown as World;
    for (const room of this.rooms) this.coverRoom(world, room);
    if (this.lava) {
      // lava tubes: benches left along the walls by old flow levels
      for (const [ia, ib] of this.edges) {
        const A = this.nodes[ia], B = this.nodes[ib];
        if (isCh(A) || isCh(B) || A.r < 3.3 || B.r < 3.3 || A.r === PORTAL_R || B.r === PORTAL_R) continue;
        if (this.mouths.has(ia) || this.mouths.has(ib)) continue;
        const L = hyp(B.x - A.x, B.z - A.z);
        if (L < 8 || !rng.chance(0.35)) continue;
        const s = rng.chance(0.5) ? 1 : -1;
        const px = (-(B.z - A.z) / L) * s, pz = ((B.x - A.x) / L) * s;
        const hgt = rng.range(1.0, 1.5), rr = rng.range(0.45, 0.6);
        const at = (u: number) => {
          const x = A.x + (B.x - A.x) * u, z = A.z + (B.z - A.z) * u;
          const f = floorOf(A) + (floorOf(B) - floorOf(A)) * u;
          const r = A.r + (B.r - A.r) * u;
          return [x + px * (r - 0.15), f + hgt, z + pz * (r - 0.15)];
        };
        const [ax, ay, az] = at(0.18), [bx, by, bz] = at(0.82);
        this.rocks.push({ ax, ay, az, bx, by, bz, ra: rr, rb: rr * rng.range(0.8, 1.1), shell: true });
      }
    }
  }

  coverRoom(world: World, room: Room): void {
    const rng = this.rng, lava = this.lava;
    const lobes = room.lobes.map((l) => this.nodes[l]);
    const F = floorOf(lobes[0]);
    // keep-clear points: lobe centers (pickups), doorways
    const doors: [number, number][] = [];
    for (const l of room.lobes)
      for (const p of this.portals.get(l) ?? []) {
        const P = this.nodes[p], C = this.nodes[l];
        doors.push([C.x + (P.x - C.x) * 0.8, C.z + (P.z - C.z) * 0.8]);
      }
    const centers: [number, number][] = lobes.map((n) => [n.x, n.z]);
    // 1 m grid over the room for the doorway connectivity check
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const n of lobes) {
      x0 = Math.min(x0, n.x - n.r);
      x1 = Math.max(x1, n.x + n.r);
      z0 = Math.min(z0, n.z - n.r);
      z1 = Math.max(z1, n.z + n.r);
    }
    x0 = Math.floor(x0);
    z0 = Math.floor(z0);
    const W = Math.ceil(x1 - x0) + 1, H = Math.ceil(z1 - z0) + 1;
    const free = new Uint8Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const x = x0 + i + 0.5, z = z0 + j + 0.5;
        free[j * W + i] = caveShellSdf(world, x, F + 1.3, z) < -0.55 && caveShellSdf(world, x, F + 2.0, z) < -0.5 ? 1 : 0;
      }
    const cellOf = (x: number, z: number) => {
      const i = Math.floor(x - x0), j = Math.floor(z - z0);
      return i >= 0 && j >= 0 && i < W && j < H ? j * W + i : -1;
    };
    let seeds = [...centers, ...doors, ...this.passingNear(lobes)].map(([x, z]) => cellOf(x, z)).filter((c) => c >= 0 && free[c]);
    const blocked = new Uint8Array(W * H);
    const q = new Int32Array(W * H);
    const flood = (blk: Uint8Array): Uint8Array => {
      const seen = new Uint8Array(W * H);
      let qh = 0, qt = 0;
      q[qt++] = seeds[0];
      seen[seeds[0]] = 1;
      while (qh < qt) {
        const c = q[qh++];
        const i = c % W, j = (c / W) | 0;
        if (i > 0 && !seen[c - 1] && free[c - 1] && !blk[c - 1]) { seen[c - 1] = 1; q[qt++] = c - 1; }
        if (i < W - 1 && !seen[c + 1] && free[c + 1] && !blk[c + 1]) { seen[c + 1] = 1; q[qt++] = c + 1; }
        if (j > 0 && !seen[c - W] && free[c - W] && !blk[c - W]) { seen[c - W] = 1; q[qt++] = c - W; }
        if (j < H - 1 && !seen[c + W] && free[c + W] && !blk[c + W]) { seen[c + W] = 1; q[qt++] = c + W; }
      }
      return seen;
    };
    if (seeds.length === 0) return;
    // only doorways that are connected without any rocks have to stay connected
    const base = flood(blocked);
    seeds = seeds.filter((s) => base[s]);
    const connected = (extra: CaveRock[]): boolean => {
      // mark the cells the new rocks take (with body clearance), flood from the first seed
      const blk = blocked.slice();
      for (const r of extra) {
        const rad = Math.max(r.ra, r.rb) + 1.2;
        const i0 = Math.floor(Math.min(r.ax, r.bx) - rad - x0), i1 = Math.ceil(Math.max(r.ax, r.bx) + rad - x0);
        const j0 = Math.floor(Math.min(r.az, r.bz) - rad - z0), j1 = Math.ceil(Math.max(r.az, r.bz) + rad - z0);
        for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++)
          for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
            const x = x0 + i + 0.5, z = z0 + j + 0.5;
            if (caveRockSdf(r, x, F + 1.3, z) < 0.85 || caveRockSdf(r, x, F + 0.4, z) < 0.6) blk[j * W + i] = 1;
          }
      }
      for (const s of seeds) if (blk[s]) return false;
      const seen = flood(blk);
      for (const s of seeds) if (!seen[s]) return false;
      blocked.set(blk);
      return true;
    };
    const ceilAt = (x: number, z: number) => {
      let y = F + 1.5;
      while (y < F + 30 && caveShellSdf(world, x, y, z) < -0.2) y += 0.5;
      return y;
    };
    const spot = (minR: number, maxR: number, keep: number): [number, number] | null => {
      for (let t = 0; t < 10; t++) {
        const n = lobes[rng.int(lobes.length)];
        const a = rng.range(0, TAU), d = n.r * rng.range(minR, maxR);
        const x = n.x + sin(a) * d, z = n.z + cos(a) * d;
        if (centers.some(([cx, cz]) => hyp(cx - x, cz - z) < 2 + keep * 0.6)) continue;
        if (doors.some(([cx, cz]) => hyp(cx - x, cz - z) < 2.5 + keep * 0.6)) continue;
        const c = cellOf(x, z);
        if (c < 0 || !free[c] || blocked[c]) continue;
        return [x, z];
      }
      return null;
    };
    const big = room.kind === "hall" || lobes[0].r >= 9.5;
    const nCol = big ? rng.int(2) + (lava ? 1 : 2) : rng.chance(lobes[0].r >= 8 ? 0.75 : 0.4) ? 1 : 0;
    const nPile = big ? rng.int(2) + (lava ? 3 : 2) : rng.int(2) + 1;
    const nWall = big ? rng.int(2) + 1 : rng.chance(0.5) ? 1 : 0;
    const nMite = lava ? (rng.chance(0.4) ? 1 : 0) : big ? rng.int(3) + 3 : rng.int(2) + 1;
    // portal joints and the points just inside them stay clear, and so do the lobe centers (pickups)
    const keep: [number, number, number][] = [];
    for (const [x, z] of centers) keep.push([x, z, 1.8]);
    for (const [x, z] of doors) keep.push([x, z, 2.5]);
    for (const l of room.lobes) for (const p of this.portals.get(l) ?? []) keep.push([this.nodes[p].x, this.nodes[p].z, 2.8]);
    // tunnels running through or past the room keep their way clear too
    for (const n of this.nodes) if (!isCh(n) && lobes.some((L) => hyp(L.x - n.x, L.z - n.z) < L.r + n.r + 3)) keep.push([n.x, n.z, n.r * 0.5 + 0.8]);
    const clearOf = (rs: CaveRock[]) => {
      for (const r of rs) for (const [x, z, d] of keep) if (caveRockSdf(r, x, F + 1, z) < d || caveRockSdf(r, x, F + 0.3, z) < d) return false;
      // the floor under a skylight stays open (and nothing grows up the shaft)
      for (const r of rs)
        for (const sh of this.shafts) {
          const lim = sh.r + 3 + Math.max(r.ra, r.rb);
          if (hyp(r.ax - sh.x, r.az - sh.z) < lim || hyp(r.bx - sh.x, r.bz - sh.z) < lim) return false;
        }
      return true;
    };
    const tryAdd = (make: () => CaveRock[] | null) => {
      for (let t = 0; t < 10; t++) {
        const rs = make();
        if (!rs || !clearOf(rs)) continue;
        if (connected(rs)) {
          for (const r of rs) this.rocks.push(r);
          return;
        }
      }
    };
    // floor-to-ceiling columns (hourglass: two cones meeting at a waist)
    for (let k = 0; k < nCol; k++)
      tryAdd(() => {
        const p = spot(0.25, 0.6, 2);
        if (!p) return null;
        const [x, z] = p;
        const C = ceilAt(x, z);
        if (C - F < 5 || C - F > 22) return null;
        const rb = lava ? rng.range(1.9, 2.6) : rng.range(1.5, 2.2);
        const rw = lava ? rng.range(1.3, 1.9) : rng.range(0.8, 1.25);
        const rt = rng.range(1.4, 2.3);
        const ym = F + (C - F) * rng.range(0.4, 0.6);
        const wx = x + rng.range(-0.4, 0.4), wz = z + rng.range(-0.4, 0.4);
        return [
          { ax: x, ay: F - 0.6, az: z, bx: wx, by: ym, bz: wz, ra: rb, rb: rw, shell: true },
          { ax: wx, ay: ym, az: wz, bx: x + rng.range(-0.6, 0.6), by: C + 0.8, bz: z + rng.range(-0.6, 0.6), ra: rw, rb: rt, shell: true },
        ];
      });
    // boulder piles: a big block (part of the walls) with smaller ones leaning on it;
    // the first ones in a hall are fallen ceiling slabs taller than a player
    for (let k = 0; k < nPile; k++)
      tryAdd(() => {
        const slab = big && k < 2;
        const p = spot(0.2, 0.75, slab ? 2.5 : 1.5);
        if (!p) return null;
        const [x, z] = p;
        const rm = slab ? rng.range(1.5, 2.1) : rng.range(1.1, 1.6);
        const a = rng.range(0, TAU), l = slab ? rng.range(1.5, 3.5) : rng.range(0, 1.5);
        const out: CaveRock[] = [{
          ax: x - sin(a) * l * 0.5, ay: F + rm * rng.range(0.35, 0.6), az: z - cos(a) * l * 0.5,
          bx: x + sin(a) * l * 0.5, by: F + rm * rng.range(0.3, 0.55), bz: z + cos(a) * l * 0.5,
          ra: rm, rb: rm * rng.range(0.75, 1), shell: true,
        }];
        const ns = rng.int(3) + 1;
        for (let s = 0; s < ns; s++) {
          const b = rng.range(0, TAU), rs = rng.range(0.4, 0.85);
          const d = rm + rs * rng.range(0.2, 0.6);
          const sx = x + sin(b) * d, sz = z + cos(b) * d;
          out.push({ ax: sx, ay: F + rs * 0.45, az: sz, bx: sx, by: F + rs * 0.45, bz: sz, ra: rs, rb: rs, shell: false });
        }
        return out;
      });
    // low rock walls (rimstone dams / lava ridges): waist-high cover you can vault
    for (let k = 0; k < nWall; k++)
      tryAdd(() => {
        const p = spot(0.25, 0.7, 1.5);
        if (!p) return null;
        const [x, z] = p;
        const a = rng.range(0, TAU), l1 = rng.range(2, 3.4), l2 = rng.range(2, 3.4);
        const a2 = a + rng.range(-0.6, 0.6);
        const r = rng.range(0.75, 1.0), y = F + rng.range(0.05, 0.3);
        const mx = x + sin(a) * l1, mz = z + cos(a) * l1;
        return [
          { ax: x, ay: y, az: z, bx: mx, by: y + rng.range(-0.1, 0.1), bz: mz, ra: r * rng.range(0.85, 1), rb: r, shell: true },
          { ax: mx, ay: y, az: mz, bx: mx + sin(a2) * l2, by: y + rng.range(-0.15, 0.05), bz: mz + cos(a2) * l2, ra: r, rb: r * rng.range(0.7, 0.95), shell: true },
        ];
      });
    // stalagmite groups (mostly karst): cones a few metres tall
    for (let k = 0; k < nMite; k++)
      tryAdd(() => {
        const p = spot(0.3, 0.8, 1);
        if (!p) return null;
        const [x, z] = p;
        const C = ceilAt(x, z);
        const n = rng.int(4) + 2;
        const out: CaveRock[] = [];
        for (let s = 0; s < n; s++) {
          const b = rng.range(0, TAU), d = s === 0 ? 0 : rng.range(0.7, 1.9);
          const sx = x + sin(b) * d, sz = z + cos(b) * d;
          const hh = Math.min(C - F - 1.2, (s === 0 ? rng.range(2.2, 3.8) : rng.range(0.9, 2.6)) * (lava ? 0.6 : 1));
          if (hh < 0.8) continue;
          const rb = Math.min(hh * 0.45, rng.range(0.38, 0.75) * (s === 0 ? 1.25 : 1));
          const lean = hh * 0.06;
          // broad foot, rounded drip-fed top
          const tip = rb * rng.range(0.22, 0.4);
          out.push({ ax: sx, ay: F - 0.3, az: sz, bx: sx + rng.range(-lean, lean), by: F + hh - tip, bz: sz + rng.range(-lean, lean), ra: rb, rb: tip, shell: false });
        }
        return out.length ? out : null;
      });
  }

  /** Tunnel joints close to (or inside) the given room lobes. */
  passingNear(lobes: CaveNode[]): [number, number][] {
    const out: [number, number][] = [];
    for (const n of this.nodes) if (!isCh(n) && lobes.some((L) => hyp(L.x - n.x, L.z - n.z) < L.r + n.r + 3)) out.push([n.x, n.z]);
    return out;
  }

  /** Pickup suggestions on the real floor: upgrades in the main hall and dead-end rooms, ammo elsewhere. */
  placeSpots(cave: Cave): void {
    const world = { seed: this.ctx.seed, caves: [...this.ctx.caves, cave] } as unknown as World;
    const floorAt = (x: number, z: number, f0: number): number => {
      // highest floor below f0 + 1.6 (the void is free above it)
      let hi = f0 + 1.6;
      if (caveSdf(world, x, hi, z) >= 0) return NaN;
      let lo = hi;
      while (lo > f0 - 2.5 && caveSdf(world, x, lo, z) < 0) lo -= 0.25;
      if (caveSdf(world, x, lo, z) < 0) return NaN;
      for (let k = 0; k < 12; k++) {
        const m = (lo + hi) * 0.5;
        if (caveSdf(world, x, m, z) < 0) hi = m;
        else lo = m;
      }
      return hi;
    };
    const put = (n: CaveNode, upgrade: boolean) => {
      const y = floorAt(n.x, n.z, floorOf(n));
      if (y === y) this.spots.push({ x: n.x, y, z: n.z, upgrade });
    };
    for (const room of this.rooms) {
      const n = this.nodes[room.lobes[0]];
      put(n, room === this.rooms[0] || room.kind === "treasure");
    }
    // ammo along a couple of approach tunnels
    let k = 0;
    for (const r of this.routes) {
      if (r.mid < 0 || k >= 2) continue;
      put(this.nodes[r.mid], false);
      k++;
    }
  }
}
