// Results: the winner on a sunny card, then the scoreboard.
//
// Hook for the match phase: the rows come from MatchSim.results() on the
// server (Results message); add columns here when the sim tracks more.

import { Phase, type ResultsMsg, type RoomState } from "../../../../shared/net/index";
import { blobSvg, colorHex } from "../art";
import { h, html } from "../dom";

export interface ResultsActions {
  backToLobby(): void;
  leave(): void;
}

export interface ResultsScreen {
  el: HTMLElement;
  tick(serverNow: number, state: RoomState | null): void;
}

export function resultsScreen(res: ResultsMsg, me: number, isHost: boolean, actions: ResultsActions): ResultsScreen {
  const rows = res.rows;
  const top = rows[0];
  const tie = rows.length > 1 && rows[1]!.score === top?.score && top.score > 0;
  const countdown = h("span", { class: "muted" });

  const winner = top
    ? h(
        "section",
        { class: "card winner" },
        html(blobSvg(colorHex(top.color), { size: 112 })),
        h(
          "div",
          null,
          h(
            "h2",
            { class: "display" },
            top.score === 0 ? "Nobody got painted" : tie ? "A tie at the top!" : `${top.name} wins!`,
          ),
          h(
            "p",
            { class: "muted" },
            top.score === 0
              ? "A peaceful afternoon on the island."
              : `${top.score} ${top.score === 1 ? "elimination" : "eliminations"} on island #${res.seed}`,
          ),
        ),
      )
    : null;

  const body = h("tbody");
  rows.forEach((r, i) => {
    body.append(
      h(
        "tr",
        { class: r.id === me ? "me" : "" },
        h("td", null, String(i + 1)),
        h("td", null, h("span", { class: "chip", style: `--c:${colorHex(r.color)}` }), r.name, r.bot ? h("span", { class: "muted" }, " (bot)") : null),
        h("td", { class: "num" }, String(r.score)),
        h("td", { class: "num" }, String(r.deaths)),
      ),
    );
  });

  const el = h(
    "div",
    { class: "page" },
    h(
      "header",
      { class: "band" },
      h("span", { class: "wordmark band-mark", "aria-hidden": "true" }, "Isola"),
      h("div", { class: "band-title" }, h("h1", { class: "display" }, "Match over"), h("span", { class: "band-sub" }, `Island #${res.seed}`)),
    ),
    h(
      "main",
      { class: "page-body" },
      h(
        "div",
        { class: "results" },
        winner,
        h(
          "table",
          { class: "board" },
          h("caption", { class: "sr-only" }, "Final scores"),
          h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Player"), h("th", { class: "num" }, "Eliminations"), h("th", { class: "num" }, "Painted"))),
          body,
        ),
        h(
          "div",
          { class: "results-foot" },
          countdown,
          h(
            "div",
            { style: "display:flex;gap:.8rem;flex-wrap:wrap" },
            h("button", { class: "btn", type: "button", onclick: () => actions.leave() }, "Leave room"),
            isHost ? h("button", { class: "btn primary", type: "button", id: "btn-lobby", onclick: () => actions.backToLobby() }, "Back to lobby") : null,
          ),
        ),
      ),
    ),
  );

  return {
    el,
    tick(now, state) {
      if (!state || state.phase !== Phase.Results || !state.phaseEndsAt) {
        countdown.textContent = "";
        return;
      }
      const s = Math.max(0, Math.ceil((state.phaseEndsAt - now) / 1000));
      countdown.textContent = `Back to the lobby in ${s} s`;
    },
  };
}
