// Small SVG art for the HUD: paint splats, upgrade glyphs, arrows.
import { PickupKind } from "../../../../shared/world/types";

function rnd(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

/** A wobbly paint splat path centred on (50, 50). */
export function splatPath(seed: number, r = 34, lobes = 7): string {
  const R = rnd(seed);
  const n = 28;
  const ph = R() * 6.28;
  const amp = [R() * 0.2 + 0.08, R() * 0.12, R() * 0.08];
  let d = "";
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + amp[0] * Math.sin(a * lobes + ph) + amp[1] * Math.sin(a * (lobes + 4) + ph * 2) + amp[2] * Math.sin(a * 3 + ph);
    const x = 50 + Math.cos(a) * r * k, y = 50 + Math.sin(a) * r * k;
    d += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
  }
  return d + "Z";
}

/** Splat with satellite droplets, filled with `color`, inked outline. */
export function splatSvg(color: number, seed: number, opts: { ink?: boolean; drips?: boolean; r?: number } = {}): string {
  const R = rnd(seed + 99);
  const r = opts.r ?? 30;
  let dots = "";
  for (let i = 0; i < 5; i++) {
    const a = R() * 6.28, dd = r * (1.2 + R() * 0.45), s = 2 + R() * 4;
    dots += `<circle cx="${(50 + Math.cos(a) * dd).toFixed(1)}" cy="${(50 + Math.sin(a) * dd).toFixed(1)}" r="${s.toFixed(1)}"/>`;
  }
  let drips = "";
  if (opts.drips) {
    for (let i = 0; i < 3; i++) {
      const x = 50 + (R() - 0.5) * r * 1.2, len = 12 + R() * 30, w = 3 + R() * 4;
      drips += `<path d="M${(x - w).toFixed(1)} 55 L${(x - w * 0.6).toFixed(1)} ${(60 + len).toFixed(1)} A${w.toFixed(1)} ${w.toFixed(1)} 0 0 0 ${(x + w * 0.6).toFixed(1)} ${(60 + len).toFixed(1)} L${(x + w).toFixed(1)} 55Z"/>`;
    }
  }
  const stroke = opts.ink === false ? "" : `stroke="#23374b" stroke-width="3" stroke-linejoin="round"`;
  return `<svg viewBox="0 0 100 100"><g fill="${hex(color)}" ${stroke}><path d="${splatPath(seed, r)}"/>${drips}</g><g fill="${hex(color)}">${dots}</g><ellipse cx="40" cy="38" rx="7" ry="4" fill="#fff" opacity=".45" transform="rotate(-30 40 38)"/></svg>`;
}

/** Empty coat slot: dashed outline blob. */
export function emptySlotSvg(seed: number): string {
  return `<svg viewBox="0 0 100 100"><path d="${splatPath(seed, 28, 5)}" fill="rgba(35,55,75,.06)" stroke="#23374b" stroke-width="3" stroke-dasharray="7 6" opacity=".45"/></svg>`;
}

const I = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="#23374b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const UPGRADE_ICONS: Record<PickupKind, string> = {
  [PickupKind.Ammo]: I(`<circle cx="8" cy="14" r="4" fill="#ff9eb5"/><circle cx="16" cy="14" r="4" fill="#8fe0c0"/><circle cx="12" cy="8" r="4" fill="#fff08a"/>`),
  [PickupKind.BigHopper]: I(`<path d="M6 8h12l-1.5 11h-9z" fill="#fff"/><circle cx="10" cy="12" r="1.6" fill="#ff9eb5"/><circle cx="14" cy="15" r="1.6" fill="#8cc8ff"/><path d="M9 5h6"/>`),
  [PickupKind.RapidFire]: I(`<path d="M13 3L6 13h5l-1 8 7-10h-5z" fill="#fff08a"/>`),
  [PickupKind.LongBarrel]: I(`<path d="M3 12h15" stroke-width="4"/><path d="M18 9l3 3-3 3" /><circle cx="6" cy="12" r="1" fill="#23374b"/>`),
  [PickupKind.Scope]: I(`<circle cx="12" cy="12" r="7" fill="#fff"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="1.5" fill="#f47b63"/>`),
  [PickupKind.Vest]: I(`<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z" fill="#fff"/><path d="M9 12l2 2 4-4"/>`),
  [PickupKind.QuickFeet]: I(`<path d="M4 16c3 0 5-1 7-4l2 1c1 2 3 3 7 3v3H4z" fill="#fff"/><path d="M3 9h5M2 12h4"/>`),
  [PickupKind.Snorkel]: I(`<path d="M16 3v9a4 4 0 0 1-4 4H9" /><rect x="3" y="12" width="7" height="6" rx="3" fill="#9fe3ef"/>`),
};

