// In-game HUD (DOM overlay). Built once; update() touches only what changed.
import "./hud.css";
import { PickupKind, VehicleKind, WORLD_HALF, WORLD_SIZE, type World } from "../../../../shared/world/types";
import {
  Move, MAX_COATS, PAINT_WEAR_DELAY, PAINT_WEAR_TIME, RELOAD_TIME, hopperCap, hasUpgrade, upgradeName, type PlayerState, type SimSnapshot,
} from "../../../../shared/sim/index";
import {
  BOAT_ICON, damageArcSvg, emptySlotSvg, hex, hitMarkerSvg, PLAYER_ARROW, splatSvg, UPGRADE_BLURB, UPGRADE_COLORS, UPGRADE_ICONS, VESPA_ICON,
} from "./art";
import { blobSvg } from "../../ui/art";
import { renderMapImage } from "./mapImage";
import { STYLE_LABELS, splatVerb } from "../names";
import type { Settings } from "../settings";

export interface HudFrame {
  me: PlayerState | undefined;
  snap: SimSnapshot;
  /** Camera yaw (0 = +Z). */
  camYaw: number;
  interact: string | null;
  canShoot: boolean;
  spread: number;
  locked: boolean;
  /** pid → seconds since that player last fired (minimap pings). */
  noise: Map<number, number>;
  fps: string | null;
  scoped: boolean;
  /** Crosshair is over another player. */
  onTarget: boolean;
}

export interface HudCallbacks {
  onSpawnPick(i: number): void;
  onResume(): void;
  onLeave(): void;
  onSettings(s: Settings): void;
}

