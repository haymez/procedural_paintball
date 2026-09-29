// Practice: the offline game — the whole match sim runs in this tab against
// dummy bots. Reached from the title screen (/practice).
import { prefs } from "../net/session";
import { PLAYER_COLORS } from "../../../shared/net/rules";
import { createWorldRenderer, createWorldViewAsync, type WorldView } from "../render/worldView";
import { friendlyStage } from "../ui/screens/loading";
import { sfxReady } from "./sfx";
import { loadWorld } from "../world/load";
import { Game } from "./game";
import { showLoading } from "./loading";
import { loadSettings } from "./settings";
import { LocalSource } from "./source";

export interface PracticeOptions {
  seed?: number;
  bots?: number;
  minutes?: number;
  onExit(): void;
}

export interface PracticeHandle {
  dispose(): void;
}

export function startPractice(mount: HTMLElement, opts: PracticeOptions): PracticeHandle {
  let disposed = false;
  let game: Game | null = null;
  let view: WorldView | null = null;
  let renderer: ReturnType<typeof createWorldRenderer> | null = null;
  const settings = loadSettings();
  const seed = opts.seed ?? Math.floor(Math.random() * 4294967296) >>> 0;
  const loading = showLoading(mount, "Practice");

  loadWorld(seed, (stage, t) => loading.progress(friendlyStage(stage), t * 0.65))
    .then(async (world) => {
      if (disposed) return;
      const r = createWorldRenderer(undefined, settings.quality);
      renderer = r;
      mount.appendChild(r.domElement);
      const v = await createWorldViewAsync(r, world, { quality: settings.quality }, (step, t) => {
        if (!disposed) loading.progress(friendlyStage(`render:${step}`), 0.65 + t * 0.3);
      });
      if (disposed) { v.dispose(); return; }
      view = v;
      loading.progress(friendlyStage("audio"), 0.96);
      await sfxReady(3000);
      if (disposed) return;
      const ci = prefs.color >= 0 ? prefs.color : 0;
      const hex = parseInt((PLAYER_COLORS[ci]?.hex ?? "#ff9eb5").slice(1), 16);
      const source = new LocalSource(world, { name: prefs.name, color: hex, dummies: opts.bots ?? 7, durationSec: (opts.minutes ?? 10) * 60 });
      game = new Game({ mount, world, source, renderer: r, view, settings, intro: true, onLeave: () => opts.onExit(), onPlayAgain: () => opts.onExit() });
      const W = window as unknown as { __debug: unknown; __stats: unknown };
      W.__debug = game.debugApi();
      const g = game;
      let frames = 0;
      g.frameHook = () => {
        if (++frames % 15 === 0) W.__stats = g.getStats();
      };
      game.start();
      loading.done();
    })
    .catch((e) => {
      console.error("[practice] world generation failed", e);
      opts.onExit();
    });

  return {
    dispose() {
      disposed = true;
      game?.dispose();
      view?.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
      game = null;
      view = null;
      renderer = null;
    },
  };
}
