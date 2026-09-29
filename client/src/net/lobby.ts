// Lobby REST calls and the live room-list feed (/ws/lobby).

import { LobbyList, Phase, S2C, type RoomListing } from "../../../shared/net/index";
import { Connection, type ConnStatus } from "./connection";
import { wsUrl } from "./session";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok && res.status !== 404) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function listRooms(): Promise<{ rooms: RoomListing[] }> {
  return api("/api/rooms");
}

/** Reserves a fresh room code. */
export async function createRoom(isPublic: boolean): Promise<string> {
  const r = await api<{ code: string }>("/api/rooms", { method: "POST", body: JSON.stringify({ public: isPublic }) });
  return r.code;
}

/** Best public room with a free seat, or a new public room. */
export function quickJoin(): Promise<{ code: string; created: boolean }> {
  return api("/api/quick", { method: "POST", body: "{}" });
}

export function lookupRoom(
  code: string,
): Promise<{ code: string; exists: boolean; public?: boolean; players?: number; phase?: Phase }> {
  return api(`/api/rooms/${encodeURIComponent(code)}`);
}

/** Live public room list. */
export class LobbyFeed {
  rooms: RoomListing[] = [];
  private readonly conn: Connection;
  private readonly fns = new Set<(rooms: RoomListing[]) => void>();

  constructor() {
    this.conn = new Connection({ url: () => wsUrl("/ws/lobby"), registry: S2C });
    this.conn.on(LobbyList, (m) => {
      this.rooms = m.rooms;
      for (const fn of [...this.fns]) fn(m.rooms);
    });
  }

  onList(fn: (rooms: RoomListing[]) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  onStatus(fn: (s: ConnStatus) => void): () => void {
    return this.conn.onStatus(fn);
  }

  get status(): ConnStatus {
    return this.conn.status;
  }

  close(): void {
    this.fns.clear();
    this.conn.close();
  }
}