type El = HTMLElement;
function el(tag: string, cls = "", html = ""): El {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const TAU = Math.PI * 2;
/** Radar sweep: every RADAR_PERIOD s every living enemy's position is captured; blips stay solid for
 *  RADAR_SOLID s, then dim to RADAR_DIM until the next sweep replaces them. */
const RADAR_PERIOD = 6;
const RADAR_SOLID = 3;
const RADAR_DIM = 0.45;
/** Out-of-range radar blips pinned to the minimap rim / shown on the compass. */
const RADAR_NEAREST = 3;

interface Blip { id: number; x: number; z: number; color: number; name: string }

/** Enemy on the minimap: their color inside a thick cream ring and an ink outline, unmistakable against the terrain. */
function enemyDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: number): void {
  ctx.fillStyle = "#23374b";
  ctx.beginPath(); ctx.arc(x, y, r + 4.5, 0, TAU); ctx.fill();
  ctx.fillStyle = "#fffaf0";
  ctx.beginPath(); ctx.arc(x, y, r + 3, 0, TAU); ctx.fill();
  ctx.fillStyle = hex(color);
  ctx.strokeStyle = "#23374b";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke();
}
/** Compass bearing (rad, 0 = north = -Z, east = +X) of a yaw. */
function bearingOfYaw(yaw: number): number {
  return Math.atan2(Math.sin(yaw), -Math.cos(yaw));
}
function wrap(a: number): number {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

export class Hud {
  readonly root: El;
  private mapImg: HTMLCanvasElement;
  // crosshair
  private cross: El;
  private hitmark: El;
  private dmg: El;
  private dmgArcs: El[] = [];
  private dmgI = 0;
  private breath: El;
  private breathDots: El[] = [];
  // top
  private timer: El;
  private compass: El;
  private compassItems: { el: El; b: number }[] = [];
  private miniCanvas: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private miniT = 0;
  private radar: Blip[] = [];
  /** Seconds since the last radar sweep. */
  private radarAge = RADAR_PERIOD;
  private placeEl: El;
  private feedEl: El;
  private scoreEl: El;
  private upsEl: El;
  private lastUps = -1;
  // bottom
  private coatsEl: El;
  private coatSlots: El[] = [];
  private lastCoats: number[] = [];
  private vestEl: El;
  private ammoEl: El;
  private hopEl: El;
  private resEl: El;
  private pipsEl: El;
  private relEl: El;
  private barFill: El;
  private lastAmmo = "";
  private promptEl: El;
  private promptTxt: El;
  private toastsEl: El;
  private dripsEl: El;
  private vignette: El;
  private water: El;
  private clickEl: El;
  private speedEl: El;
  private scopeEl: El;
  private kick = 0;
  private speedK = 0;
  private fpsEl: El;
  // panels
  private boardEl: El | null = null;
  private mapPanel: El | null = null;
  private mapPins: El | null = null;
  private mapOpen = false;
  private deathEl: El | null = null;
  private pauseEl: El | null = null;
  private resultsEl: El | null = null;
  private spawnPicked = -1;
  private myColor = 0xffffff;
  private lastFrame: HudFrame | null = null;
  private lastAlive = true;
  private lastHeading = 99;
  private lastCx = 0;
  private lastCz = 0;

  constructor(mount: El, private world: World, private cb: HudCallbacks, private settings: Settings) {
    this.root = el("div", "ih");
    mount.appendChild(this.root);
    this.mapImg = renderMapImage(world, 1024);

    // overlays (bottom-most)
    this.water = el("div", "ih-water");
    this.vignette = el("div", "ih-vignette");
    this.dripsEl = el("div", "ih-drips");
    this.speedEl = el("div", "ih-speed");
    this.scopeEl = el("div", "ih-scope");
    this.root.append(this.water, this.speedEl, this.scopeEl, this.vignette, this.dripsEl);

    // crosshair
    this.cross = el("div", "ih-cross", `<i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="c"></i>`);
    this.hitmark = el("div", "ih-hitmark");
    this.dmg = el("div", "ih-dmg");
    for (let i = 0; i < 4; i++) {
      const a = el("div", "", damageArcSvg());
      this.dmg.appendChild(a);
      this.dmgArcs.push(a);
    }
    this.breath = el("div", "ih-breath hidden");
    for (let i = 0; i < 8; i++) { const b = el("b"); this.breath.appendChild(b); this.breathDots.push(b); }
    this.root.append(this.dmg, this.cross, this.hitmark, this.breath);

    // top center
    const top = el("div", "ih-top");
    this.timer = el("div", "ih-timer card num", "10:00");
    this.compass = el("div", "ih-compass");
    this.buildCompass();
    top.append(this.timer, this.compass);
    this.root.appendChild(top);

    // minimap
    const mini = el("div", "ih-mini");
    this.miniCanvas = document.createElement("canvas");
    this.miniCanvas.width = 256;
    this.miniCanvas.height = 256;
    this.miniCtx = this.miniCanvas.getContext("2d")!;
    mini.appendChild(this.miniCanvas);
    this.placeEl = el("div", "ih-place");
    this.feedEl = el("div", "ih-feed");
    this.root.append(mini, this.placeEl, this.feedEl);

    // top left
    this.scoreEl = el("div", "ih-score card", `<span class="big num">0</span><span class="lbl">splats</span>`);
    this.upsEl = el("div", "ih-ups");
    this.root.append(this.scoreEl, this.upsEl);

    // coats
    this.coatsEl = el("div", "ih-coats card");
    const lbl = el("div", "lbl", `<span>Paint</span>`);
    this.vestEl = el("span", "vest hidden", "VEST");
    lbl.appendChild(this.vestEl);
    const slots = el("div", "slots");
    for (let i = 0; i < MAX_COATS; i++) {
      const s = el("div", "slot", emptySlotSvg(i + 3));
      slots.appendChild(s);
      this.coatSlots.push(s);
    }
    this.coatsEl.append(lbl, slots);
    this.root.appendChild(this.coatsEl);

    // ammo
    this.ammoEl = el("div", "ih-ammo card");
    const count = el("div", "count");
    this.hopEl = el("span", "hop num", "20");
    this.resEl = el("span", "res num", "/ 60");
    count.append(this.hopEl, this.resEl);
    this.pipsEl = el("div", "pips");
    this.relEl = el("div", "rel");
    const bar = el("div", "bar");
    this.barFill = el("i");
    bar.appendChild(this.barFill);
    this.ammoEl.append(this.relEl, count, this.pipsEl, bar);
    this.root.appendChild(this.ammoEl);

    // prompt + toasts
    this.promptEl = el("div", "ih-prompt card hidden");
    this.promptEl.appendChild(el("kbd", "", "E"));
    this.promptTxt = el("span");
    this.promptEl.appendChild(this.promptTxt);
    this.toastsEl = el("div", "ih-toasts");
    this.clickEl = el("div", "ih-click card hidden", "Click to play");
    this.fpsEl = el("div", "ih-fps");
    this.root.append(this.promptEl, this.toastsEl, this.clickEl, this.fpsEl);
  }

  setColor(c: number): void {
    this.myColor = c;
  }

  // ------------------------------------------------------------------ compass
  private buildCompass(): void {
    const add = (html: string, cls: string, b: number) => {
      const e = el("div", cls, html);
      this.compass.appendChild(e);
      this.compassItems.push({ el: e, b });
    };
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    for (let i = 0; i < 72; i++) {
      const b = (i / 72) * TAU;
      if (i % 9 === 0) add(names[i / 9], "cd", b);
      else add("", i % 3 === 0 ? "tk big" : "tk", b);
    }
    for (const l of this.world.landmarks) {
      const e = el("div", "lm", l.name);
      this.compass.appendChild(e);
      this.compassItems.push({ el: e, b: NaN });
      (e as unknown as { lx: number; lz: number }).lx = l.x;
      (e as unknown as { lx: number; lz: number }).lz = l.z;
    }
    this.compass.appendChild(el("div", "mid"));
  }

  private lmScratch: { el: El; x: number; d: number }[] = [];
  private updateCompass(yaw: number, me: PlayerState | undefined): void {
    const heading = bearingOfYaw(yaw);
    const mx = me?.x ?? 0, mz = me?.z ?? 0;
    if (Math.abs(heading - this.lastHeading) < 0.0015 && Math.abs(mx - this.lastCx) + Math.abs(mz - this.lastCz) < 2) return;
    this.lastHeading = heading;
    this.lastCx = mx;
    this.lastCz = mz;
    const w = this.compass.clientWidth || 480;
    const fov = Math.PI * 0.75;
    const lms = this.lmScratch;
    lms.length = 0;
    for (const it of this.compassItems) {
      let b = it.b;
      let d = 0;
      if (Number.isNaN(b)) {
        if (!me) { it.el.style.display = "none"; continue; }
        const e = it.el as unknown as { lx: number; lz: number };
        const dx = e.lx - me.x, dz = e.lz - me.z;
        d = Math.hypot(dx, dz);
        if (d < 30 || d > 380) { it.el.style.display = "none"; continue; }
        b = Math.atan2(dx, -dz);
      }
      const rel = wrap(b - heading);
      if (Math.abs(rel) > fov / 2) { it.el.style.display = "none"; continue; }
      const x = (rel / fov + 0.5) * w;
      if (!Number.isNaN(it.b)) {
        it.el.style.display = "";
        it.el.style.left = x.toFixed(1) + "px";
      } else lms.push({ el: it.el, x, d });
    }
    // landmarks: nearest first, skip any that would overlap a closer one
    lms.sort((a, b) => a.d - b.d);
    const placed: number[] = [];
    for (const l of lms) {
      const half = (l.el.textContent!.length * 5.2) / 2 + 10;
      let ok = placed.length < 4;
      for (let i = 0; ok && i < placed.length; i += 2) if (Math.abs(placed[i] - l.x) < placed[i + 1] + half) ok = false;
      if (!ok) { l.el.style.display = "none"; continue; }
      placed.push(l.x, half);
      l.el.style.display = "";
      l.el.style.left = l.x.toFixed(1) + "px";
    }
  }

  // ------------------------------------------------------------------ radar
  private sweepRadar(f: HudFrame): void {
    this.radarAge = 0;
    this.radar = [];
    const me = f.me;
    for (const p of f.snap.players) {
      if ((me && p.id === me.id) || !p.alive) continue;
      const info = f.snap.info.get(p.id);
      this.radar.push({ id: p.id, x: p.x, z: p.z, color: info?.color ?? 0xf47b63, name: info?.name ?? "" });
    }
  }
  /** Visibility of the current radar blips: solid, then dimmed "last seen" until the next sweep. */
  private radarAlpha(): number {
    if (!this.radar.length) return 0;
    const t = Math.min(1, Math.max(0, (this.radarAge - RADAR_SOLID) / 1.2));
    return 1 - t * (1 - RADAR_DIM);
  }
  /** Radar blips sorted by distance from (x, z). */
  private radarByDistance(x: number, z: number): { b: Blip; d: number }[] {
    return this.radar.map((b) => ({ b, d: Math.hypot(b.x - x, b.z - z) })).sort((a, c) => a.d - c.d);
  }

  /** Gunfire on the compass: anyone who fired in the last few seconds within earshot, as a pip in their color. */
  private pings: El[] = [];
  private updateCompassPings(f: HudFrame): void {
    const me = f.me;
    let n = 0;
    if (me) {
      const w = this.compass.clientWidth || 480;
      const fov = Math.PI * 0.75;
      const heading = bearingOfYaw(f.camYaw);
      for (const p of f.snap.players) {
        if (p.id === me.id || !p.alive) continue;
        const t = f.noise.get(p.id);
        if (t === undefined || t > 3) continue;
        const dx = p.x - me.x, dz = p.z - me.z;
        const d = Math.hypot(dx, dz);
        if (d > 220 || d < 4) continue;
        const rel = wrap(Math.atan2(dx, -dz) - heading);
        const x = Math.max(-0.5, Math.min(0.5, rel / fov)) * w + w / 2;
        let e = this.pings[n];
        if (!e) { e = el("div", "ping"); this.compass.appendChild(e); this.pings.push(e); }
        e.style.display = "";
        e.style.left = x.toFixed(1) + "px";
        e.style.opacity = (1 - t / 3).toFixed(2);
        e.style.background = hex(f.snap.info.get(p.id)?.color ?? 0xf47b63);
        e.style.borderColor = "";
        e.classList.remove("radar");
        e.classList.toggle("edge", Math.abs(rel) > fov / 2);
        e.classList.toggle("near", d < 60);
        n++;
        if (n >= 8) break;
      }
      // the nearest radar blips, hollow, so you always know which way the fight is
      const ra = this.radarAlpha();
      if (ra > 0) {
        let k = 0;
        for (const { b, d } of this.radarByDistance(me.x, me.z)) {
          if (k >= RADAR_NEAREST || n >= 12) break;
          if (d < 4) continue;
          if ((f.noise.get(b.id) ?? 99) <= 3) continue; // already shown as gunfire
          const rel = wrap(Math.atan2(b.x - me.x, -(b.z - me.z)) - heading);
          const x = Math.max(-0.5, Math.min(0.5, rel / fov)) * w + w / 2;
          let e = this.pings[n];
          if (!e) { e = el("div", "ping"); this.compass.appendChild(e); this.pings.push(e); }
          e.style.display = "";
          e.style.left = x.toFixed(1) + "px";
          e.style.opacity = (ra * 0.9).toFixed(2);
          e.style.background = "transparent";
          e.style.borderColor = hex(b.color);
          e.classList.toggle("edge", Math.abs(rel) > fov / 2);
          e.classList.toggle("near", d < 60);
          e.classList.add("radar");
          n++;
          k++;
        }
      }
    }
    for (let i = n; i < this.pings.length; i++) this.pings[i].style.display = "none";
  }

  // ------------------------------------------------------------------ minimap
  private drawMinimap(f: HudFrame): void {
    const ctx = this.miniCtx, S = 256, me = f.me;
    ctx.save();
    ctx.fillStyle = "#4fb0c0";
    ctx.fillRect(0, 0, S, S);
    if (!me) { ctx.restore(); return; }
    const R = 95; // meters shown from centre to edge
    const k = S / 2 / R; // px per meter
    const imgK = this.mapImg.width / WORLD_SIZE;
    const rot = -Math.PI / 2 - Math.atan2(Math.cos(f.camYaw), Math.sin(f.camYaw));
    ctx.translate(S / 2, S / 2);
    ctx.rotate(rot);
    ctx.scale(k / imgK, k / imgK);
    ctx.drawImage(this.mapImg, -(me.x + WORLD_HALF) * imgK, -(me.z + WORLD_HALF) * imgK);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toMini = (x: number, z: number): [number, number] => {
      const dx = (x - me.x) * k, dz = (z - me.z) * k;
      const c = Math.cos(rot), s = Math.sin(rot);
      return [S / 2 + dx * c - dz * s, S / 2 + dx * s + dz * c];
    };
    // zipline tops
    for (const z of f.snap.ziplines) {
      const [ax, ay] = toMini(z.ax, z.az), [bx, by] = toMini(z.bx, z.bz);
      ctx.strokeStyle = "rgba(35,55,75,.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
    }
    // only people on the minimap: pickups and vehicles live on the big map (M)
    // radar sweep: a ring expanding from you, then fading "last seen" blips
    if (this.radarAge < 0.8) {
      const t = this.radarAge / 0.8;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.strokeStyle = "#fffaf0";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(S / 2, S / 2, t * S * 0.72, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const ra = this.radarAlpha();
    if (ra > 0) {
      let outside = 0;
      for (const { b } of this.radarByDistance(me.x, me.z)) {
        if ((f.noise.get(b.id) ?? 99) <= 3) continue;
        let [x, y] = toMini(b.x, b.z);
        const inside = x > 8 && y > 8 && x < S - 8 && y < S - 8;
        if (!inside) {
          if (outside >= RADAR_NEAREST) continue;
          outside++;
          // pin to the rim along the bearing
          const dx = x - S / 2, dy = y - S / 2, m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
          x = S / 2 + (dx / m) * (S / 2 - 8);
          y = S / 2 + (dy / m) * (S / 2 - 8);
        }
        ctx.globalAlpha = ra * (inside ? 1 : 0.85);
        enemyDot(ctx, x, y, inside ? 6.5 : 5, b.color);
      }
      ctx.globalAlpha = 1;
    }
    // noisy players (fired recently)
    for (const p of f.snap.players) {
      if (p.id === me.id || !p.alive) continue;
      const t = f.noise.get(p.id);
      if (t === undefined || t > 3) continue;
      const [x, y] = toMini(p.x, p.z);
      const a = 1 - t / 3;
      const info = f.snap.info.get(p.id);
      ctx.globalAlpha = a;
      enemyDot(ctx, Math.max(10, Math.min(S - 10, x)), Math.max(10, Math.min(S - 10, y)), 7 + (t < 0.3 ? 3 : 0), info?.color ?? 0xf47b63);
      ctx.globalAlpha = 1;
    }
    // me
    ctx.translate(S / 2, S / 2);
    ctx.fillStyle = "#f6c94c";
    ctx.strokeStyle = "#23374b";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 9); ctx.lineTo(0, 5); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, f: HudFrame): void {
    this.lastFrame = f;
    const me = f.me;
    // timer
    const tl = Math.ceil(f.snap.timeLeft);
    const tt = `${Math.floor(tl / 60)}:${String(tl % 60).padStart(2, "0")}`;
    if (this.timer.textContent !== tt) this.timer.textContent = tt;
    this.timer.classList.toggle("low", tl <= 30);
    this.timer.classList.toggle("final", tl <= 10 && tl > 0);

    this.radarAge += dt;
    if (this.radarAge >= RADAR_PERIOD) this.sweepRadar(f);
    this.updateCompass(f.camYaw, me);
    this.updateCompassPings(f);
    this.miniT -= dt;
    if (this.miniT <= 0) { this.miniT = 1 / 30; this.drawMinimap(f); }

    const alive = !!me?.alive;
    if (alive !== this.lastAlive) {
      this.lastAlive = alive;
      this.cross.classList.toggle("hidden", !alive);
      this.coatsEl.classList.toggle("hidden", !alive);
      this.ammoEl.classList.toggle("hidden", !alive);
    }
    if (me) {
      // crosshair spread (+ a kick per shot)
      this.kick = Math.max(0, this.kick - dt * 40);
      const gap = 6 + Math.min(30, f.spread * 420) + this.kick;
      this.cross.style.setProperty("--gap", gap.toFixed(1) + "px");
      this.cross.classList.toggle("aim", me.aiming);
      this.cross.classList.toggle("noshoot", !f.canShoot);
      this.cross.classList.toggle("target", f.onTarget);

      // breath
      const uw = me.move === Move.Underwater || (me.move === Move.Swim && me.breath < 0.99) || me.gasp > 0;
      this.breath.classList.toggle("hidden", !uw);
      if (uw) {
        const n = Math.ceil(me.breath * 8 - 0.001);
        for (let i = 0; i < 8; i++) this.breathDots[i].classList.toggle("gone", i >= n);
        this.breath.classList.toggle("low", me.breath < 0.28 && me.move === Move.Underwater);
      }
      this.water.classList.toggle("on", me.move === Move.Underwater || me.gasp > 0);
      this.water.classList.toggle("gasp", me.gasp > 0);

      // score
      const sc = String(me.score);
      const big = this.scoreEl.firstElementChild as El;
      if (big.textContent !== sc) big.textContent = sc;

      // upgrades
      if (me.upgrades !== this.lastUps) {
        this.lastUps = me.upgrades;
        this.upsEl.innerHTML = "";
        for (let k = 1; k <= 7; k++) {
          if (!(me.upgrades & (1 << k))) continue;
          const u = el("div", "up", UPGRADE_ICONS[k as PickupKind]);
          u.style.background = UPGRADE_COLORS[k as PickupKind];
          u.title = upgradeName(k as PickupKind);
          this.upsEl.appendChild(u);
        }
        this.vestEl.classList.toggle("hidden", !hasUpgrade(me, PickupKind.Vest));
      }

      // coats
      this.updateCoats(me);

      // ammo
      const cap = hopperCap(me);
      const key = `${me.hopper}/${me.reserve}/${cap}/${me.reload > 0 ? 1 : 0}`;
      if (key !== this.lastAmmo) {
        this.lastAmmo = key;
        this.hopEl.textContent = String(me.hopper);
        this.resEl.textContent = "/ " + me.reserve;
        let pips = "";
        for (let i = 0; i < cap; i++) pips += i < me.hopper ? "<i></i>" : `<i class="e"></i>`;
        this.pipsEl.innerHTML = pips;
        this.pipsEl.style.setProperty("--c", hex(this.myColor));
        this.ammoEl.classList.toggle("empty", me.hopper === 0);
        this.relEl.textContent = me.reload > 0 ? "Reloading…" : me.hopper === 0 ? (me.reserve > 0 ? "R — reload" : "Out of paint!") : "";
      }
      this.barFill.style.width = me.reload > 0 ? ((1 - me.reload / RELOAD_TIME) * 100).toFixed(1) + "%" : "0%";
    }

    // speed lines + scope
    const sp = me && me.alive ? Math.hypot(me.vx, me.vy * 0.6, me.vz) : 0;
    const want = me && me.alive && me.move !== Move.Vehicle ? Math.max(0, Math.min(1, (sp - 10.5) / 7)) : me && me.move === Move.Vehicle ? Math.max(0, Math.min(1, (sp - 11) / 6)) : 0;
    this.speedK += (want - this.speedK) * Math.min(1, dt * 6);
    this.speedEl.style.opacity = (this.speedK * 0.55).toFixed(3);
    this.scopeEl.classList.toggle("on", f.scoped);

    // interact prompt
    const show = !!f.interact && alive;
    this.promptEl.classList.toggle("hidden", !show);
    if (show && this.promptTxt.textContent !== f.interact) this.promptTxt.textContent = f.interact!;

    this.clickEl.classList.toggle("hidden", f.locked || !!this.pauseEl || !!this.resultsEl || !alive);
    this.placeEl.textContent = me ? this.placeName(me.x, me.z) : "";
    this.fpsEl.textContent = f.fps ?? "";

    if (this.boardEl) this.fillBoard();
    if (this.mapOpen && this.mapPins) { this.mapT -= dt; if (this.mapT <= 0) { this.mapT = 0.2; this.fillMapPins(); } }
    if (this.deathEl && me) {
      const s = this.deathEl.querySelector(".cd");
      if (s) s.textContent = me.spawnChoices.length ? (me.spawnPick >= 0 ? "Washing ashore…" : `Pick a spawn — 1 / 2 (auto in ${Math.max(0, Math.ceil(5.5 - me.deadT))})`) : "";
    }
  }
  private mapT = 0;

  private placeName(x: number, z: number): string {
    return this.placeAt(x, z);
  }

  /** Nearest landmark name within r m, or "". */
  placeAt(x: number, z: number, r = 90): string {
    let best = "", bd = r * r;
    for (const l of this.world.landmarks) {
      const d = (l.x - x) ** 2 + (l.z - z) ** 2;
      if (d < bd) { bd = d; best = l.name; }
    }
    return best;
  }

  private updateCoats(me: PlayerState): void {
    const c = me.coats;
    const prev = this.lastCoats;
    for (let i = 0; i < MAX_COATS; i++) {
      const now = c[i], was = prev[i];
      if (now === was) continue;
      const slot = this.coatSlots[i];
      slot.classList.remove("fresh", "wash");
      void slot.offsetWidth;
      if (now !== undefined) {
        slot.innerHTML = splatSvg(now, i * 31 + now, { r: 30 });
        slot.classList.add("fresh");
      } else if (was !== undefined) {
        slot.classList.add("wash");
        setTimeout(() => { if (me.coats[i] === undefined) { slot.classList.remove("wash"); slot.innerHTML = emptySlotSvg(i + 3); } }, 900);
      }
    }
    this.lastCoats = c.slice();
    // the top coat fades as it dries and is about to flake off
    const wear = c.length ? Math.max(0, Math.min(1, (me.paintT - PAINT_WEAR_DELAY) / PAINT_WEAR_TIME)) : 0;
    for (let i = 0; i < MAX_COATS; i++) {
      const o = i === c.length - 1 && wear > 0 ? (1 - 0.6 * wear).toFixed(2) : "";
      if (this.coatSlots[i].style.opacity !== o) this.coatSlots[i].style.opacity = o;
    }
    this.coatsEl.classList.toggle("danger", c.length >= MAX_COATS - 1);
    this.vignette.classList.toggle("on", c.length >= MAX_COATS - 1 && me.alive);
    if (c.length) this.vignette.style.setProperty("--vc", hex(c[c.length - 1]) + "88");
  }

  // ------------------------------------------------------------------ events
  shotKick(): void {
    this.kick = Math.min(14, this.kick + 5);
  }

  /** E pressed on the prompt: squish it so the key feels answered. */
  promptPress(): void {
    const e = this.promptEl;
    e.classList.remove("press");
    void e.offsetWidth;
    e.classList.add("press");
  }

  /** soft: a predicted hit (not yet confirmed by the server). */
  hitMarker(elim: boolean, soft = false): void {
    const h = this.hitmark;
    h.innerHTML = hitMarkerSvg(elim);
    h.classList.toggle("elim", elim);
    h.classList.toggle("soft", soft);
    h.classList.remove("on");
    void h.offsetWidth;
    h.classList.add("on");
  }

  /** Damage from world-bearing `angle` relative to the camera (0 = in front). */
  damage(relAngle: number): void {
    const a = this.dmgArcs[this.dmgI++ % this.dmgArcs.length];
    a.style.transform = `rotate(${(relAngle * 180) / Math.PI}deg)`;
    a.classList.add("on");
    requestAnimationFrame(() => requestAnimationFrame(() => a.classList.remove("on")));
  }

  /** Paint drips at the screen edge in the shooter's color. */
  drip(color: number, relAngle: number): void {
    const d = el("div", "ih-drip", splatSvg(color, (Math.random() * 1e6) | 0, { ink: false, drips: true, r: 32 }));
    // place toward the hit side
    const s = Math.sin(relAngle), c = Math.cos(relAngle);
    const x = 50 + s * 42 + (Math.random() - 0.5) * 20;
    const y = 40 - c * 30 + (Math.random() - 0.5) * 30;
    d.style.left = `calc(${Math.max(-5, Math.min(90, x)).toFixed(1)}% - 11vmin)`;
    d.style.top = `calc(${Math.max(-5, Math.min(80, y)).toFixed(1)}% - 11vmin)`;
    d.style.transform = `rotate(${(Math.random() * 360) | 0}deg)`;
    this.dripsEl.appendChild(d);
    setTimeout(() => d.remove(), 2700);
  }

  toast(title: string, sub = "", color?: string): void {
    const t = el("div", "ih-toast card", `<div class="t">${title}</div>${sub ? `<div class="s">${sub}</div>` : ""}`);
    if (color) t.style.background = color;
    this.toastsEl.appendChild(t);
    while (this.toastsEl.children.length > 3) this.toastsEl.firstElementChild!.remove();
    setTimeout(() => t.remove(), 2500);
  }

  upgradeToast(kind: PickupKind): void {
    this.toast(upgradeName(kind) + "!", UPGRADE_BLURB[kind], UPGRADE_COLORS[kind]);
  }

  bigText(text: string, sub = "", streak = false): void {
    const b = el("div", "ih-big" + (streak ? " streak" : ""), `${text}${sub ? `<small>${escapeHtml(sub)}</small>` : ""}`);
    this.root.appendChild(b);
    setTimeout(() => b.remove(), 1350);
  }

  /** A place name fading in low on the screen as you arrive. */
  areaTitle(name: string): void {
    this.areaEl?.remove();
    const a = el("div", "ih-area", `<span>${escapeHtml(name)}</span>`);
    this.areaEl = a;
    this.root.appendChild(a);
    setTimeout(() => { a.remove(); if (this.areaEl === a) this.areaEl = null; }, 3600);
  }
  private areaEl: El | null = null;

  /**
   * The player who last painted me: a tag over their head (ndc = projected
   * position), or an arrow at the screen edge pointing at them. null hides it.
   */
  attacker(name: string | null, color = 0, ndc?: { x: number; y: number; z: number }, alpha = 1): void {
    let e = this.attackerEl;
    if (!name || !ndc) { if (e) e.style.display = "none"; return; }
    if (!e) {
      e = el("div", "ih-attacker", `<i class="arrow"></i><b></b>`);
      this.attackerEl = e;
      this.root.appendChild(e);
    }
    const b = e.querySelector("b")!;
    if (b.textContent !== name) b.textContent = name;
    e.style.setProperty("--c", hex(color));
    e.style.display = "";
    e.style.opacity = alpha.toFixed(2);
    const behind = ndc.z > 1;
    let x = behind ? -ndc.x : ndc.x, y = behind ? -ndc.y : ndc.y;
    const off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.86;
    if (off) {
      // push to the edge along the direction from the screen centre
      const m = Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.8, 1e-3);
      x /= m; y /= m;
      if (behind && Math.abs(x) < 0.3 && Math.abs(y) < 0.3) y = -0.8;
    }
    e.classList.toggle("edge", off);
    const ang = Math.atan2(-y, x);
    e.style.setProperty("--a", `${((ang * 180) / Math.PI - 90).toFixed(1)}deg`);
    e.style.transform = `translate(${((x * 0.5 + 0.5) * 100).toFixed(2)}vw, ${((-y * 0.5 + 0.5) * 100).toFixed(2)}vh)`;
  }
  private attackerEl: El | null = null;

  feed(killer: { name: string; color: number } | null, victim: { name: string; color: number }, tags: number, place: string, me: boolean, seed: number): void {
    const row = el("div", "row" + (me ? " me" : ""));
    const who = (p: { name: string; color: number }) => {
      const w = el("span", "who", escapeHtml(p.name));
      w.style.background = hex(p.color);
      return w;
    };
    if (killer && killer.name !== victim.name) {
      row.append(who(killer), el("span", "verb", splatVerb(seed)), who(victim));
    } else {
      row.append(who(victim), el("span", "verb", "got splatted"));
    }
    for (const [bit, label] of STYLE_LABELS) if (tags & bit) row.appendChild(el("span", "tag", label));
    if (place) row.appendChild(el("span", "at", "· " + escapeHtml(place)));
    this.feedEl.appendChild(row);
    while (this.feedEl.children.length > 5) this.feedEl.firstElementChild!.remove();
    setTimeout(() => { row.classList.add("out"); setTimeout(() => row.remove(), 650); }, 6500);
  }

  // ------------------------------------------------------------------ scoreboard
  setScoreboard(open: boolean): void {
    if (open && !this.boardEl) {
      this.boardEl = el("div", "ih-panel ih-board");
      this.boardEl.style.pointerEvents = "none";
      this.root.appendChild(this.boardEl);
      this.fillBoard();
    } else if (!open && this.boardEl) {
      this.boardEl.remove();
      this.boardEl = null;
    }
  }

  private boardKey = "";
  private fillBoard(): void {
    const f = this.lastFrame;
    if (!f || !this.boardEl) return;
    const rows = f.snap.players.map((p) => ({ p, i: f.snap.info.get(p.id) })).sort((a, b) => b.p.score - a.p.score || a.p.deaths - b.p.deaths);
    const key = rows.map((r) => `${r.p.id}:${r.p.score}:${r.p.deaths}:${r.p.alive ? 1 : 0}`).join("|");
    if (key === this.boardKey && this.boardEl.firstChild) return;
    this.boardKey = key;
    const tl = Math.ceil(f.snap.timeLeft);
    this.boardEl.innerHTML = `<div class="card"><h2>Classifica <em>·</em> ${escapeHtml(this.world.name)}</h2><p class="sub">${Math.floor(tl / 60)}:${String(tl % 60).padStart(2, "0")} left · most splats wins</p><table><thead><tr><th>#</th><th>Player</th><th class="n">Splats</th><th class="n">Splatted</th><th class="n">Style</th></tr></thead><tbody>${rows
      .map((r, idx) => `<tr class="${r.p.id === f.me?.id ? "me" : ""}"><td>${idx + 1}</td><td><span class="dot" style="background:${hex(r.i?.color ?? 0xffffff)}"></span>${escapeHtml(r.i?.name ?? "?")}${r.i?.isBot ? ' <span class="dim">· bot</span>' : ""}${r.p.alive ? "" : ' <span class="dim">· splatted</span>'}</td><td class="n">${r.p.score}</td><td class="n">${r.p.deaths}</td><td class="n">${r.p.style}</td></tr>`)
      .join("")}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------ big map
  toggleMap(force?: boolean): void {
    const open = force ?? !this.mapOpen;
    if (open === this.mapOpen) return;
    this.mapOpen = open;
    if (open) {
      this.mapPanel = el("div", "ih-panel ih-map");
      const card = el("div", "card");
      const head = el("div", "head", `<h2>${escapeHtml(this.world.name)}</h2><span class="legend"><b class="lg-foe"></b> enemies (last seen) · <b class="lg-tile"></b> pickups &amp; boats · M to close</span>`);
      const wrapEl = el("div", "wrap");
      const c = document.createElement("canvas");
      c.width = 1024; c.height = 1024;
      c.getContext("2d")!.drawImage(this.mapImg, 0, 0);
      this.mapPins = el("div", "");
      this.mapPins.style.cssText = "position:absolute;inset:0";
      wrapEl.append(c, this.mapPins);
      card.append(head, wrapEl);
      this.mapPanel.appendChild(card);
      this.mapPanel.addEventListener("click", (e) => { if (e.target === this.mapPanel && !this.deathEl) this.toggleMap(false); });
      this.root.appendChild(this.mapPanel);
      this.fillMapPins();
    } else {
      this.mapPanel?.remove();
      this.mapPanel = null;
      this.mapPins = null;
    }
  }

  get mapIsOpen(): boolean {
    return this.mapOpen;
  }

  private fillMapPins(): void {
    const f = this.lastFrame;
    const pins = this.mapPins;
    if (!f || !pins) return;
    pins.innerHTML = "";
    const pct = (v: number) => (((v + WORLD_HALF) / WORLD_SIZE) * 100).toFixed(2) + "%";
    const pin = (x: number, z: number, cls: string, html = "") => {
      const p = el("div", "pin " + cls, html);
      p.style.left = pct(x);
      p.style.top = pct(z);
      pins.appendChild(p);
      return p;
    };
    for (const l of this.world.landmarks) pin(l.x, l.z, "lm", escapeHtml(l.name));
    // things (not people): small square cream tiles with an icon
    for (const p of f.snap.pickups) {
      if (!p.active || p.kind === PickupKind.Ammo) continue;
      const e = pin(p.x, p.z, "tile", UPGRADE_ICONS[p.kind]);
      e.title = upgradeName(p.kind);
    }
    for (const v of f.snap.vehicles) {
      const e = pin(v.x, v.z, "tile", v.kind === VehicleKind.Vespa ? VESPA_ICON : BOAT_ICON);
      e.title = v.kind === VehicleKind.Vespa ? "Vespa" : v.kind === VehicleKind.Gondola ? "Gondola" : "Rowboat";
    }
    const ra = this.radarAlpha();
    if (ra > 0)
      for (const b of this.radar) {
        const e = pin(b.x, b.z, "foe", `<i></i>${blobSvg(hex(b.color), { size: 26 })}<span>${escapeHtml(b.name)}</span>`);
        e.style.opacity = ra.toFixed(2);
      }
    const me = f.me;
    if (me) {
      if (me.alive) {
        const e = pin(me.x, me.z, "me", PLAYER_ARROW);
        e.style.transform = `translate(-50%,-50%) rotate(${(bearingOfYaw(f.camYaw) * 180) / Math.PI}deg)`;
      }
      if (!me.alive && me.spawnChoices.length) {
        me.spawnChoices.forEach((si, i) => {
          const s = f.snap.spawns[si];
          if (!s) return;
          const e = pin(s.x, s.z, "spawn" + (me.spawnPick === i || this.spawnPicked === i ? " picked" : ""), `<span>${i + 1}</span>`);
          e.addEventListener("click", (ev) => { ev.stopPropagation(); this.spawnPicked = i; this.cb.onSpawnPick(i); this.fillMapPins(); });
        });
      }
    }
  }

  // ------------------------------------------------------------------ death
  showDeath(title: string, by: string | null, color: number): void {
    this.hideDeath();
    this.spawnPicked = -1;
    this.deathEl = el("div", "ih-death", `<div class="t">${escapeHtml(title)}</div><div class="s card">${by ? `by <b style="background:${hex(color)};padding:0 .4em;border-radius:.5em;border:2px solid #23374b">${escapeHtml(by)}</b>` : "Oops"} <span class="cd dim"></span></div>`);
    this.root.appendChild(this.deathEl);
  }
  openSpawnMap(): void {
    if (this.deathEl) this.toggleMap(true);
  }
  hideDeath(): void {
    this.deathEl?.remove();
    this.deathEl = null;
    if (this.mapOpen) this.toggleMap(false);
  }

  // ------------------------------------------------------------------ pause
  get paused(): boolean {
    return !!this.pauseEl;
  }
  showPause(open: boolean): void {
    if (!open) { this.pauseEl?.remove(); this.pauseEl = null; return; }
    if (this.pauseEl) return;
    const s = this.settings;
    const p = el("div", "ih-panel ih-pause");
    const card = el("div", "card");
    card.innerHTML = `<h2>Pausa <em>·</em> ${escapeHtml(this.world.name)}</h2><p class="sub">The match keeps going — nobody pauses the sea.</p>`;
    const row = (label: string, input: El, out: El) => { const r = el("div", "rowx"); r.append(el("span", "", label), input, out); card.appendChild(r); };
    const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, set: (v: number) => void) => {
      const i = document.createElement("input");
      i.type = "range"; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(val);
      const o = el("span", "num", fmt(val));
      i.addEventListener("input", () => { const v = Number(i.value); o.textContent = fmt(v); set(v); this.cb.onSettings(s); });
      row(label, i, o);
    };
    slider("Mouse sensitivity", 0.2, 3, 0.05, s.sensitivity, (v) => v.toFixed(2), (v) => { s.sensitivity = v; });
    slider("Aim sensitivity", 0.3, 1.2, 0.05, s.aimSensitivity, (v) => v.toFixed(2), (v) => { s.aimSensitivity = v; });
    slider("Field of view", 60, 95, 1, s.fov, (v) => v + "°", (v) => { s.fov = v; });
    slider("Volume", 0, 1, 0.05, s.volume, (v) => Math.round(v * 100) + "%", (v) => { s.volume = v; });
    const q = document.createElement("select");
    for (const k of ["low", "medium", "high"]) { const o = document.createElement("option"); o.value = k; o.textContent = k; if (k === s.quality) o.selected = true; q.appendChild(o); }
    q.addEventListener("change", () => { s.quality = q.value as Settings["quality"]; this.cb.onSettings(s); });
    row("Quality", q, el("span", "dim", "next load"));
    const inv = document.createElement("input");
    inv.type = "checkbox"; inv.checked = s.invertY;
    inv.addEventListener("change", () => { s.invertY = inv.checked; this.cb.onSettings(s); });
    row("Invert mouse Y", inv, el("span"));
    card.insertAdjacentHTML("beforeend", `<div class="ih-keys"><kbd>WASD</kbd><span>move</span><kbd>Shift</kbd><span>sprint</span><kbd>Space</kbd><span>jump / climb</span><kbd>C</kbd><span>slide · dive · swim down</span><kbd>LMB</kbd><span>fire</span><kbd>RMB</kbd><span>aim (shows the arc)</span><kbd>R</kbd><span>reload</span><kbd>E</kbd><span>boats · Vespa · zipline</span><kbd>Q</kbd><span>swap shoulder</span><kbd>M</kbd><span>map</span><kbd>Tab</kbd><span>scores</span><kbd>Esc</kbd><span>this menu</span></div>`);
    const btns = el("div", "ih-btns");
    const leave = el("button", "ih-btn", "Leave match");
    leave.addEventListener("click", () => this.cb.onLeave());
    const resume = el("button", "ih-btn go", "Back to the island");
    resume.addEventListener("click", () => this.cb.onResume());
    btns.append(leave, resume);
    card.appendChild(btns);
    p.appendChild(card);
    this.pauseEl = p;
    this.root.appendChild(p);
  }

  // ------------------------------------------------------------------ results
  showResults(rows: { id: number; name: string; color: number; score: number; deaths: number; style: number }[], meId: number, onAgain: () => void): void {
    this.resultsEl?.remove();
    const p = el("div", "ih-panel ih-results");
    const top = rows.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    const heights = [3.2, 4.6, 2.4];
    const podium = order.map((r) => {
      const place = top.indexOf(r!);
      return `<div class="pod"><div class="blob">${splatSvg(r!.color, r!.id * 7, { r: 34 })}</div><div><b>${escapeHtml(r!.name)}</b></div><div class="dim">${r!.score} splats</div><div class="step" style="height:${heights[place === 0 ? 1 : place === 1 ? 0 : 2]}em">${place + 1}</div></div>`;
    }).join("");
    const mine = rows.findIndex((r) => r.id === meId);
    const card = el("div", "card");
    const won = mine === 0 && rows[0].score > 0 && rows[0].score > (rows[1]?.score ?? -1);
    card.innerHTML = `<h2>${won ? "Hai vinto! <em>You win!</em>" : "Fine partita <em>·</em> time!"}</h2><p class="sub">${escapeHtml(this.world.name)} — you finished #${mine + 1}</p><div class="podium">${podium}</div><div class="ih-board"><table><tbody>${rows.map((r, i) => `<tr class="${r.id === meId ? "me" : ""}"><td>${i + 1}</td><td><span class="dot" style="background:${hex(r.color)}"></span>${escapeHtml(r.name)}</td><td class="n">${r.score}</td><td class="n">${r.deaths}</td><td class="n">${r.style}</td></tr>`).join("")}</tbody></table></div>`;
    const btns = el("div", "ih-btns");
    const again = el("button", "ih-btn go", "Play again");
    again.addEventListener("click", onAgain);
    btns.appendChild(again);
    card.appendChild(btns);
    p.appendChild(card);
    this.resultsEl = p;
    this.root.appendChild(p);
  }

  dispose(): void {
    this.root.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

