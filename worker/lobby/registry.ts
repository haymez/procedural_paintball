// LobbyRegistry — the lobby DO's bookkeeping, free of Workers globals so it
// can be unit-tested. Tracks live rooms (reported by the rooms themselves) and
// reserved codes (handed out by POST /api/rooms, not yet joined).

import { MAX_PLAYERS, Phase, randomCode, type RoomListing } from "../../shared/net/index";

/** A room that hasn't heartbeated in this long is dropped. */
export const ROOM_STALE_MS = 90_000;
/** A created-but-never-joined code is released after this long. */
export const RESERVATION_MS = 10 * 60_000;

export interface Reservation {
  at: number;
  public: boolean;
}

export interface RegistryStore {
  putRoom(code: string, l: RoomListing): void;
  deleteRoom(code: string): void;
  putReservation(code: string, r: Reservation): void;
  deleteReservation(code: string): void;
}

export class LobbyRegistry {
  readonly rooms = new Map<string, { listing: RoomListing; seen: number }>();
  readonly reserved = new Map<string, Reservation>();

  constructor(private readonly store: RegistryStore | null = null) {}

  /** Restore from storage (seen = now: a restored room gets a fresh stale window). */
  load(rooms: Iterable<RoomListing>, reservations: Iterable<[string, Reservation]>, now: number): void {
    for (const l of rooms) this.rooms.set(l.code, { listing: l, seen: now });
    for (const [code, r] of reservations) this.reserved.set(code, r);
  }

  /** Reserve a fresh code. */
  create(isPublic: boolean, now: number, rand: () => number): string {
    for (let i = 0; i < 1000; i++) {
      const code = randomCode(rand);
      if (this.rooms.has(code) || this.reserved.has(code)) continue;
      const r = { at: now, public: isPublic };
      this.reserved.set(code, r);
      this.store?.putReservation(code, r);
      return code;
    }
    throw new Error("no free room codes");
  }

  /** Called by a room DO before its first player joins. */
  claim(code: string): { ok: boolean; public: boolean } {
    const live = this.rooms.get(code);
    if (live) return { ok: true, public: live.listing.public };
    const r = this.reserved.get(code);
    if (r) return { ok: true, public: r.public };
    return { ok: false, public: false };
  }

  /** Returns true if the visible listing changed. */
  report(l: RoomListing, now: number): boolean {
    if (this.reserved.delete(l.code)) this.store?.deleteReservation(l.code);
    const prev = this.rooms.get(l.code);
    const same = prev && JSON.stringify(prev.listing) === JSON.stringify(l);
    this.rooms.set(l.code, { listing: l, seen: now });
    if (!same) this.store?.putRoom(l.code, l);
    return !same;
  }

  remove(code: string): boolean {
    let changed = false;
    if (this.rooms.delete(code)) {
      this.store?.deleteRoom(code);
      changed = true;
    }
    if (this.reserved.delete(code)) this.store?.deleteReservation(code);
    return changed;
  }

  /** Drops stale rooms and expired reservations. Returns true if the list changed. */
  sweep(now: number): boolean {
    let changed = false;
    for (const [code, e] of this.rooms) {
      if (now - e.seen > ROOM_STALE_MS) {
        this.rooms.delete(code);
        this.store?.deleteRoom(code);
        changed = true;
      }
    }
    for (const [code, r] of this.reserved) {
      if (now - r.at > RESERVATION_MS) {
        this.reserved.delete(code);
        this.store?.deleteReservation(code);
      }
    }
    return changed;
  }

  get isEmpty(): boolean {
    return this.rooms.size === 0 && this.reserved.size === 0;
  }

  /** Public rooms with people in them: lobbies first, then fullest. */
  publicList(): RoomListing[] {
    return [...this.rooms.values()]
      .map((e) => e.listing)
      .filter((l) => l.public && l.players > 0)
      .sort(
        (a, b) =>
          Number(a.phase !== Phase.Lobby) - Number(b.phase !== Phase.Lobby) ||
          b.players - a.players ||
          a.code.localeCompare(b.code),
      );
  }

  lookup(code: string): { code: string; exists: boolean; public: boolean; players: number; phase: Phase } {
    const live = this.rooms.get(code);
    if (live) {
      const l = live.listing;
      return { code, exists: true, public: l.public, players: l.players, phase: l.phase };
    }
    const r = this.reserved.get(code);
    if (r) return { code, exists: true, public: r.public, players: 0, phase: Phase.Lobby };
    return { code, exists: false, public: false, players: 0, phase: Phase.Lobby };
  }

  /** Best public room with a free seat (a lobby if any), else a new public room. */
  quickJoin(now: number, rand: () => number): { code: string; created: boolean } {
    const open = this.publicList().filter((l) => l.players < MAX_PLAYERS);
    const pick = open.find((l) => l.phase === Phase.Lobby) ?? open.find((l) => l.phase === Phase.Playing);
    if (pick) return { code: pick.code, created: false };
    return { code: this.create(true, now, rand), created: true };
  }
}
