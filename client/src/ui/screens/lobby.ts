// Room lobby: who's aboard, the island & match settings (host edits, others
// read), and chat. Built once; state pushes update it in place.

import {
  CHAT_MAX,
  COLOR_COUNT,
  DIFFICULTY_NAMES,
  MATCH_MINUTES_MAX,
  MATCH_MINUTES_MIN,
  MAX_BOTS,
  MAX_PLAYERS,
  PLAYER_COLORS,
  Phase,
  ROOM_NAME_MAX,
  randomSeed,
  seedFromText,
  type ChatLine,
  type PlayerInfo,
  type RoomState,
} from "../../../../shared/net/index";
import type { RoomClient } from "../../net/room";
import { blobSvg, colorHex, icons } from "../art";
import { clear, h, html, nextId, setIfIdle } from "../dom";

export interface LobbyActions {
  leave(): void;
  copyInvite(): void;
}

export interface LobbyScreen {
  el: HTMLElement;
  dispose(): void;
}

export function pingClass(ms: number): string {
  return ms <= 0 ? "" : ms < 80 ? "good" : ms < 160 ? "ok" : "bad";
}

export function lobbyScreen(room: RoomClient, actions: LobbyActions): LobbyScreen {
  const offs: (() => void)[] = [];

  // --- band -----------------------------------------------------------------------
  const title = h("h1", { class: "display", id: "room-title" }, "Joining…");
  const sub = h("span", { class: "band-sub" }, "");
  const pingText = h("span", null, "…");
  const ping = h("span", { class: "ping-chip", title: "Round trip to the room" }, html(icons.signal), pingText);
  const band = h(
    "header",
    { class: "band" },
    h("button", { class: "btn small", type: "button", id: "btn-leave", onclick: () => actions.leave() }, html(icons.back), "Leave"),
    h("span", { class: "wordmark band-mark", "aria-hidden": "true" }, "Isola"),
    h("div", { class: "band-title" }, title, sub),
    h(
      "div",
      { class: "band-tools" },
      h(
        "span",
        { class: "code-stamp" },
        h("span", { class: "sr-only" }, "Room code"),
        h("span", { class: "code", id: "room-code" }, room.code),
        h(
          "button",
          { class: "btn small", type: "button", id: "btn-invite", onclick: () => actions.copyInvite() },
          html(icons.link),
          "Copy invite link",
        ),
      ),
      ping,
    ),
  );

  // --- players ----------------------------------------------------------------------
  const count = h("span", { class: "count" });
  const manifest = h("ul", { class: "manifest", "aria-label": "Players" });
  const swatchInputs: HTMLInputElement[] = [];
  const swatches = h("fieldset", { class: "swatches" }, h("legend", { class: "sr-only" }, "Your color"));
  PLAYER_COLORS.forEach((c, i) => {
    const input = h("input", { type: "radio", name: "player-color", value: String(i), "aria-label": c.name });
    input.addEventListener("change", () => {
      if (input.checked) room.setColor(i);
    });
    swatchInputs.push(input);
    swatches.append(h("label", { class: "swatch", title: c.name, style: `--c:${c.hex}` }, input, h("span")));
  });
  const players = h(
    "section",
    { class: "card panel", "aria-labelledby": "players-h" },
    h("div", { class: "panel-head" }, h("h2", { class: "display", id: "players-h" }, "Aboard"), count),
    manifest,
    h("div", { class: "field" }, h("span", { class: "field-label", "aria-hidden": "true" }, "Your color"), swatches),
  );

  // --- settings ---------------------------------------------------------------------
  const nameId = nextId("rn");
  const roomName = h("input", { class: "input", id: nameId, maxlength: String(ROOM_NAME_MAX), spellcheck: "false" });
  const pub = h("input", { type: "checkbox", id: "set-public" });
  const hideSeed = h("input", { type: "checkbox", id: "set-hide-seed" });
  const seedId = nextId("seed");
  const seed = h("input", { class: "input", id: seedId, inputmode: "text", spellcheck: "false", maxlength: "24", "aria-describedby": `${seedId}-hint` });
  const reroll = h(
    "button",
    { class: "btn icon-only", type: "button", title: "Roll a new island", "aria-label": "Roll a new island", id: "btn-reroll" },
    html(icons.dice),
  );
  const botsId = nextId("bots");
  const bots = h("input", { class: "range", type: "range", id: botsId, min: "0", max: String(MAX_BOTS), step: "1" });
  const botsVal = h("span", { class: "value" });
  const lenId = nextId("len");
  const length = h("input", {
    class: "range",
    type: "range",
    id: lenId,
    min: String(MATCH_MINUTES_MIN),
    max: String(MATCH_MINUTES_MAX),
    step: "1",
  });
  const lenVal = h("span", { class: "value" });
  const diffInputs: HTMLInputElement[] = [];
  const diff = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Bot difficulty" });
  DIFFICULTY_NAMES.forEach((n, i) => {
    const input = h("input", { type: "radio", name: "difficulty", value: String(i) });
    input.addEventListener("change", () => input.checked && room.updateSettings({ difficulty: i }));
    diffInputs.push(input);
    diff.append(h("label", null, input, h("span", null, n)));
  });
  const startBtn = h("button", { class: "btn primary", type: "button", id: "btn-start" }, "Start match");
  const waiting = h("p", { class: "waiting" });
  const startZone = h("div", { class: "start-zone" }, startBtn, waiting);

  const settings = h(
    "section",
    { class: "card panel settings", "aria-labelledby": "settings-h" },
    h("div", { class: "panel-head" }, h("h2", { class: "display", id: "settings-h" }, "Island & match")),
    h("div", { class: "field" }, h("label", { htmlFor: nameId }, "Room name"), roomName),
    h(
      "div",
      { class: "field" },
      h("label", { htmlFor: seedId }, "Island seed"),
      h("div", { class: "input-row" }, seed, reroll),
      h("p", { class: "hint", id: `${seedId}-hint` }, "Same seed, same island. Words work too. Rolled islands change every match."),
    ),
    h(
      "div",
      { class: "row2" },
      h("div", { class: "field" }, h("div", { class: "label-row" }, h("label", { htmlFor: botsId }, "Bots"), botsVal), bots),
      h("div", { class: "field" }, h("div", { class: "label-row" }, h("label", { htmlFor: lenId }, "Match length"), lenVal), length),
    ),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Bot difficulty"), diff),
    h(
      "div",
      { class: "row2" },
      h("label", { class: "switch" }, "Listed publicly", pub),
      h("label", { class: "switch" }, "Hide seed in list", hideSeed),
    ),
    startZone,
  );

  // --- chat -------------------------------------------------------------------------
  const log = h("ol", { class: "chat-log", "aria-live": "polite", "aria-label": "Chat messages" });
  const chatInput = h("input", {
    class: "input",
    id: "chat-input",
    maxlength: String(CHAT_MAX),
    placeholder: "Say ciao…",
    autocomplete: "off",
    "aria-label": "Chat message",
  });
  const chatForm = h(
    "form",
    { class: "chat-form" },
    chatInput,
    h("button", { class: "btn sea icon-only", type: "submit", "aria-label": "Send" }, html(icons.send)),
  );
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = chatInput.value.trim();
    if (!t) return;
    room.say(t);
    chatInput.value = "";
  });
  const chat = h(
    "section",
    { class: "card panel chat", "aria-labelledby": "chat-h" },
    h("div", { class: "panel-head" }, h("h2", { class: "display", id: "chat-h" }, "Chat")),
    log,
    chatForm,
  );

  const el = h("div", { class: "page" }, band, h("main", { class: "page-body" }, h("div", { class: "lobby" }, players, settings, chat)));

  // --- wiring -----------------------------------------------------------------------
  const commitName = () => {
    const v = roomName.value.trim();
    if (v && room.state && v !== room.state.settings.name) room.updateSettings({ name: v });
  };
  roomName.addEventListener("change", commitName);
  roomName.addEventListener("keydown", (e) => e.key === "Enter" && roomName.blur());

  const commitSeed = () => {
    const v = seed.value.trim();
    if (!v || !room.state) return;
    const s = seedFromText(v);
    if (s !== room.state.settings.seed) room.updateSettings({ seed: s });
    seed.value = String(s);
  };
  seed.addEventListener("change", commitSeed);
  seed.addEventListener("keydown", (e) => e.key === "Enter" && seed.blur());
  reroll.addEventListener("click", () => {
    const s = randomSeed(Math.random);
    seed.value = String(s);
    room.updateSettings({ seed: s, seedRandom: true });
  });

  const fill = (r: HTMLInputElement) => {
    const min = Number(r.min);
    const max = Number(r.max);
    r.style.setProperty("--fill", `${((Number(r.value) - min) / Math.max(1, max - min)) * 100}%`);
  };
  const botsLabel = (n: number) => (n === 0 ? "None" : n === 1 ? "1 bot" : `${n} bots`);
  bots.addEventListener("input", () => {
    botsVal.textContent = botsLabel(Number(bots.value));
    fill(bots);
  });
  bots.addEventListener("change", () => room.updateSettings({ bots: Number(bots.value) }));
  length.addEventListener("input", () => {
    lenVal.textContent = `${length.value} min`;
    fill(length);
  });
  length.addEventListener("change", () => room.updateSettings({ matchMinutes: Number(length.value) }));
  pub.addEventListener("change", () => room.updateSettings({ public: pub.checked }));
  hideSeed.addEventListener("change", () => room.updateSettings({ hideSeed: hideSeed.checked }));
  startBtn.addEventListener("click", () => room.start());

  // --- render -----------------------------------------------------------------------
  const personRow = (p: PlayerInfo, s: RoomState) => {
    const me = p.id === room.me;
    const cls = ["person", me ? "me" : "", p.bot ? "bot" : "", !p.connected ? "gone" : ""].join(" ");
    const avatar = p.bot
      ? h("span", { class: "bot-chip", style: `--c:${colorHex(p.color)}` }, html(icons.bot))
      : html(blobSvg(colorHex(p.color), { size: 32 }));
    const side = p.bot
      ? h("span", { class: "person-side" }, DIFFICULTY_NAMES[s.settings.difficulty])
      : !p.connected
        ? h("span", { class: "person-side" }, "reconnecting…")
        : h("span", { class: `person-side ${pingClass(p.ping)}` }, p.ping ? `${p.ping} ms` : "");
    return h(
      "li",
      { class: cls },
      avatar,
      h(
        "span",
        { class: "person-name" },
        p.host ? h("span", { title: "Host", "aria-label": "Host" }, html(icons.crown)) : null,
        h("span", null, p.name),
        me ? h("span", { class: "tag" }, "you") : null,
      ),
      side,
    );
  };

  const render = () => {
    const s = room.state;
    if (!s) return;
    const host = room.isHost;
    const hostName = s.players.find((p) => p.id === s.hostId)?.name ?? "the host";
    const humans = s.players.filter((p) => !p.bot);
    const botCount = s.players.length - humans.length;

    title.textContent = s.settings.name || "Room";
    sub.textContent = host ? "You're the host" : `Hosted by ${hostName}`;

    count.textContent = `${humans.length} of ${MAX_PLAYERS}${botCount ? `, ${botCount} bots` : ""}`;
    clear(manifest);
    for (const p of s.players) manifest.append(personRow(p, s));

    const takenByOthers = new Set(humans.filter((p) => p.id !== room.me).map((p) => p.color));
    const mine = room.myPlayer?.color ?? -1;
    for (let i = 0; i < COLOR_COUNT; i++) {
      const input = swatchInputs[i]!;
      input.disabled = takenByOthers.has(i);
      input.checked = i === mine;
    }

    // settings
    const editable = host && s.phase === Phase.Lobby;
    for (const c of [roomName, seed]) {
      c.readOnly = !editable;
    }
    for (const c of [pub, hideSeed, bots, length, ...diffInputs]) c.disabled = !editable;
    reroll.hidden = !editable;
    setIfIdle(roomName, s.settings.name);
    setIfIdle(seed, String(s.settings.seed));
    pub.checked = s.settings.public;
    hideSeed.checked = s.settings.hideSeed;
    const maxBots = Math.min(MAX_BOTS, MAX_PLAYERS - humans.length);
    bots.max = String(maxBots);
    if (document.activeElement !== bots) bots.value = String(s.settings.bots);
    botsVal.textContent = botsLabel(Number(bots.value));
    if (document.activeElement !== length) length.value = String(s.settings.matchMinutes);
    lenVal.textContent = `${length.value} min`;
    fill(bots);
    fill(length);
    diffInputs.forEach((d, i) => (d.checked = i === s.settings.difficulty));

    startBtn.hidden = !host;
    startBtn.disabled = s.phase !== Phase.Lobby || room.conn.status !== "open";
    waiting.hidden = host;
    waiting.textContent =
      s.phase === Phase.Lobby ? `Waiting for ${hostName} to start the match` : "The match is starting…";
  };

  const chatLine = (c: ChatLine) => {
    if (c.from === 0) return h("li", { class: "sys" }, c.text);
    return h("li", null, h("span", { class: "who", style: `--c:${colorHex(c.color)}` }, c.name), c.text);
  };
  const addChat = (c: ChatLine) => {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(chatLine(c));
    while (log.childElementCount > 100) log.firstElementChild?.remove();
    if (nearBottom) log.scrollTop = log.scrollHeight;
  };
  const resetChat = () => {
    clear(log);
    for (const c of room.chat) log.append(chatLine(c));
    log.scrollTop = log.scrollHeight;
  };

  const setPing = () => {
    const ms = Math.round(room.rtt);
    pingText.textContent = ms > 0 ? `${ms} ms` : "…";
    ping.className = `ping-chip ${pingClass(ms)}`;
  };

  offs.push(room.onEvent("state", render));
  offs.push(room.onEvent("chat", addChat));
  offs.push(room.onEvent("welcome", () => queueMicrotask(resetChat)));
  offs.push(room.onEvent("pong", setPing));
  offs.push(room.onEvent("status", render));
  render();
  resetChat();
  setPing();

  return {
    el,
    dispose() {
      for (const off of offs) off();
    },
  };
}