export const UPGRADE_COLORS: Record<PickupKind, string> = {
  [PickupKind.Ammo]: "#ff9e6b",
  [PickupKind.BigHopper]: "#ffd84a",
  [PickupKind.RapidFire]: "#ff8a70",
  [PickupKind.LongBarrel]: "#8cc3ff",
  [PickupKind.Scope]: "#c7a6ff",
  [PickupKind.Vest]: "#ffae66",
  [PickupKind.QuickFeet]: "#8fe39a",
  [PickupKind.Snorkel]: "#7fe0dc",
};

export const UPGRADE_BLURB: Record<PickupKind, string> = {
  [PickupKind.Ammo]: "Hopper topped up",
  [PickupKind.BigHopper]: "Bigger hopper — more balls before reloading",
  [PickupKind.RapidFire]: "Faster trigger",
  [PickupKind.LongBarrel]: "Faster, flatter shots",
  [PickupKind.Scope]: "Hold right-click for a big zoom",
  [PickupKind.Vest]: "Shrugs off the next hit",
  [PickupKind.QuickFeet]: "Run faster",
  [PickupKind.Snorkel]: "Double breath underwater",
};

/** Map glyphs for vehicles (drawn inside a white tile on the full map). */
export const VESPA_ICON = I(`<circle cx="6.5" cy="17" r="3" fill="#fff"/><circle cx="17.5" cy="17" r="3" fill="#fff"/><path d="M6.5 17h6l3-7h-3M15.5 10l2 7M9 12h4" /><path d="M14 6h3" />`);
/** Speedboat (a little Riva with its windscreen). */
export const BOAT_ICON = I(`<path d="M2 13h16l4-2-1.5 5c-.6 2-2 3-4 3H6.5c-2 0-3.6-2-4.5-6z" fill="#c8764a"/><path d="M8 13l2-3.5h4l1 3.5"/><path d="M1 22c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1" stroke-width="1.6"/>`);
export const JETSKI_ICON = I(`<path d="M2 16h14l5-3v1.5c0 2.5-2 3.5-4 3.5H5c-1.5 0-3-.5-3-2z" fill="#9fd8c8"/><path d="M8 16v-2.5h4.5L15 9"/><path d="M13.5 9h3.5"/><path d="M1 22c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1" stroke-width="1.6"/>`);
export const GYRO_ICON = I(`<path d="M2 4.5h20"/><path d="M12 4.5V9"/><ellipse cx="11" cy="13" rx="5.5" ry="4" fill="#f7d77a"/><path d="M16.5 13l5-1.5v4"/><circle cx="8" cy="20.5" r="1.5" fill="#fff"/><circle cx="14" cy="20.5" r="1.5" fill="#fff"/><path d="M8 17v2M14 17v2"/>`);

export const PLAYER_ARROW = `<svg viewBox="0 0 24 24"><path d="M12 2l7 18-7-4-7 4z" fill="#f6c94c" stroke="#23374b" stroke-width="2.5" stroke-linejoin="round"/></svg>`;

export function damageArcSvg(): string {
  return `<svg viewBox="0 0 120 120"><path d="M34 18 A50 50 0 0 1 86 18" fill="none" stroke="#f47b63" stroke-width="9" stroke-linecap="round"/><path d="M34 18 A50 50 0 0 1 86 18" fill="none" stroke="#23374b" stroke-width="2.5" stroke-linecap="round" opacity=".7"/></svg>`;
}

export function hitMarkerSvg(elim: boolean): string {
  if (elim) return `<svg viewBox="0 0 100 100">${`<path d="${splatPath(7, 26, 6)}" fill="#f47b63" stroke="#23374b" stroke-width="5"/>`}<path d="M38 40l24 20M62 40L38 60" stroke="#fffaf0" stroke-width="7" stroke-linecap="round"/></svg>`;
  return `<svg viewBox="0 0 100 100" stroke-linecap="round"><g stroke="#23374b" stroke-width="12"><path d="M22 22l14 14M78 22L64 36M22 78l14-14M78 78L64 64"/></g><g stroke="#fffaf0" stroke-width="6"><path d="M22 22l14 14M78 22L64 36M22 78l14-14M78 78L64 64"/></g></svg>`;
}

export { hex };
