// Loading: a boat per player crossing to the island. Mine moves with
// setProgress(stage, t); everyone else's from the room state.

import { Phase, PlayerStatus, type RoomState } from "../../../../shared/net/index";
import { boatSvg, colorHex, isletSvg } from "../art";
import { clear, h, html } from "../dom";

export interface LoadingScreen {
  el: HTMLElement;
  /** Stage label from the world generator, t in [0, 1]. */
  setProgress(stage: string, t: number): void;
  setRoom(state: RoomState, me: number): void;
}

// Stage ids -> what a player reads. The generator's STAGES
// (shared/world/generate.ts), then the client's own steps: "render:<step>"
// (createWorldViewAsync), "audio" (sound bank) and "done".
const FRIENDLY: Record<string, string> = {
  coast: "Drawing the coastline…",
  elevation: "Raising the island from the sea…",
  erosion: "Sculpting the cliffs…",
  hydrology: "Letting the streams find the sea…",
  caves: "Hollowing out the sea caves…",
  sites: "Choosing a spot for the village…",
  paths: "Beating paths between the houses…",
  traps: "Hiding a few surprises…",
  biomes: "Painting the hills green…",
  props: "Planting lemon trees and umbrella pines…",
  gameplay: "Stashing the paint crates…",
  names: "Naming the coves…",
  "render:textures": "Mixing the watercolours…",
  "render:terrain": "Rolling out the hillsides…",
  "render:water": "Pouring the sea…",
  "render:props": "Growing the olive groves…",
  "render:structures": "Whitewashing the cottages…",
  "render:caves": "Filling the grotto…",
  "render:shaders": "Mixing the paints…",
  audio: "Tuning the mandolins…",
  done: "Land ho!",
};

export function friendlyStage(stage: string): string {
  const s = stage.toLowerCase();
  return FRIENDLY[s] ?? FRIENDLY[s.split(/[^a-z]/)[0] ?? ""] ?? (stage ? stage[0]!.toUpperCase() + stage.slice(1) : "Setting sail…");
}

export function loadingScreen(seed: number, myColor: number): LoadingScreen {
  const stage = h("p", { class: "loading-stage", "aria-live": "polite" }, "Setting sail…");
  const barFill = h("i");
  const bar = h("div", { class: "bar", role: "progressbar", "aria-label": "Loading the island", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, barFill);
  const lane = h("div", { class: "route-lane" });
  const mine = html(boatSvg(colorHex(myColor))) as SVGElement;
  mine.classList.add("mine");
  mine.style.left = "0%";
  lane.append(mine);
  const others = h("div", { class: "others" });
  const heading = h("h1", { class: "display" }, `Sailing to island #${seed}`);

  const el = h(
    "main",
    { class: "loading" },
    h(
      "div",
      { class: "loading-inner" },
      heading,
      h(
        "div",
        { class: "route", "aria-hidden": "true" },
        h("span", { class: "route-port" }),
        h("div", { class: "route-line" }),
        lane,
        html(isletSvg()),
      ),
      stage,
      bar,
      others,
    ),
  );

  const otherBoats = new Map<number, SVGElement>();
  let myT = 0;

  return {
    el,
    setProgress(s, t) {
      myT = Math.max(0, Math.min(1, t));
      stage.textContent = friendlyStage(s);
      mine.style.left = `${myT * 100}%`;
      barFill.parentElement!.style.setProperty("--t", String(myT));
      bar.setAttribute("aria-valuenow", String(Math.round(myT * 100)));
    },
    setRoom(state, me) {
      const humans = state.players.filter((p) => !p.bot);
      const self = humans.find((p) => p.id === me);
      if (self && self.status === PlayerStatus.Ready) {
        stage.textContent =
          state.phase === Phase.Loading ? "Island ready. Waiting for the others to arrive…" : "Land ho! Joining the match…";
      }
      const seen = new Set<number>();
      clear(others);
      for (const p of humans) {
        if (p.id === me) continue;
        seen.add(p.id);
        let boat = otherBoats.get(p.id);
        if (!boat) {
          boat = html(boatSvg(colorHex(p.color))) as SVGElement;
          otherBoats.set(p.id, boat);
          lane.prepend(boat);
        }
        const t = p.status === PlayerStatus.Ready ? 1 : p.status === PlayerStatus.Loading ? p.progress : 1;
        boat.style.left = `${t * 100}%`;
        const label =
          p.status === PlayerStatus.Ready ? "ready" : !p.connected ? "reconnecting" : `${Math.round(p.progress * 100)}%`;
        others.append(h("span", null, h("i", { style: `--c:${colorHex(p.color)}` }), `${p.name} ${label}`));
      }
      for (const [id, b] of otherBoats) {
        if (!seen.has(id)) {
          b.remove();
          otherBoats.delete(id);
        }
      }
    },
  };
}
