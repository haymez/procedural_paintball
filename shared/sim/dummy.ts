// Target dummies for offline testing: wander between nearby points, hop over
// things, and now and then take a lazy potshot at the nearest player. They
// drive the sim through InputCmds exactly like a bot (or a human) would.
// The real bot AI is a later phase; keep this tiny.
import { Rng } from "../math/rng";
import { atan2, sin } from "../math/trig";
import type { MatchSim } from "./match";
import { Btn, Move, type InputCmd } from "./types";

export class Dummy {
  private rng: Rng;
  private tx = 0;
  private tz = 0;
  private repick = 0;
  private stuckT = 0;
  private lastX = 0;
  private lastZ = 0;
  private shootT = 2;
  private burst = 0;
  private aimErr = 0;
  private seq = 0;
  private pause = 0;
  private cmd: InputCmd = { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };

  constructor(readonly id: number, seed: number, private readonly aggression = 0.5) {
    this.rng = new Rng(seed * 7919 + id);
  }

  think(sim: MatchSim, dt: number): InputCmd {
    const p = sim.player(this.id);
    const c = this.cmd;
    c.seq = ++this.seq;
    c.buttons = 0;
    c.moveX = 0;
    c.moveZ = 0;
    if (!p) return c;
    if (!p.alive) {
      // pick a spawn after a moment
      if (p.deadT > 1.6 + this.rng.next()) c.buttons |= this.rng.chance(0.5) ? Btn.SpawnA : Btn.SpawnB;
      return c;
    }
    // wander
    this.repick -= dt;
    const dx = this.tx - p.x, dz = this.tz - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (this.repick <= 0 || d < 2) this.pickTarget(p.x, p.z);
    this.stuckT += dt;
    if (this.stuckT > 1.5) {
      const m = Math.abs(p.x - this.lastX) + Math.abs(p.z - this.lastZ);
      if (m < 1) this.pickTarget(p.x, p.z);
      this.stuckT = 0; this.lastX = p.x; this.lastZ = p.z;
    }
    let yaw = atan2(dx, dz);
    let pitch = 0;
    if (this.pause > 0) this.pause -= dt;
    else {
      c.moveZ = 1;
      if (this.rng.chance(dt * 0.25)) this.pause = 0.6 + this.rng.next() * 1.5;
    }
    if (p.move === Move.Swim) c.moveZ = 1;
    if (this.rng.chance(dt * 0.4) || (p.move === Move.Ground && this.stuckT > 0.8 && Math.abs(p.x - this.lastX) + Math.abs(p.z - this.lastZ) < 0.4)) c.buttons |= Btn.Jump;
    if (this.rng.chance(dt * 0.2)) c.buttons |= Btn.Sprint;

    // shoot at the nearest living player in range
    this.shootT -= dt;
    let best = null as null | { x: number; y: number; z: number; d: number };
    for (const o of sim.players) {
      if (o.id === this.id || !o.alive) continue;
      const ox = o.x - p.x, oy = o.y - p.y, oz = o.z - p.z;
      // whoever last painted us is 3x as interesting ("shoots back")
      const od = Math.sqrt(ox * ox + oy * oy + oz * oz) / (o.id === p.lastHitBy ? 3 : 1);
      if (od < 30 && (!best || od < best.d)) best = { x: o.x, y: o.y, z: o.z, d: od };
    }
    if (best && (this.burst > 0 || this.shootT <= 0)) {
      if (this.burst <= 0) {
        this.burst = 2 + this.rng.int(3);
        this.aimErr = (this.rng.next() - 0.5) * 0.2;
      }
      const ox = best.x - p.x, oz = best.z - p.z;
      yaw = atan2(ox, oz) + this.aimErr + sin(sim.time * 3 + this.id) * 0.03;
      const hd = Math.sqrt(ox * ox + oz * oz);
      pitch = atan2(best.y + 1 - (p.y + 1.45), hd) + hd * 0.004;
      c.moveZ = 0;
      if (p.fireCd <= 0) {
        c.buttons |= Btn.Fire;
        this.burst--;
        if (this.burst <= 0) this.shootT = (2.2 + this.rng.next() * 3) / (0.3 + this.aggression);
      }
    }
    if (p.hopper === 0) c.buttons |= Btn.Reload;
    c.yaw = yaw;
    c.pitch = pitch;
    return c;
  }

  private pickTarget(x: number, z: number): void {
    const a = this.rng.next() * 6.283185307179586;
    const r = 10 + this.rng.next() * 25;
    // bias back toward the island centre if we wander to the coast
    const cx = -x * 0.08, cz = -z * 0.08;
    this.tx = x + sin(a) * r + cx;
    this.tz = z + sin(a + 1.5707963267948966) * r + cz;
    this.repick = 5 + this.rng.next() * 6;
  }
}
