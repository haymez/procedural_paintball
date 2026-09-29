// Room browser: the live list of public rooms, as harbour departures.

import { MAX_PLAYERS, Phase, type RoomListing } from "../../../../shared/net/index";
import type { ConnStatus } from "../../net/connection";
import { blobSvg, icons } from "../art";
import { clear, h, html } from "../dom";

export interface BrowserActions {
  back(): void;
  join(code: string): void;
  create(): Promise<void>;
}

export interface BrowserScreen {
  el: HTMLElement;
  setRooms(rooms: RoomListing[]): void;
  setStatus(s: ConnStatus): void;
}

export function browserScreen(actions: BrowserActions): BrowserScreen {
  const list = h("ul", { class: "rooms", "aria-live": "polite", "aria-label": "Public rooms" });
  const live = h("span", { class: "live" }, "Live");
  const createBtn = h("button", { class: "btn sea", type: "button" }, "Create room");
  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    try {
      await actions.create();
    } finally {
      createBtn.disabled = false;
    }
  });

  const el = h(
    "div",
    { class: "page" },
    h(
      "header",
      { class: "band" },
      h("button", { class: "btn small", type: "button", onclick: () => actions.back() }, html(icons.back), "Back"),
      h("a", { class: "wordmark band-mark", href: "/", onclick: (e: Event) => (e.preventDefault(), actions.back()) }, "Isola"),
      h(
        "div",
        { class: "band-title" },
        h("h1", { class: "display" }, "Open rooms"),
        h("span", { class: "band-sub" }, "Public rooms on every island. Pick one and hop in."),
      ),
      h("div", { class: "band-tools" }, createBtn),
    ),
    h(
      "main",
      { class: "page-body" },
      h(
        "div",
        { class: "browser" },
        h("div", { class: "browser-head" }, h("h2", { class: "display" }, "Departures"), live),
        list,
      ),
    ),
  );

  let loaded = false;
  const render = (rooms: RoomListing[]) => {
    clear(list);
    if (!rooms.length) {
      list.append(
        h(
          "li",
          { class: "empty card" },
          html(blobSvg("#8fd3c0", { size: 96 })),
          h("h3", { class: "display" }, loaded ? "No public rooms right now" : "Checking the harbour…"),
          loaded ? h("p", { class: "muted" }, "Start one and it shows up here for everyone.") : null,
          loaded ? h("button", { class: "btn primary", type: "button", onclick: () => void actions.create() }, "Create room") : null,
        ),
      );
      return;
    }
    for (const r of rooms) list.append(row(r));
  };

  const row = (r: RoomListing) => {
    const full = r.players >= MAX_PLAYERS;
    const playing = r.phase !== Phase.Lobby;
    const seats = h("span", { class: "seat-bar", "aria-hidden": "true" });
    for (let i = 0; i < MAX_PLAYERS; i++) {
      seats.append(h("i", { class: i < r.players ? "h" : i < r.players + r.bots ? "b" : "" }));
    }
    return h(
      "li",
      { class: "room-row" },
      h("span", { class: "code-stamp" }, h("span", { class: "code" }, r.code)),
      h(
        "div",
        null,
        h("p", { class: "room-name" }, r.name || "Unnamed room"),
        h(
          "div",
          { class: "room-meta" },
          h("span", null, `Hosted by ${r.host || "someone"}`),
          h("span", null, r.seed !== null ? `Island #${r.seed}` : "Secret island"),
          r.region ? h("span", null, r.region) : null,
        ),
      ),
      h(
        "div",
        { class: "seats" },
        h("span", { class: `pill ${playing ? "is-playing" : "is-lobby"}` }, playing ? "Match on" : "In lobby"),
        seats,
        h("span", null, `${r.players}/${r.max}`, r.bots ? h("span", { class: "muted" }, ` +${r.bots} bots`) : null),
      ),
      h(
        "button",
        {
          class: `btn ${playing ? "" : "sun"}`,
          type: "button",
          disabled: full,
          "aria-label": `Join ${r.name} (${r.code})`,
          onclick: () => actions.join(r.code),
        },
        full ? "Full" : playing ? "Drop in" : "Join",
      ),
    );
  };

  render([]);
  return {
    el,
    setRooms(rooms) {
      loaded = true;
      render(rooms);
    },
    setStatus(s) {
      const on = s === "open";
      live.classList.toggle("off", !on);
      live.textContent = on ? "Live" : s === "offline" ? "Offline" : "Reconnecting";
    },
  };
}
