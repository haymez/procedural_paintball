// Entity schemas for match snapshots.
//
//   REMOTE  other players as seen by a client: quantized for size, just what
//           rendering, the HUD and the scoreboard need.
//   OWN     the recipient's own player at full float32 precision: everything
//           stepPlayer and the weapon read, so the client can restore it and
//           replay unacknowledged inputs (prediction + reconciliation).
//   VEHICLE float32 too, so a driver can predict their own vehicle.
//
// Fields are ordered by how often they change so the usual mask is short.
// Coats travel as shooter ids (packIds): each end maps ids to colors.
import type { PlayerState, VehicleState } from "../sim/types";
import { WORLD_HALF } from "../world/types";
import { PAINT_WEAR_DELAY, PAINT_WEAR_TIME } from "../sim/constants";
import { field, packIds, packPair, schema, unpackIds, unpackPair, type Field, type Schema } from "./schema";

export const Y_MIN = -64;
export const Y_MAX = 192;

// Player flag bits (REMOTE and OWN use the same layout).
export const PF = {
  Grounded: 1,
  Sprinting: 2,
  Aiming: 4,
  Alive: 8,
  JumpHeld: 16,
  Exhausted: 32,
  Dived: 64,
} as const;

export function playerFlags(p: PlayerState): number {
  return (
    (p.grounded ? PF.Grounded : 0) |
    (p.sprinting ? PF.Sprinting : 0) |
    (p.aiming ? PF.Aiming : 0) |
    (p.alive ? PF.Alive : 0) |
    (p.jumpHeld ? PF.JumpHeld : 0) |
    (p.exhausted ? PF.Exhausted : 0) |
    (p.dived ? PF.Dived : 0)
  );
}

export function setPlayerFlags(p: PlayerState, f: number): void {
  p.grounded = (f & PF.Grounded) !== 0;
  p.sprinting = (f & PF.Sprinting) !== 0;
  p.aiming = (f & PF.Aiming) !== 0;
  p.alive = (f & PF.Alive) !== 0;
  p.jumpHeld = (f & PF.JumpHeld) !== 0;
  p.exhausted = (f & PF.Exhausted) !== 0;
  p.dived = (f & PF.Dived) !== 0;
}

type P = PlayerState;
type F = Field<P>;

const pos = (n: "x" | "y" | "z" | "mx0" | "my0" | "mz0" | "mx1" | "my1" | "mz1"): F => {
  const vertical = n === "y" || n === "my0" || n === "my1";
  return field<P>(n, "q16", (s) => s[n], (s, v) => void (s[n] = v), vertical ? Y_MIN : -WORLD_HALF, vertical ? Y_MAX : WORLD_HALF);
};
/** Position as 2 mm fixed point, delta-coded (see schema.ts "dq"). */
export const POS_SCALE = 512;
const dpos = (n: "x" | "y" | "z"): F =>
  field<P>(n, "dq", (s) => s[n], (s, v) => void (s[n] = v), n === "y" ? Y_MIN : -WORLD_HALF, POS_SCALE);
type NumKey = { [K in keyof P]: P[K] extends number ? K : never }[keyof P];
const num = (n: NumKey, kind: "f32" | "f16" | "varu" | "vari", ): F =>
  field<P>(n, kind, (s) => s[n], (s, v) => void ((s as unknown as Record<string, number>)[n] = v));
const q8 = (n: NumKey, max: number): F =>
  field<P>(n, "u8q", (s) => s[n], (s, v) => void ((s as unknown as Record<string, number>)[n] = v), 0, max);

const _ids: number[] = [];

/** Coats as shooter ids (coatBy). Setting fills coatBy; colors are the client's job. */
const coatsField: F = field<P>(
  "coats",
  "varu",
  (s) => packIds(s.coatBy),
  (s, v) => {
    unpackIds(v, _ids);
    s.coatBy.length = 0;
    for (const id of _ids) s.coatBy.push(id);
  },
);

