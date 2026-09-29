// Continuous audio for a match: listener, biome ambience, breath heartbeat,
// Vespa engines, boat wakes, zipline whirr, swim / row strokes.
import type * as THREE from "three";
import { Biome, GRID_RES, StructureKind, VehicleKind, WORLD_HALF, isBoat, type World } from "../../../shared/world/types";
import { Move, type PlayerState, type SimSnapshot } from "../../../shared/sim/index";
import type { AmbienceBiome, AmbienceState } from "../audio/index";
import { sfx, sfxAmbience, sfxBreath, sfxListener, sfxLoop, sfxLoopsBegin, sfxLoopsEnd, sfxLoopTouch } from "./sfx";

const BIOME_AMB: Partial<Record<Biome, AmbienceBiome>> = {
  [Biome.Shallows]: "beach",
  [Biome.Beach]: "beach",
  [Biome.PalmGrove]: "beach",
  [Biome.Jungle]: "jungle",
  [Biome.Forest]: "jungle",
  [Biome.Mangrove]: "mangrove",
  [Biome.Meadow]: "meadow",
  [Biome.Riverbank]: "meadow",
  [Biome.Scrub]: "rock",
  [Biome.Rock]: "rock",
  [Biome.Cliff]: "rock",
  [Biome.Village]: "village",
};

function gridIndex(x: number, z: number): number {
  const ix = Math.max(0, Math.min(GRID_RES - 1, Math.round((x + WORLD_HALF) / 2)));
  const iz = Math.max(0, Math.min(GRID_RES - 1, Math.round((z + WORLD_HALF) / 2)));
  return iz * GRID_RES + ix;
}

export class AudioScene {
  private ambT = 0;
  private strokeT = new Map<number, number>();
  private amb: AmbienceState = {
    biomeWeights: {}, seaDistance: 100, riverDistance: Infinity, waterfallDistance: Infinity,
    altitude: 0, cave: 0, underwater: false, timeOfDay: 12, dirs: {},
  };
  private villages: { x: number; z: number }[];

  constructor(private world: World) {
    this.amb.timeOfDay = world.timeOfDay;
    this.villages = world.structures.filter((s) => s.kind === StructureKind.Hamlet || s.kind === StructureKind.Chapel).map((s) => ({ x: s.x, z: s.z }));
  }

  /** Surface under a player's feet for footstep sounds. */
  footSurface(p: PlayerState): string {
    if (p.waterY > p.y + 0.15) return "water";
    const i = gridIndex(p.x, p.z);
    if (p.y > this.world.height[i] + 0.35) return "stone";
    const b = this.world.biome[i];
    if (b === Biome.Beach || b === Biome.Shallows) return "sand";
    if (b === Biome.Village || b === Biome.Rock || b === Biome.Cliff) return "stone";
    return "grass";
  }

