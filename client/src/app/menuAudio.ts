// Menu-side sound: music on the title / browser / lobby screens (silent in a
// match), a jingle on the results, and a soft click on every button press.
// The audio engine loads lazily in its own chunk; until it's there (or if it
// fails) everything here is a silent no-op.
import type { AudioEngine } from "../audio/index";

let engine: AudioEngine | null = null;
let loading: Promise<AudioEngine | null> | null = null;
let wantMusic = false;
let pendingJingle: "win" | "lose" | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Promise<AudioEngine | null> {
  loading ??= import("../audio/index")
    .then((m) => {
      engine = m.getAudio();
      apply();
      return engine;
    })
    .catch((e) => {
      console.warn("[menu audio] unavailable", e);
      return null;
    });
  return loading;
}

function apply(): void {
  if (!engine) return;
  if (pendingJingle) {
    engine.music.jingle(pendingJingle);
    pendingJingle = null;
    return;
  }
  if (wantMusic) engine.music.play("menu");
  else engine.music.stop(700);
}

/** Menu music on (title, lobby…) or off (loading, match). */
export function menuMusic(on: boolean): void {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  if (wantMusic === on && !pendingJingle) return;
  wantMusic = on;
  if (engine) apply();
  else void load();
}

/** Results: a jingle, then the menu tune comes back. */
export function resultsJingle(won: boolean): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  wantMusic = false;
  pendingJingle = won ? "win" : "lose";
  if (engine) apply();
  else void load();
  resumeTimer = setTimeout(() => { resumeTimer = null; menuMusic(true); }, 6000);
}

let clicksOn = false;
/** One delegated listener: buttons and button-like links click. */
export function installUiClicks(root: Document = document): void {
  if (clicksOn) return;
  clicksOn = true;
  root.addEventListener("pointerdown", (e) => {
    const t = e.target as Element | null;
    const b = t?.closest?.("button, .btn, a[href], select, input[type=checkbox], input[type=range]");
    if (!b || (b as HTMLButtonElement).disabled) return;
    if (!engine) { void load(); return; }
    engine.play("ui_click", { bus: "ui", volume: 0.7 });
  }, { capture: true, passive: true });
}