export const REMOTE: Schema<P> = schema<P>("remote", [
  dpos("x"),
  dpos("z"),
  dpos("y"),
  num("vx", "f16"),
  num("vz", "f16"),
  num("vy", "f16"),
  field<P>("yaw", "ang16", (s) => s.yaw, (s, v) => void (s.yaw = v)),
  field<P>("pitch", "i8q", (s) => s.pitch, (s, v) => void (s.pitch = v), 0, 1.5),
  num("move", "varu"),
  field<P>("flags", "varu", playerFlags, setPlayerFlags),
  field<P>("zipT", "q16", (s) => Math.min(1, Math.max(0, s.zipT)), (s, v) => void (s.zipT = v), 0, 1),
  coatsField,
  num("upgrades", "varu"),
  num("vehicle", "vari"),
  num("seat", "vari"),
  num("zip", "vari"),
  q8("breath", 1),
  q8("shield", 2.5),
  q8("wash", 1.6),
  pos("mx0"),
  pos("my0"),
  pos("mz0"),
  pos("mx1"),
  pos("my1"),
  pos("mz1"),
  q8("mDur", 0.5),
  num("score", "varu"),
  num("deaths", "varu"),
  num("style", "varu"),
]);

export const OWN: Schema<P> = schema<P>("own", [
  num("x", "f32"),
  num("z", "f32"),
  num("y", "f32"),
  num("vx", "f32"),
  num("vz", "f32"),
  num("vy", "f32"),
  num("moveT", "f32"),
  num("gnx", "f32"),
  num("gny", "f32"),
  num("gnz", "f32"),
  num("stamina", "f32"),
  num("staminaDelay", "f32"),
  num("fireCd", "f32"),
  num("prevButtons", "varu"),
  num("move", "varu"),
  field<P>("flags", "varu", playerFlags, setPlayerFlags),
  num("coyote", "f32"),
  num("jumpBuf", "f32"),
  num("slideCd", "f32"),
  num("stumble", "f32"),
  num("breath", "f32"),
  num("gasp", "f32"),
  num("wash", "f32"),
  q8("paintT", PAINT_WEAR_DELAY + PAINT_WEAR_TIME),
  num("waterY", "f32"),
  num("zipT", "f32"),
  num("zipV", "f32"),
  num("reload", "f32"),
  num("shield", "f32"),
  num("deadT", "f32"),
  num("hopper", "varu"),
  // word 2
  num("reserve", "varu"),
  num("shotSeq", "varu"),
  coatsField,
  num("upgrades", "varu"),
  num("vehicle", "vari"),
  num("seat", "vari"),
  num("zip", "vari"),
  num("mx0", "f32"),
  num("my0", "f32"),
  num("mz0", "f32"),
  num("mx1", "f32"),
  num("my1", "f32"),
  num("mz1", "f32"),
  num("mDur", "f32"),
  field<P>(
    "spawnChoices",
    "varu",
    (s) => packPair(s.spawnChoices),
    (s, v) => {
      unpackPair(v, _ids);
      s.spawnChoices.length = 0;
      for (const i of _ids) s.spawnChoices.push(i);
    },
  ),
  num("spawnPick", "vari"),
  num("score", "varu"),
  num("deaths", "varu"),
  num("style", "varu"),
  num("streak", "varu"),
  num("yaw", "f32"),
  num("pitch", "f32"),
]);

type V = VehicleState;
type VNum = { [K in keyof V]: V[K] extends number ? K : never }[keyof V];
const vnum = (n: VNum): Field<V> =>
  field<V>(n, "f32", (s) => s[n], (s, v) => void ((s as unknown as Record<string, number>)[n] = v));

export function packSeats(seats: readonly number[]): number {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < Math.min(4, seats.length); i++) {
    v += ((seats[i]! + 1) & 0xff) * mul;
    mul *= 256;
  }
  return v;
}

/** Fills the existing seats array (its length = the vehicle's seat count). */
export function unpackSeats(v: number, seats: number[]): void {
  let rest = v;
  for (let i = 0; i < seats.length; i++) {
    seats[i] = (rest % 256) - 1;
    rest = Math.floor(rest / 256);
  }
}

export const VEHICLE: Schema<V> = schema<V>("vehicle", [
  vnum("x"),
  vnum("z"),
  vnum("y"),
  vnum("yaw"),
  vnum("speed"),
  vnum("vy"),
  vnum("steer"),
  vnum("throttle"),
  vnum("pitch"),
  field<V>("airborne", "varu", (s) => (s.airborne ? 1 : 0), (s, v) => void (s.airborne = v !== 0)),
  field<V>("seats", "varu", (s) => packSeats(s.seats), (s, v) => unpackSeats(v, s.seats)),
]);
