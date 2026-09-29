import type { SfxName, Category } from "./recipes";

export type { SfxName, Category };

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayOpts {
  /** World position (m). Omit for a non-positional (2D) sound. */
  pos?: Vec3;
  /** Linear gain multiplier (default 1). */
  volume?: number;
  /** Playback-rate multiplier (default 1). */
  pitch?: number;
  /** ± random semitones (default: per-sound). */
  pitchJitter?: number;
  /** Extra lowpass cutoff in Hz (e.g. muffled / behind a wall). */
  lowpass?: number;
  /** Override the routing: "world" (muffled underwater, cave reverb, ducked), "self" (local player, dry), "ui", "amb". */
  bus?: Category;
  /** Start after this many seconds (sample-accurate). */
  delay?: number;
}

export interface SoundHandle {
  stop(fadeMs?: number): void;
  setPos(p: Vec3): void;
  /** Linear gain (smoothed). */
  setVolume(v: number, rampMs?: number): void;
  /** Playback-rate multiplier (smoothed), e.g. engine RPM. */
  setPitch(rate: number, rampMs?: number): void;
  readonly playing: boolean;
}

export type AmbienceBiome = "beach" | "jungle" | "meadow" | "rock" | "village" | "mangrove";

export interface Dir2 {
  x: number;
  z: number;
}

export interface AmbienceState {
  /** Weights around the listener, roughly summing to 1 (missing = 0). */
  biomeWeights: Partial<Record<AmbienceBiome, number>>;
  /** Metres to the nearest sea shoreline (0 on the beach). */
  seaDistance: number;
  /** Metres to the nearest river / stream (Infinity if none). */
  riverDistance: number;
  /** Metres to the nearest waterfall (Infinity if none). */
  waterfallDistance: number;
  /** Listener height above sea level (m). */
  altitude: number;
  /** 0 outside … 1 deep inside a cave. */
  cave: number;
  /** Listener's head is under water. */
  underwater: boolean;
  /** Hours, 0..24 (e.g. 13.5 = 1:30 pm). */
  timeOfDay: number;
  /** Optional world-space unit directions from the listener toward features; used to pan beds / place birds & bells. */
  dirs?: { sea?: Dir2; river?: Dir2; waterfall?: Dir2; village?: Dir2 };
}

export interface Volumes {
  master: number;
  sfx: number;
  ambience: number;
  music: number;
}

export type MusicTrack = "menu";
export type JingleKind = "win" | "lose";

export interface MusicControl {
  play(track?: MusicTrack, fadeMs?: number): void;
  stop(fadeMs?: number): void;
  /** Results-screen jingle; stops the loop if playing. */
  jingle(kind: JingleKind): void;
  readonly playing: boolean;
}

export interface AudioStats {
  state: AudioContextState;
  voices: number;
  loops: number;
  beds: number;
  musicSources: number;
  loaded: number;
  pending: number;
}

export interface AudioEngine {
  readonly ctx: AudioContext;
  /** Resolves when every SFX (not the ambience beds) is rendered. */
  readonly ready: Promise<void>;
  /** Resolves when the ambience beds are rendered too. */
  readonly fullyLoaded: Promise<void>;
  /** Call from a user gesture (click / key). Also auto-installed on first pointer/key event. */
  unlock(): Promise<void>;
  readonly unlocked: boolean;

  setVolume(bus: keyof Volumes, v: number): void;
  getVolumes(): Volumes;
  setMuted(m: boolean): void;
  readonly muted: boolean;

  /** Camera/ears. forward & up need not be normalised. Call every frame. */
  setListener(pos: Vec3, forward: Vec3, up?: Vec3): void;

  play(name: SfxName, opts?: PlayOpts): SoundHandle;
  loop(name: SfxName, opts?: PlayOpts): SoundHandle;

  /** Call every frame during a match (internally throttled). */
  setAmbience(state: AmbienceState): void;
  /** Fade the ambience out (leaving a match). */
  stopAmbience(fadeMs?: number): void;

  /** Dip world + ambience by `amount` (0..1) and recover over `ms`. */
  duck(amount: number, ms: number): void;
  /** Breath remaining 0..1 while submerged (null when breathing air). Drives the heartbeat. */
  setBreath(fraction: number | null): void;

  readonly music: MusicControl;
  stats(): AudioStats;
}