  update(dt: number, cam: THREE.PerspectiveCamera, fwd: THREE.Vector3, snap: SimSnapshot, me: PlayerState | undefined, cave: number, underwater: boolean): void {
    const cp = cam.position;
    sfxListener(cp.x, cp.y, cp.z, fwd.x, fwd.y, fwd.z);
    sfxBreath(me && me.alive && me.move === Move.Underwater ? me.breath : null);

    this.ambT -= dt;
    if (this.ambT <= 0) {
      this.ambT = 0.25;
      this.updateAmbience(cp.x, cp.y, cp.z, cave, underwater);
    }

    // ---- loops ----------------------------------------------------------------------
    sfxLoopsBegin();
    for (const v of snap.vehicles) {
      const dx = v.x - cp.x, dz = v.z - cp.z;
      if (dx * dx + dz * dz > 120 * 120) continue;
      const sp = Math.abs(v.speed), thr = Math.max(0, v.throttle);
      if (v.kind === VehicleKind.Vespa && v.seats[0] >= 0) {
        const k = "vespa:" + v.id;
        sfxLoop(k, "vespa_engine", v, 0.75 + sp / 11 + thr * 0.12, 0.8 + thr * 0.4);
        sfxLoopTouch(k);
      } else if (v.kind === VehicleKind.Jetski && v.seats[0] >= 0) {
        // high buzz that screams up with speed (and revs free in the air)
        const k = "jetski:" + v.id;
        sfxLoop(k, "jetski_engine", v, 0.8 + sp / 22 + thr * 0.15 + (v.airborne ? 0.25 : 0), 0.65 + thr * 0.35);
        sfxLoopTouch(k);
      } else if (v.kind === VehicleKind.Speedboat && v.seats[0] >= 0) {
        const k = "inboard:" + v.id;
        sfxLoop(k, "inboard_engine", v, 0.85 + sp / 30 + thr * 0.12, 0.7 + thr * 0.3);
        sfxLoopTouch(k);
      } else if (v.kind === VehicleKind.Gyrocopter && (v.seats[0] >= 0 || v.airborne)) {
        const k = "gyro:" + v.id;
        sfxLoop(k, "gyro_engine", v, v.seats[0] >= 0 ? 0.85 + thr * 0.3 + sp / 60 : 0.6, v.seats[0] >= 0 ? 0.75 + thr * 0.25 : 0.35);
        sfxLoopTouch(k);
      }
      // hull through the water
      if (isBoat(v.kind) && !v.airborne && sp > 0.6) {
        const k = "wake:" + v.id;
        sfxLoop(k, "boat_wake", v, 0.9 + Math.min(sp, 20) * 0.03, Math.min(1, sp / 6));
        sfxLoopTouch(k);
      }
    }
    for (const p of snap.players) {
      if (!p.alive) continue;
      const dx = p.x - cp.x, dz = p.z - cp.z;
      if (dx * dx + dz * dz > 80 * 80) continue;
      if (p.move === Move.Glide) {
        // wind rushing past a sky diver (louder and higher the faster they go)
        const k = "wind:" + p.id, sp = Math.hypot(p.vx, p.vy, p.vz);
        sfxLoop(k, "sky_wind", p, 0.8 + sp / 60, Math.min(1.2, 0.35 + sp / 40) * (me?.id === p.id ? 0.8 : 1));
        sfxLoopTouch(k);
      }
      if (p.move === Move.Zipline) {
        const k = "zip:" + p.id;
        sfxLoop(k, "zipline_whirr", p, 0.7 + p.zipV / 22, 0.6 + p.zipV / 25);
        sfxLoopTouch(k);
      }
      if (p.move === Move.Swim && Math.hypot(p.vx, p.vz) > 0.8) {
        const t = (this.strokeT.get(p.id) ?? 0) - dt;
        if (t <= 0) { sfx("swimStroke", p, { self: me?.id === p.id, volume: me?.id === p.id ? 0.7 : 1 }); this.strokeT.set(p.id, 0.72); }
        else this.strokeT.set(p.id, t);
      }
    }
    sfxLoopsEnd();
  }

  private updateAmbience(x: number, y: number, z: number, cave: number, underwater: boolean): void {
    const w = this.world;
    const a = this.amb;
    // biome weights on a 5x5 patch
    const bw: Partial<Record<AmbienceBiome, number>> = {};
    let n = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const b = BIOME_AMB[w.biome[gridIndex(x + i * 12, z + j * 12)] as Biome];
      if (!b) continue;
      bw[b] = (bw[b] ?? 0) + 1;
      n++;
    }
    for (const k in bw) bw[k as AmbienceBiome]! /= Math.max(1, n);
    a.biomeWeights = bw;
    // nearest sea (sampled rings)
    let seaD = 400, sdx = 0, sdz = 0;
    if (w.height[gridIndex(x, z)] < 0) seaD = 0;
    else {
      outer: for (const r of [8, 18, 32, 55, 90, 140, 220, 320]) {
        for (let k = 0; k < 16; k++) {
          const ang = (k / 16) * Math.PI * 2;
          const sx = Math.sin(ang), sz = Math.cos(ang);
          if (w.height[gridIndex(x + sx * r, z + sz * r)] < 0) { seaD = r; sdx = sx; sdz = sz; break outer; }
        }
      }
    }
    a.seaDistance = seaD;
    // rivers, falls, villages
    let rd = Infinity, rdx = 0, rdz = 0;
    for (const rv of w.rivers) for (const p of rv.points) {
      const dx = p.x - x, dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < rd) { rd = d; rdx = dx; rdz = dz; }
    }
    a.riverDistance = Math.sqrt(rd);
    let fd = Infinity, fdx = 0, fdz = 0;
    for (const f of w.waterfalls) {
      const dx = f.x - x, dz = f.z - z;
      const d = dx * dx + dz * dz;
      if (d < fd) { fd = d; fdx = dx; fdz = dz; }
    }
    a.waterfallDistance = Math.sqrt(fd);
    let vd = Infinity, vdx = 0, vdz = 0;
    for (const v of this.villages) {
      const dx = v.x - x, dz = v.z - z;
      const d = dx * dx + dz * dz;
      if (d < vd) { vd = d; vdx = dx; vdz = dz; }
    }
    const norm = (dx: number, dz: number) => { const l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l }; };
    a.dirs = {
      sea: seaD > 0 ? { x: sdx, z: sdz } : undefined,
      river: Number.isFinite(rd) ? norm(rdx, rdz) : undefined,
      waterfall: Number.isFinite(fd) ? norm(fdx, fdz) : undefined,
      village: Number.isFinite(vd) ? norm(vdx, vdz) : undefined,
    };
    a.altitude = y;
    a.cave = cave;
    a.underwater = underwater;
    sfxAmbience(a);
  }
}
