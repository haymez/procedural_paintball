// Keyboard + mouse (pointer lock) → look angles and per-tick button state.
// Taps shorter than a tick are latched so they always reach the sim.
import { Btn } from "../../../shared/sim/index";
import type { Settings } from "./settings";

export interface InputHandlers {
  onPause?(): void;
  onMap?(): void;
  onScoreboard?(open: boolean): void;
  onShoulder?(): void;
  onLockChange?(locked: boolean): void;
}

export interface MoveSample {
  moveX: number;
  moveZ: number;
  buttons: number;
}

export interface InputOverride {
  moveX?: number;
  moveZ?: number;
  sprint?: boolean;
  jump?: boolean;
  crouch?: boolean;
  fire?: boolean;
  aim?: boolean;
  interact?: boolean;
  reload?: boolean;
  /** Turn rate while overriding (rad/s). */
  turn?: number;
}

const KEY_BTN: Record<string, number> = {
  Space: Btn.Jump,
  KeyC: Btn.Crouch,
  ControlLeft: Btn.Crouch,
  ShiftLeft: Btn.Sprint,
  ShiftRight: Btn.Sprint,
  KeyR: Btn.Reload,
  KeyE: Btn.Interact,
  KeyF: Btn.Interact,
};

export class Input {
  /** Camera look angles (rad). yaw 0 = +Z. */
  yaw = 0;
  pitch = -0.1;
  locked = false;
  enabled = true;
  private keys = new Set<string>();
  private held = 0;
  private latched = 0;
  private override: { o: InputOverride; until: number; done: () => void } | null = null;
  private overrideQueue: { o: InputOverride; ms: number; done: () => void }[] = [];
  private disposers: (() => void)[] = [];
  /** Accumulated mouse motion this frame (for camera sway). */
  lookDX = 0;
  lookDY = 0;
  aimSensMult = 1;

  constructor(private el: HTMLElement, private settings: Settings, private h: InputHandlers) {
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, "keydown", (e) => this.key(e, true));
    on(window, "keyup", (e) => this.key(e, false));
    on(window, "blur", () => { this.keys.clear(); this.held = 0; this.h.onScoreboard?.(false); });
    on(el, "mousedown", (e) => {
      if (!this.locked) { this.lock(); return; }
      if (e.button === 0) this.press(Btn.Fire);
      if (e.button === 2) this.press(Btn.Aim);
    });
    on(window, "mouseup", (e) => {
      if (e.button === 0) this.release(Btn.Fire);
      if (e.button === 2) this.release(Btn.Aim);
    });
    on(el, "contextmenu", (e) => e.preventDefault());
    on(window, "mousemove", (e) => {
      if (!this.locked || !this.enabled) return;
      const k = 0.0022 * this.settings.sensitivity * this.aimSensMult;
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k * (this.settings.invertY ? -1 : 1);
      if (this.pitch > 1.35) this.pitch = 1.35;
      if (this.pitch < -1.35) this.pitch = -1.35;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    });
    on(document, "pointerlockchange" as keyof WindowEventMap, () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) { this.held = 0; this.keys.clear(); }
      if (was !== this.locked) this.h.onLockChange?.(this.locked);
    });
  }

  lock(): void {
    const r = this.el.requestPointerLock?.() as unknown;
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
  }

  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private press(b: number): void {
    this.held |= b;
    this.latched |= b;
  }
  private release(b: number): void {
    this.held &= ~b;
  }

  private key(e: KeyboardEvent, down: boolean): void {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (typing) return;
    if (e.code === "Tab") {
      e.preventDefault();
      this.h.onScoreboard?.(down);
      return;
    }
    if (!down) {
      this.keys.delete(e.code);
      const b = KEY_BTN[e.code];
      if (b) this.release(b);
      return;
    }
    if (e.repeat) return;
    if (e.code === "Escape") { this.h.onPause?.(); return; }
    if (e.code === "KeyM") { this.h.onMap?.(); return; }
    if (e.code === "KeyQ") { this.h.onShoulder?.(); return; }
    if (!this.locked && e.code !== "Space") return;
    if (e.code === "Space" || e.code.startsWith("Arrow") || e.code === "ControlLeft") e.preventDefault();
    this.keys.add(e.code);
    const b = KEY_BTN[e.code];
    if (b) this.press(b);
  }

  private down(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** Scripted input for N ms (debug / headless verification). */
  setOverride(o: InputOverride, ms: number): Promise<void> {
    return this.setOverrideSeq([[o, ms]]);
  }

  /** Several scripted inputs back to back, switching exactly on tick boundaries. */
  setOverrideSeq(steps: [InputOverride, number][]): Promise<void> {
    if (this.override) this.override.done();
    this.override = null;
    for (const q of this.overrideQueue) q.done();
    this.overrideQueue.length = 0;
    return new Promise((resolve) => {
      steps.forEach(([o, ms], i) => this.overrideQueue.push({ o, ms, done: i === steps.length - 1 ? resolve : () => {} }));
      if (steps.length === 0) resolve();
    });
  }

  /** Called once per sim tick. */
  sample(out: MoveSample, dt: number): MoveSample {
    let ov = this.override;
    if (ov && performance.now() >= ov.until) {
      this.override = null;
      ov.done();
      ov = null;
    }
    if (!ov && this.overrideQueue.length) {
      const q = this.overrideQueue.shift()!;
      ov = this.override = { o: q.o, until: performance.now() + q.ms, done: q.done };
    }
    if (ov) {
      {
        const o = ov.o;
        out.moveX = o.moveX ?? 0;
        out.moveZ = o.moveZ ?? 0;
        out.buttons = (o.sprint ? Btn.Sprint : 0) | (o.jump ? Btn.Jump : 0) | (o.crouch ? Btn.Crouch : 0) |
          (o.fire ? Btn.Fire : 0) | (o.aim ? Btn.Aim : 0) | (o.interact ? Btn.Interact : 0) | (o.reload ? Btn.Reload : 0);
        if (o.turn) this.yaw += o.turn * dt;
        return out;
      }
    }
    if (!this.enabled) {
      out.moveX = 0; out.moveZ = 0; out.buttons = 0;
      this.latched = 0;
      return out;
    }
    let mx = 0, mz = 0;
    if (this.down("KeyW", "ArrowUp")) mz += 1;
    if (this.down("KeyS", "ArrowDown")) mz -= 1;
    if (this.down("KeyD", "ArrowRight")) mx += 1;
    if (this.down("KeyA", "ArrowLeft")) mx -= 1;
    out.moveX = mx;
    out.moveZ = mz;
    out.buttons = this.held | this.latched;
    this.latched = 0;
    return out;
  }

  get scripted(): boolean {
    return !!this.override || this.overrideQueue.length > 0;
  }

  isHeld(b: number): boolean {
    if (this.override) {
      const o = this.override.o;
      return b === Btn.Aim ? !!o.aim : b === Btn.Fire ? !!o.fire : false;
    }
    return (this.held & b) !== 0;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.unlock();
  }
}
