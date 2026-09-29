// Screen routing.
//
//   /           title
//   /rooms      room browser (live)
//   /r/CODE     a room: lobby, loading, match, or results — whichever the room
//               phase and my own status call for
//
// The room screens follow the server: every RoomState push re-runs syncRoom(),
// which picks the view. Leaving a room URL (Leave button or browser back)
// leaves the room.

import { ErrCode, Phase, PlayerStatus, Close, type MatchBeginMsg } from "../../../shared/net/index";
import { LobbyFeed, createRoom, lookupRoom, quickJoin } from "../net/lobby";
import { RoomClient } from "../net/room";
import { codeFromPath, inviteLink, roomPath } from "../net/session";
import { blobSvg } from "../ui/art";
import { copyText, h, html } from "../ui/dom";
import { browserScreen } from "../ui/screens/browser";
import { loadingScreen, type LoadingScreen } from "../ui/screens/loading";
import { lobbyScreen } from "../ui/screens/lobby";
import { resultsScreen, type ResultsScreen } from "../ui/screens/results";
import { titleScreen } from "../ui/screens/title";
import { ConnBanner, toast } from "../ui/toast";
import { loadGame, startMatch, type MatchContext, type MatchHandle } from "./match";
import { installUiClicks, menuMusic, resultsJingle } from "./menuAudio";

type View = "title" | "browser" | "joining" | "lobby" | "loading" | "match" | "results" | "notice" | "practice";

interface ActiveMatch {
  seed: number;
  handle: MatchHandle;
  mount: HTMLElement;
  begun: boolean;
  stage: string;
  t: number;
}

const PROGRESS_SEND_MS = 150;

export class App {
  view: View | null = null;
  room: RoomClient | null = null;

  private disposeView: (() => void) | null = null;
  private roomOffs: (() => void)[] = [];
  private banner: ConnBanner | null = null;
  private match: ActiveMatch | null = null;
  private loading: LoadingScreen | null = null;
  private results: ResultsScreen | null = null;
  private lastProgressSent = 0;
  private firstRender = true;

  constructor(private readonly root: HTMLElement) {}

  start(): void {
    installUiClicks();
    addEventListener("popstate", () => this.route());
    this.route();
  }

  navigate(path: string, replace = false): void {
    if (location.pathname !== path) history[replace ? "replaceState" : "pushState"](null, "", path);
    this.route();
  }

  private route(): void {
    const code = codeFromPath(location.pathname);
    if (code) {
      this.enterRoom(code);
      return;
    }
    this.leaveRoom(true);
    if (location.pathname === "/rooms") this.showBrowser();
    else if (location.pathname === "/practice") this.showPractice();
    else {
      if (location.pathname !== "/") history.replaceState(null, "", "/");
      this.showTitle();
    }
  }

  // --- view plumbing ----------------------------------------------------------------

  private show(view: View, el: HTMLElement, title: string, dispose: (() => void) | null = null): void {
    this.disposeView?.();
    this.disposeView = dispose;
    this.loading = null;
    this.results = null;
    this.view = view;
    this.root.replaceChildren(el);
    document.title = title;
    if (!this.firstRender) {
      const h1 = el.querySelector("h1");
      if (h1) {
        h1.setAttribute("tabindex", "-1");
        h1.focus({ preventScroll: true });
      }
    }
    this.firstRender = false;
    // music in the menus; the match has its own soundscape (results: see showResults)
    if (view !== "results") menuMusic(view !== "match" && view !== "practice" && view !== "loading");
    (window as unknown as { __ready?: boolean }).__ready = true;
  }

  private showTitle(): void {
    const el = titleScreen({
      quickPlay: async () => {
        const r = await quickJoin();
        this.navigate(roomPath(r.code));
      },
      createRoom: async () => {
        const code = await createRoom(false);
        this.navigate(roomPath(code));
      },
      joinCode: async (code) => {
        const info = await lookupRoom(code);
        if (!info.exists) return `No open room with code ${code}. Check it with whoever sent it, or create a new room.`;
        this.navigate(roomPath(code));
        return null;
      },
      browse: () => this.navigate("/rooms"),
      practice: () => this.navigate("/practice"),
    });
    this.show("title", el, "Isola");
  }

  private showBrowser(): void {
    const feed = new LobbyFeed();
    const scr = browserScreen({
      back: () => this.navigate("/"),
      join: (code) => this.navigate(roomPath(code)),
      create: async () => {
        const code = await createRoom(true);
        this.navigate(roomPath(code));
      },
    });
    const offs = [feed.onList((r) => scr.setRooms(r)), feed.onStatus((s) => scr.setStatus(s))];
    this.show("browser", scr.el, "Open rooms – Isola", () => {
      offs.forEach((o) => o());
      feed.close();
    });
  }

