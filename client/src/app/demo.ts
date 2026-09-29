// ?demo=results|loading — screens with canned data, for design iteration and
// screenshots without a full match.

import { Phase, PlayerStatus, type RoomState } from "../../../shared/net/index";
import { loadingScreen } from "../ui/screens/loading";
import { resultsScreen } from "../ui/screens/results";

const NAMES = ["Pesce Veloce", "Polpo Pazzo", "Gelato Furioso", "Limone Allegro", "Nonna Bot", "Bip Bop", "Granchio Felice", "Tostapane"];

function state(): RoomState {
  return {
    code: "K7QX",
    phase: Phase.Loading,
    phaseEndsAt: 0,
    hostId: 1,
    settings: { name: "Cala Limone", public: true, seed: 3141592, hideSeed: false, bots: 2, difficulty: 1, matchMinutes: 10 },
    players: NAMES.slice(0, 4).map((name, i) => ({
      id: i + 1,
      name,
      color: [0, 5, 10, 2][i]!,
      host: i === 0,
      bot: false,
      connected: i !== 3,
      status: i === 1 ? PlayerStatus.Ready : PlayerStatus.Loading,
      progress: [0.5, 1, 0.3, 0.1][i]!,
      ping: 30,
    })),
  };
}

export function runDemo(root: HTMLElement, which: string): void {
  if (which === "loading") {
    const scr = loadingScreen(3141592, 0);
    root.replaceChildren(scr.el);
    scr.setRoom(state(), 1);
    scr.setProgress("structures", 0.55);
  } else {
    const rows = NAMES.map((name, i) => ({
      id: i + 1,
      name,
      color: [0, 5, 10, 2, 19, 18, 7, 15][i]!,
      bot: i >= 4 && i <= 5,
      score: [14, 11, 9, 7, 6, 4, 3, 1][i]!,
      deaths: [4, 6, 8, 7, 9, 11, 10, 12][i]!,
    }));
    const scr = resultsScreen({ seed: 3141592, endedAt: 0, rows }, 2, true, { backToLobby() {}, leave() {} });
    root.replaceChildren(scr.el);
  }
  (window as unknown as { __ready: boolean }).__ready = true;
}
