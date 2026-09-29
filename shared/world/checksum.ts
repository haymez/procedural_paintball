// 32-bit checksum over everything the server and clients must agree on:
// terrain, water, holes, structures, collider props, caves, and gameplay
// spawns. Decoration (zero-radius props), biomes, moisture and names are
// excluded, so skipDecor worlds hash the same as full ones.
import { PROP_COLLIDER_RADIUS, type World } from "./types";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

class Hasher {
  h = 0x811c9dc5 | 0;
  int(v: number): void {
    let h = this.h ^ (v | 0);
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    this.h = Math.imul(h, 0x2c1b3c6d);
  }
  f(v: number): void {
    f32[0] = v;
    this.int(u32[0]);
  }
  bytes(a: Uint8Array): void {
    const n = a.length;
    let i = 0;
    for (; i + 4 <= n; i += 4) this.int(a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24));
    for (; i < n; i++) this.int(a[i]);
  }
  floats(a: Float32Array): void {
    this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i));
  }
}

export function worldChecksum(world: World): number {
  const H = new Hasher();
  H.int(world.seed);
  H.floats(world.height);
  H.floats(world.water);
  H.bytes(world.holes);
  H.int(world.structures.length);
  for (const s of world.structures) {
    H.int(s.kind);
    H.int(s.solids.length);
    for (const o of s.solids) {
      H.str(o.shape);
      H.f(o.cx); H.f(o.cy); H.f(o.cz); H.f(o.hx); H.f(o.hy); H.f(o.hz); H.f(o.rotY);
    }
  }
  for (const p of world.props) {
    if (PROP_COLLIDER_RADIUS[p.kind] <= 0) continue;
    H.int(p.kind);
    H.int(p.count);
    H.floats(p.data);
  }
  H.int(world.caves.length);
  for (const c of world.caves) {
    for (const n of c.nodes) { H.f(n.x); H.f(n.y); H.f(n.z); H.f(n.r); }
    for (const [a, b] of c.edges) { H.int(a); H.int(b); }
    for (const e of c.entrances) { H.f(e.x); H.f(e.y); H.f(e.z); }
  }
  for (const p of world.pickups) { H.int(p.kind); H.f(p.x); H.f(p.y); H.f(p.z); }
  for (const s of world.spawns) { H.f(s.x); H.f(s.y); H.f(s.z); }
  for (const v of world.vehicles) { H.int(v.kind); H.f(v.x); H.f(v.y); H.f(v.z); H.f(v.rotY); }
  for (const z of world.ziplines) { H.f(z.ax); H.f(z.ay); H.f(z.az); H.f(z.bx); H.f(z.by); H.f(z.bz); }
  return H.h >>> 0;
}