  /** Offline game against bots, in this tab. */
  private showPractice(): void {
    const mount = h("div", { class: "match-mount" });
    document.body.append(mount);
    let handle: { dispose(): void } | null = null;
    let gone = false;
    loadGame()
      .then((m) => {
        if (!gone) handle = m.startPractice(mount, { onExit: () => this.navigate("/") });
      })
      .catch((e) => {
        console.error("practice failed to load", e);
        this.navigate("/");
      });
    this.show("practice", h("div", { class: "sr-only" }, h("h1", null, "Practice")), "Practice – Isola", () => {
      gone = true;
      handle?.dispose();
      mount.remove();
    });
  }

  private showNotice(title: string, body: string, buttons: [string, () => void, string?][]): void {
    const el = h(
      "main",
      { class: "notice" },
      h(
        "div",
        { class: "card" },
        html(blobSvg("#8fd3c0", { size: 96 })),
        h("h1", { class: "display" }, title),
        h("p", { class: "muted" }, body),
        h(
          "div",
          { style: "display:flex;gap:.8rem;flex-wrap:wrap;justify-content:center" },
          buttons.map(([label, fn, cls]) => h("button", { class: `btn ${cls ?? ""}`, type: "button", onclick: fn }, label)),
        ),
      ),
    );
    this.show("notice", el, `${title} – Isola`);
  }

  // --- rooms ------------------------------------------------------------------------------

  private enterRoom(code: string): void {
    if (this.room?.code === code) {
      this.syncRoom();
      return;
    }
    this.leaveRoom(false);
    const room = new RoomClient(code);
    this.room = room;
    this.banner = new ConnBanner(() => room.conn.retryNow());
    this.roomOffs = [
      room.onEvent("state", () => this.syncRoom()),
      room.onEvent("results", () => this.syncRoom()),
      room.onEvent("begin", (m) => this.onBegin(m)),
      room.onEvent("status", (s) => {
        this.banner?.set(s);
        if (s === "closed") this.onRoomClosed(room);
      }),
      room.onEvent("error", (e) => {
        if (e.code === ErrCode.NotFound || e.code === ErrCode.Full || e.code === ErrCode.Idle) return; // close follows
        toast(e.text, e.code === ErrCode.WorldMismatch ? "warn" : "info");
      }),
    ];
    this.showNotice("Joining…", `Finding room ${code}.`, [["Cancel", () => this.navigate("/")]]);
    this.view = "joining";
  }

  /** Leave the current room. `send` = tell the server (frees the slot now). */
  private leaveRoom(send: boolean): void {
    const room = this.room;
    if (!room) return;
    this.disposeMatch();
    this.roomOffs.forEach((o) => o());
    this.roomOffs = [];
    this.banner?.dispose();
    this.banner = null;
    this.room = null;
    if (send && room.conn.status === "open") room.leave();
    else room.dispose();
  }

  private onRoomClosed(room: RoomClient): void {
    if (room !== this.room) return;
    const info = room.conn.closeInfo;
    const code = room.code;
    const home: [string, () => void] = ["Back to the harbour", () => this.navigate("/")];
    this.leaveRoom(false);
    switch (info?.code) {
      case Close.NotFound:
        this.showNotice(`No room ${code}`, "It may have closed, or the code has a typo. You can start a fresh room instead.", [
          home,
          [
            "Create a room",
            async () => {
              const c = await createRoom(false);
              this.navigate(roomPath(c));
            },
            "primary",
          ],
        ]);
        break;
      case Close.Full:
        this.showNotice("This room is full", "Twenty players already. Try another room from the list.", [
          home,
          ["Browse rooms", () => this.navigate("/rooms"), "sun"],
        ]);
        break;
      case Close.Replaced:
        this.showNotice("Open in another tab", "This room took over in another tab of this browser.", [
          home,
          ["Play here instead", () => this.enterRoom(code), "primary"],
        ]);
        break;
      case Close.Idle:
        this.showNotice("The room closed", "It was quiet for a long while, so the room closed.", [home]);
        break;
      default:
        this.showNotice("Disconnected", "The room connection ended.", [home, ["Rejoin", () => this.enterRoom(code), "primary"]]);
    }
  }

  private syncRoom(): void {
    const room = this.room;
    const s = room?.state;
    if (!room || !s) return;
    const me = room.myPlayer;
    const inMatch = s.phase === Phase.Loading || s.phase === Phase.Playing;

    if (inMatch && me) {
      this.ensureMatch(s.settings.seed);
      const m = this.match!;
      if (s.phase === Phase.Playing && me.status === PlayerStatus.Ready && m.begun) this.showMatchView();
      else this.showLoading();
      return;
    }
    this.disposeMatch();
    if (s.phase === Phase.Results && room.results) this.showResults();
    else this.showLobby();
  }

