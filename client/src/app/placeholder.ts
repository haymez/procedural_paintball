// Stand-in for the game until the match phase lands: fakes world generation,
// reports ready, and shows a card with the match clock.

import { Phase } from "../../../shared/net/index";
import { h } from "../ui/dom";
import type { MatchContext, MatchHandle } from "./match";

const STAGES = ["shape", "erosion", "coast", "biomes", "rivers", "paths", "structures", "props", "gameplay", "done"];

/** Deterministic stand-in checksum so clients agree. */
function fakeChecksum(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  return (x ^ (x >>> 13)) >>> 0;
}

export function startMatch(ctx: MatchContext): MatchHandle {
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let clock: ReturnType<typeof setInterval> | null = null;

  // Fake a ~2.5 s world generation.
  let step = 0;
  const DURATION = 2500;
  const t0 = performance.now();
  timer = setInterval(() => {
    if (disposed) return;
    const t = Math.min(1, (performance.now() - t0) / DURATION);
    step = Math.min(STAGES.length - 1, Math.floor(t * (STAGES.length - 1)));
    ctx.loading.setProgress(STAGES[step]!, t);
    if (t >= 1) {
      clearInterval(timer!);
      timer = null;
      ctx.worldReady(fakeChecksum(ctx.seed));
    }
  }, 100);

  return {
    begin(info) {
      if (disposed) return;
      const timeLeft = h("div", { class: "timer", "aria-live": "off" }, "--:--");
      const inMatch = h("p", { class: "muted" });
      const isHost = ctx.room.isHost;
      const card = h(
        "div",
        { class: "card" },
        h("h1", { class: "display" }, "The match would start here"),
        h("p", null, `Island #${info.seed} is loaded. The game itself arrives in the next phase.`),
        timeLeft,
        inMatch,
        h(
          "div",
          { class: "actions" },
          isHost
            ? h("button", { class: "btn sun", type: "button", id: "btn-end-match", onclick: () => ctx.room.endMatch() }, "End match")
            : null,
          h(
            "button",
            { class: "btn primary", type: "button", id: "btn-back-lobby", onclick: () => ctx.exit() },
            isHost ? "Back to lobby" : "Leave match",
          ),
        ),
      );
      ctx.mount.append(h("div", { class: "placeholder" }, card));
      const update = () => {
        const left = Math.max(0, info.endsAt - ctx.net.serverNow());
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        timeLeft.textContent = `${m}:${String(s).padStart(2, "0")}`;
        const st = ctx.room.state;
        if (st && st.phase === Phase.Playing) {
          const humans = st.players.filter((p) => !p.bot);
          inMatch.textContent = `${humans.length} ${humans.length === 1 ? "player" : "players"}, ${st.players.length - humans.length} bots, ping ${Math.round(ctx.net.rtt())} ms`;
        }
      };
      update();
      clock = setInterval(update, 250);
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      if (clock) clearInterval(clock);
    },
  };
}
