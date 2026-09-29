// Sound hooks. Gameplay code calls sfx("splat", pos) with game-level names;
// this module maps them onto client/src/audio (loaded lazily, optional) and
// drives the listener, ambience, breath heartbeat and engine/zipline loops.
// If the audio module is missing or fails, everything here is a silent no-op.
import type { AudioEngine, AmbienceState, SoundHandle, SfxName, PlayOpts } from "../audio/index";

export interface SfxOpts {
  volume?: number;
  pitch?: number;
  /** Surface hint for splats / steps: ground | stone | wood | water | sand | grass. */
  surface?: string;
  /** Local player's own sound (dry, non-positional). */
  self?: boolean;
}

type P = { x: number; y: number; z: number } | null | undefined;

let engine: AudioEngine | null = null;
let volume = 1;
const recent: string[] = [];

/** Game name → audio SFX name (+ default routing). */
const MAP: Record<string, SfxName | ((o: SfxOpts) => SfxName)> = {
  shoot: "shoot",
  shootOther: "shoot",
  splat: (o) => (o.surface === "stone" ? "splat_stone" : o.surface === "wood" ? "splat_wood" : "splat_ground"),
  plop: "splat_water",
  hit: "splat_player",
  hitMe: "hit_me",
  hitConfirm: "hitmarker",
  shield: "splat_stone",
  vest: "splat_wood",
  elim: "hitmarker_kill",
  elimOther: "eliminate",
  elimMe: "eliminate",
  elimPop: "eliminate",
  jump: "jump",
  land: "land",
  landHard: "land",
  slide: "slide",
  dive: "whiz",
  splash: "splash",
  bellyflop: "bellyflop",
  submerge: "bubbles",
  surface: "bubbles",
  gasp: "surface_gasp",
  mantle: "mantle",
  footstep: (o) => (`step_${o.surface ?? "grass"}` as SfxName),
  swimStroke: "swim_stroke",
  rowStroke: "row_stroke",
  gondola: "gondola_creak",
  reload: "reload",
  reloaded: "reload",
  empty: "shoot_empty",
  pickup: "pickup_ammo",
  upgrade: "pickup_upgrade",
  wash: "washoff",
  respawn: "respawn",
  vehicleEnter: "row_stroke",
  vespaStart: "vespa_horn",
  vehicleExit: "land",
  bump: "land",
  zipStart: "zipline_attach",
  zipEnd: "land",
  uiClick: "ui_click",
  uiOpen: "ui_confirm",
  killfeed: "killfeed",
  matchEnd: "match_end",
  countdown: "countdown_tick",
  whiz: "whiz",
};

/** Load and hook client/src/audio if it exists. */
export async function initSfx(): Promise<void> {
  if (engine) return;
  const mods = import.meta.glob("../audio/index.ts");
  for (const k in mods) {
    try {
      const m = (await mods[k]()) as { getAudio?: () => AudioEngine; createAudio?: () => AudioEngine };
      const get = m.getAudio ?? m.createAudio;
      if (get) {
        engine = get();
        engine.setVolume("master", volume);
      }
    } catch (e) {
      console.warn("[sfx] audio module failed to load", e);
    }
  }
}

/** Resolves once the sound bank is synthesized (or after maxMs, whichever is first). */
export async function sfxReady(maxMs = 4000): Promise<void> {
  await initSfx();
  const r = (engine as unknown as { ready?: Promise<void> } | null)?.ready;
  if (r) await Promise.race([r, new Promise((res) => setTimeout(res, maxMs))]);
}

export function sfx(name: string, pos?: P, opts: SfxOpts = {}): void {
  recent.push(name);
  if (recent.length > 40) recent.shift();
  if (!engine) return;
  const m = MAP[name];
  if (!m) return;
  const id = typeof m === "function" ? m(opts) : m;
  const o: PlayOpts = {};
  if (pos && !opts.self) o.pos = { x: pos.x, y: pos.y, z: pos.z };
  if (opts.self) o.bus = "self";
  if (opts.volume !== undefined) o.volume = opts.volume;
  if (opts.pitch !== undefined) o.pitch = opts.pitch;
  if (name === "landHard") o.volume = (o.volume ?? 1) * 1.5;
  try {
    engine.play(id, o);
  } catch {
    /* never let audio break the game */
  }
}

// ---------------------------------------------------------------------------
// continuous sounds

const loops = new Map<string, SoundHandle>();

/** Start/update/stop a keyed loop (e.g. "vespa:3"). Pass null to stop. */
export function sfxLoop(key: string, name: SfxName, pos: P, pitch = 1, vol = 1): void {
  if (!engine) return;
  let h = loops.get(key);
  if (!pos) {
    if (h) { h.stop(250); loops.delete(key); }
    return;
  }
  try {
    if (!h || !h.playing) {
      h = engine.loop(name, { pos: { x: pos.x, y: pos.y, z: pos.z }, volume: vol, pitch });
      loops.set(key, h);
    } else {
      h.setPos(pos);
      h.setPitch(pitch, 120);
      h.setVolume(vol, 120);
    }
  } catch {
    /* ignore */
  }
}

/** Stop every loop not touched since the last call to sfxLoopsBegin(). */
const touched = new Set<string>();
export function sfxLoopsBegin(): void {
  touched.clear();
}
export function sfxLoopTouch(key: string): void {
  touched.add(key);
}
export function sfxLoopsEnd(): void {
  for (const [k, h] of loops) if (!touched.has(k)) { h.stop(300); loops.delete(k); }
}

export function sfxListener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
  engine?.setListener({ x, y, z }, { x: fx, y: fy, z: fz });
}

export function sfxAmbience(s: AmbienceState): void {
  engine?.setAmbience(s);
}

export function sfxBreath(fraction: number | null): void {
  engine?.setBreath(fraction);
}

export function sfxDuck(amount: number, ms: number): void {
  engine?.duck(amount, ms);
}

export function sfxVolume(v: number): void {
  volume = v;
  engine?.setVolume("master", v);
}

export function sfxStopAll(): void {
  for (const h of loops.values()) h.stop(200);
  loops.clear();
  engine?.stopAmbience(600);
  engine?.setBreath(null);
}

/** Debug: the last few sound names requested. */
export function recentSfx(): string[] {
  return recent.slice();
}

export function audioStats(): unknown {
  return engine?.stats() ?? null;
}