  private showLobby(): void {
    const room = this.room!;
    if (this.view === "lobby") return;
    const scr = lobbyScreen(room, {
      leave: () => this.navigate("/"),
      copyInvite: async () => {
        const ok = await copyText(inviteLink(room.code));
        toast(ok ? "Invite link copied" : inviteLink(room.code), ok ? "good" : "info", ok ? 2200 : 8000);
      },
    });
    const updateTitle = () => {
      document.title = `${room.state?.settings.name ?? "Room"} (${room.code}) – Isola`;
    };
    const off = room.onEvent("state", updateTitle);
    this.show("lobby", scr.el, "Isola", () => {
      off();
      scr.dispose();
    });
    updateTitle();
  }

  private showLoading(): void {
    const room = this.room!;
    const s = room.state!;
    this.match!.mount.hidden = true;
    if (this.view !== "loading" || !this.loading) {
      const scr = loadingScreen(s.settings.seed, room.myPlayer?.color ?? 0);
      this.show("loading", scr.el, "Loading – Isola");
      this.loading = scr;
      if (this.match!.stage) scr.setProgress(this.match!.stage, this.match!.t);
    }
    this.loading!.setRoom(s, room.me);
  }

  private showMatchView(): void {
    if (this.view === "match") return;
    const el = h("div", { class: "sr-only" }, h("h1", null, "In the match"));
    this.show("match", el, "Isola");
    this.match!.mount.hidden = false;
  }

  private showResults(): void {
    const room = this.room!;
    if (this.view === "results" && this.results) {
      this.results.tick(room.serverNow(), room.state);
      return;
    }
    const scr = resultsScreen(room.results!, room.me, room.isHost, {
      backToLobby: () => room.backToLobby(),
      leave: () => this.navigate("/"),
    });
    const timer = setInterval(() => scr.tick(room.serverNow(), room.state), 500);
    this.show("results", scr.el, "Match over – Isola", () => clearInterval(timer));
    this.results = scr;
    scr.tick(room.serverNow(), room.state);
    const rows = room.results!.rows;
    resultsJingle(rows[0]?.id === room.me && (rows[0]?.score ?? 0) > 0);
  }

  // --- match hook ---------------------------------------------------------------------------

  private ensureMatch(seed: number): void {
    if (this.match && this.match.seed === seed) return;
    this.disposeMatch();
    const room = this.room!;
    const mount = h("div", { class: "match-mount", hidden: true });
    document.body.append(mount);
    const active: ActiveMatch = { seed, handle: null as unknown as MatchHandle, mount, begun: false, stage: "", t: 0 };
    this.match = active;
    const ctx: MatchContext = {
      seed,
      room,
      mount,
      net: {
        send: (def, msg) => room.send(def, msg),
        on: (def, fn) => room.on(def, fn),
        serverNow: () => room.serverNow(),
        rtt: () => room.rtt,
        setPingInterval: (ms) => room.setPingInterval(ms),
      },
      loading: {
        setProgress: (stage, t) => {
          if (this.match !== active) return;
          active.stage = stage;
          active.t = t;
          this.loading?.setProgress(stage, t);
          const now = performance.now();
          if (now - this.lastProgressSent >= PROGRESS_SEND_MS || t >= 1) {
            this.lastProgressSent = now;
            room.progress(t);
          }
        },
      },
      worldReady: (checksum) => {
        if (this.match === active) room.worldReady(seed, checksum);
      },
      exit: () => {
        if (room.isHost) room.backToLobby();
        else this.navigate("/");
      },
    };
    try {
      active.handle = startMatch(ctx);
    } catch (e) {
      console.error("startMatch threw", e);
      active.handle = { begin() {}, dispose() {} };
      toast("The game failed to start on this device.", "warn");
    }
    // A MatchBegin may already be here (reconnect while playing).
    if (room.begin && room.begin.seed === seed) this.onBegin(room.begin);
  }

  private onBegin(info: MatchBeginMsg): void {
    const m = this.match;
    if (!m || m.seed !== info.seed || m.begun) {
      if (m && m.begun) this.syncRoom();
      return;
    }
    m.begun = true;
    try {
      m.handle.begin(info);
    } catch (e) {
      console.error("match begin threw", e);
    }
    this.syncRoom();
  }

  private disposeMatch(): void {
    const m = this.match;
    if (!m) return;
    this.match = null;
    try {
      m.handle.dispose();
    } catch (e) {
      console.error("match dispose threw", e);
    }
    m.mount.remove();
    if (this.room) this.room.worldSeed = -1;
  }
}
