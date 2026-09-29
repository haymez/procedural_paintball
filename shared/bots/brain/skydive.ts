// Bots in a sky drop (Move.Glide, then the Move.Splat landing): pick a landing
// spot near the action — a hot zone or an enemy on the ground, with a personal
// scatter so a pack of bots doesn't pile onto one spot — and glide there with
// the same W / S / Shift controls a human uses. Deterministic (seeded Rng).
import type { Rng } from "../../math/rng";
import { atan2, cos, sin } from "../../math/trig";
import { Btn, GLIDE_ACCEL, glideReach, Move, type HotZone, type InputCmd, type MatchSim, type PlayerState } from "../../sim/index";
import { terrainHeight } from "../../world/collide";
import { NF } from "../constants";
import { nearestNode } from "../nav";
import type { BotConfig } from "./config";
import type { BotHub } from "./hub";
import type { BotStats } from "./types";

const _zones: HotZone[] = [];
const _cand: { x: number; z: number; w: number; id: number }[] = [];

function hyp(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export class SkyDiver {
  private active = false;
  /** Landing target. */
  private tx = 0;
  private tz = 0;
  /** Following an enemy on the ground (id, offset from them), or -1. */
  private follow = -1;
  private ox = 0;
  private oz = 0;
  private retargetT = 0;
  private lx = 0;
  private lz = 0;

  get target(): { x: number; z: number } | null {
    return this.active ? { x: this.tx, z: this.tz } : null;
  }

  /** Not dropping (any more): the next drop plans afresh. */
  end(): void {
    this.active = false;
  }

  /** One tick of steering while p is gliding or pancaked. Writes yaw / moveX / moveZ / buttons into cmd. */
  steer(sim: MatchSim, p: PlayerState, hub: BotHub, cfg: BotConfig, rng: Rng, stats: BotStats, cmd: InputCmd, dt: number): void {
    if (!this.active) {
      this.active = true;
      this.lx = p.x; this.lz = p.z;
      this.plan(sim, p, hub, cfg, rng);
    }
    { const m = hyp(p.x - this.lx, p.z - this.lz); if (m < 5) stats.distance += m; this.lx = p.x; this.lz = p.z; }
    cmd.pitch = -0.5;
    if (p.move === Move.Splat) { cmd.yaw = p.yaw; return; }
    // chase the enemy we picked (they move), a few times a second
    this.retargetT -= dt;
    if (this.follow >= 0 && this.retargetT <= 0) {
      this.retargetT = 0.5;
      const o = sim.player(this.follow);
      if (o && o.alive && o.move !== Move.Glide) this.setTarget(hub, sim, o.x + this.ox, o.z + this.oz);
      else this.follow = -1;
    }
    const dx = this.tx - p.x, dz = this.tz - p.z;
    const d = hyp(dx, dz);
    // height over the target, or over any rise on the way there
    let g = Math.max(0, terrainHeight(sim.world, this.tx, this.tz));
    for (let a = 30; a < d && a <= 70; a += 40) g = Math.max(g, terrainHeight(sim.world, p.x + (dx / d) * a, p.z + (dz / d) * a) + 4);
    const h = Math.max(1, p.y - g);
    cmd.yaw = d > 1.5 ? atan2(dx, dz) : p.yaw;
    cmd.moveX = 0;
    // glide ratio still needed: flare when short of it, dive when high above it; brake before overshooting,
    // and tuck (plummet) once right over it
    const need = d / h;
    const v = hyp(p.vx, p.vz);
    if (d < (v * v) / (2 * GLIDE_ACCEL) + 6) { cmd.moveZ = -1; if (d < 10 && h > 10) cmd.buttons |= Btn.Sprint; }
    else cmd.moveZ = need > 2.4 ? -1 : need < 1.5 ? 1 : 0;
  }

  private plan(sim: MatchSim, p: PlayerState, hub: BotHub, cfg: BotConfig, rng: Rng): void {
    const reach = glideReach(p.y - 25).flare * 0.85;
    const cand = _cand;
    cand.length = 0;
    for (const z of sim.action.zones(sim.time, _zones, 4)) cand.push({ x: z.x, z: z.z, w: 1.5 + z.heat, id: -1 });
    for (const o of sim.players) {
      if (o === p || !o.alive || o.move === Move.Glide || hub.ignore.has(o.id)) continue;
      cand.push({ x: o.x, z: o.z, w: 1, id: o.id });
    }
    let total = 0;
    for (const c of cand) {
      const d = hyp(c.x - p.x, c.z - p.z);
      if (d > reach) c.w = 0;
      total += c.w;
    }
    this.follow = -1;
    this.retargetT = 0.5;
    if (total <= 0) {
      // nobody down there yet (match start): anywhere on the island we can reach
      const sp = sim.world.spawns;
      let best = -1;
      for (let k = 0; k < 6 && best < 0; k++) {
        const i = rng.int(sp.length);
        if (hyp(sp[i].x - p.x, sp[i].z - p.z) < reach) best = i;
      }
      if (best < 0) best = rng.int(sp.length);
      this.tx = sp[best]?.x ?? p.x;
      this.tz = sp[best]?.z ?? p.z;
      return;
    }
    let r = rng.next() * total, pick = cand[0];
    for (const c of cand) { if (c.w <= 0) continue; pick = c; r -= c.w; if (r <= 0) break; }
    // brawlers land in the thick of it; the careful land on the edge of the fight
    const bold = rng.next() < 0.3 + cfg.pers.aggression * 0.6;
    const rad = bold ? 6 + rng.next() * 16 : 24 + rng.next() * 30;
    const a = rng.next() * 6.283185307179586;
    this.ox = sin(a) * rad;
    this.oz = cos(a) * rad;
    if (pick.id >= 0) this.follow = pick.id;
    this.setTarget(hub, sim, pick.x + this.ox, pick.z + this.oz);
  }

  /** Aim at (x, z), nudged onto walkable dry land (a nav node, else the nearest spawn point). */
  private setTarget(hub: BotHub, sim: MatchSim, x: number, z: number): void {
    const g = hub.bw.nav;
    const n = nearestNode(g, x, terrainHeight(sim.world, x, z), z, 20);
    if (n >= 0 && (g.flags[n] & NF.Land) && !(g.flags[n] & (NF.Swim | NF.Wade | NF.Cave)) && !hub.trapRegion[g.region[n]]) {
      this.tx = g.x[n]; this.tz = g.z[n];
      return;
    }
    let bd = Infinity;
    for (const s of sim.world.spawns) {
      const d = hyp(s.x - x, s.z - z);
      if (d < bd) { bd = d; this.tx = s.x; this.tz = s.z; }
    }
  }
}
