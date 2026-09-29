// Hand-built SVG art for the menus: the travel-poster hero, the blob
// character, paint splats and small icons. Strings, parsed with html().

import { PLAYER_COLORS } from "../../../shared/net/index";

export function colorHex(i: number): string {
  return PLAYER_COLORS[i]?.hex ?? "#cccccc";
}

/** Darken/lighten a #rrggbb by mixing toward black/white. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** The player character: a soft gumdrop blob with a little sea-monster fin. */
export function blobSvg(hex: string, opts: { size?: number; marker?: boolean; cls?: string; blink?: boolean } = {}): string {
  const dark = shade(hex, -0.28);
  const light = shade(hex, 0.45);
  const fin = "#2a9d9b";
  const w = opts.marker ? 132 : 100;
  return `<svg class="blob ${opts.cls ?? ""}" viewBox="0 0 ${w} 120" width="${opts.size ?? 40}" aria-hidden="true">
  <path d="M34 16 L38 3 L45 12 L52 0 L58 11 L66 5 L66 18 Z" fill="${fin}" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
  <ellipse cx="36" cy="113" rx="13" ry="6" fill="${dark}" stroke="#23374b" stroke-width="3"/>
  <ellipse cx="64" cy="113" rx="13" ry="6" fill="${dark}" stroke="#23374b" stroke-width="3"/>
  <path d="M50 10 C79 10 91 42 91 70 C91 99 74 112 50 112 C26 112 9 99 9 70 C9 42 21 10 50 10 Z" fill="${hex}" stroke="#23374b" stroke-width="3.5"/>
  <ellipse cx="50" cy="84" rx="25" ry="21" fill="${light}" opacity=".55"/>
  <path d="M22 46 C24 32 32 22 42 19" stroke="#fff" stroke-width="5" stroke-linecap="round" fill="none" opacity=".55"/>
  <g class="${opts.blink ? "eyes blink" : "eyes"}">
    <ellipse cx="38" cy="52" rx="9" ry="11" fill="#fff" stroke="#23374b" stroke-width="2.5"/>
    <ellipse cx="63" cy="52" rx="9" ry="11" fill="#fff" stroke="#23374b" stroke-width="2.5"/>
    <circle cx="40" cy="54" r="4.6" fill="#23374b"/><circle cx="65" cy="54" r="4.6" fill="#23374b"/>
    <circle cx="41.8" cy="51.6" r="1.6" fill="#fff"/><circle cx="66.8" cy="51.6" r="1.6" fill="#fff"/>
  </g>
  <ellipse cx="27" cy="68" rx="6" ry="3.5" fill="#ff6f91" opacity=".45"/>
  <ellipse cx="74" cy="68" rx="6" ry="3.5" fill="#ff6f91" opacity=".45"/>
  <path d="M43 70 Q50 77 58 70" stroke="#23374b" stroke-width="3" fill="none" stroke-linecap="round"/>
  ${
    opts.marker
      ? `<g class="marker">
    <rect x="66" y="74" width="54" height="15" rx="7" fill="#f6c94c" stroke="#23374b" stroke-width="3"/>
    <rect x="112" y="77" width="16" height="9" rx="3" fill="#2a9d9b" stroke="#23374b" stroke-width="2.5"/>
    <circle cx="86" cy="66" r="10" fill="#f47b63" stroke="#23374b" stroke-width="3"/>
    <path d="M78 88 l-4 12 h10 l2 -12" fill="#e0b13a" stroke="#23374b" stroke-width="2.5" stroke-linejoin="round"/>
    <ellipse cx="72" cy="82" rx="9" ry="7" fill="${hex}" stroke="#23374b" stroke-width="3"/>
  </g>`
      : `<ellipse cx="11" cy="80" rx="8" ry="6" fill="${hex}" stroke="#23374b" stroke-width="3"/>
  <ellipse cx="89" cy="80" rx="8" ry="6" fill="${hex}" stroke="#23374b" stroke-width="3"/>`
  }
</svg>`;
}

/** A paint splat with drips. `seed` varies the shape. */
export function splatPath(cx: number, cy: number, r: number, seed: number): string {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const n = 11;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.72 + rnd() * 0.5);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const push = 1 + (rnd() - 0.4) * 0.5;
    d += ` Q${(cx + (mx - cx) * push * 1.12).toFixed(1)} ${(cy + (my - cy) * push * 1.12).toFixed(1)} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  }
  return d + " Z";
}

export function splatSvg(hex: string, seed: number, cls = ""): string {
  const drops = [0, 1, 2, 3]
    .map((i) => {
      const a = seed * 1.7 + i * 1.9;
      const d = 62 + ((seed * 13 + i * 29) % 22);
      const rr = 4 + ((seed + i * 7) % 6);
      return `<circle cx="${(50 + Math.cos(a) * d * 0.5).toFixed(1)}" cy="${(50 + Math.sin(a) * d * 0.5).toFixed(1)}" r="${rr}"/>`;
    })
    .join("");
  return `<svg class="splat ${cls}" viewBox="0 0 100 130" aria-hidden="true"><g fill="${hex}">
  <path d="${splatPath(50, 50, 30, seed)}"/>${drops}
  <path d="M44 70 C44 90 42 104 46 112 C50 118 54 112 53 104 C52 92 54 80 55 70 Z"/>
  </g></svg>`;
}

// The title poster: sun, sea, a pastel village island, a Vespa on the quay,
// and our blob hero — then someone got it with a paintball or three.
export function heroPoster(): string {
  const houses = [
    // x, y(bottom), w, h, wall, roof
    [560, 468, 46, 58, "#f5e0b5", 1],
    [604, 470, 40, 76, "#e89f8f", 0],
    [642, 466, 52, 50, "#f7d9a0", 1],
    [520, 480, 42, 44, "#b8d8c8", 0],
    [690, 470, 36, 64, "#f2c68c", 1],
    [585, 414, 44, 44, "#f7d9a0", 0],
    [628, 404, 38, 56, "#b8d8c8", 1],
    [664, 418, 46, 40, "#e8a87c", 0],
    [724, 476, 44, 46, "#f5e0b5", 0],
  ] as const;
  const houseSvg = houses
    .map(([x, y, w, hh, wall, gable]) => {
      const top = y - hh;
      const roof = gable
        ? `<path d="M${x - 4} ${top + 2} L${x + w / 2} ${top - 16} L${x + w + 4} ${top + 2} Z" fill="#c8643c" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>`
        : `<rect x="${x - 3}" y="${top - 7}" width="${w + 6}" height="9" rx="2" fill="#c8643c" stroke="#23374b" stroke-width="3"/>`;
      const win = [];
      for (let wy = top + 12; wy < y - 14; wy += 19) {
        for (let wx = x + 8; wx < x + w - 10; wx += 16) {
          win.push(`<rect x="${wx}" y="${wy}" width="7" height="10" rx="3" fill="#4f8a6b"/>`);
        }
      }
      return `<rect x="${x}" y="${top}" width="${w}" height="${hh}" fill="${wall}" stroke="#23374b" stroke-width="3"/>${roof}${win.join("")}`;
    })
    .join("");

  const rays = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * 360;
    return `<path d="M0 -120 L14 -330 L-14 -330 Z" transform="rotate(${a})" fill="${i % 2 ? "#fbe3a0" : "#fff3cf"}"/>`;
  }).join("");

  return `<svg class="poster-art" viewBox="0 0 900 800" preserveAspectRatio="xMidYMid slice" role="img" aria-label="A seaside village on a sunny island, a blob character and a Vespa on the quay">
  <defs>
    <linearGradient id="pSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9fd8d3"/><stop offset=".45" stop-color="#f6edcc"/><stop offset="1" stop-color="#fbd6a0"/>
    </linearGradient>
    <linearGradient id="pSea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5cc6be"/><stop offset="1" stop-color="#1f7f8c"/>
    </linearGradient>
    <clipPath id="pClip"><rect width="900" height="800"/></clipPath>
  </defs>
  <g clip-path="url(#pClip)">
  <rect width="900" height="800" fill="url(#pSky)"/>
  <g transform="translate(640 250)"><g class="sun-rays" opacity=".75">${rays}</g></g>
  <circle cx="640" cy="250" r="104" fill="#f6c94c"/>
  <circle cx="640" cy="250" r="104" fill="none" stroke="#f0b53a" stroke-width="10" opacity=".6"/>

  <g class="gulls" fill="none" stroke="#23374b" stroke-width="4" stroke-linecap="round">
    <path d="M470 150 q14 -14 26 0 q12 -14 26 0"/><path d="M520 100 q10 -10 18 0 q9 -10 18 0"/>
  </g>

  <path d="M0 470 L0 392 C60 370 120 388 170 402 C230 380 300 396 350 430 L380 470 Z" fill="#a8ccbf"/>
  <path d="M0 470 L0 420 C70 408 140 426 200 440 C250 432 300 446 330 470 Z" fill="#8fbfae"/>

  <!-- island -->
  <path d="M430 520 C450 470 490 440 530 430 C560 380 620 350 690 360 C760 368 820 410 860 460 C880 486 900 500 900 520 Z" fill="#8fbf55" stroke="#23374b" stroke-width="3.5"/>
  <path d="M430 520 C460 506 520 500 560 506 L900 506 L900 540 L430 540 Z" fill="#e9a77e" stroke="#23374b" stroke-width="3.5" stroke-linejoin="round"/>
  <path d="M470 540 L490 512 L520 540 Z M600 540 L630 510 L650 540 Z M760 540 L790 508 L820 540 Z" fill="#d98c68"/>
  ${houseSvg}
  <!-- campanile -->
  <rect x="740" y="360" width="30" height="110" fill="#f2c68c" stroke="#23374b" stroke-width="3"/>
  <path d="M736 362 L755 324 L774 362 Z" fill="#c8643c" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
  <rect x="749" y="376" width="12" height="18" rx="6" fill="#23374b"/>
  <!-- cypresses & umbrella pine -->
  <path d="M506 470 C496 440 500 400 510 376 C520 400 524 440 514 470 Z" fill="#3f7a4a" stroke="#23374b" stroke-width="3"/>
  <path d="M800 470 C790 444 794 410 803 390 C812 410 816 444 808 470 Z" fill="#3f7a4a" stroke="#23374b" stroke-width="3"/>
  <path d="M836 420 L836 468" stroke="#6b4428" stroke-width="7"/>
  <path d="M800 426 C804 400 868 398 876 424 C860 432 816 432 800 426 Z" fill="#5d8f45" stroke="#23374b" stroke-width="3"/>

  <!-- boat -->
  <g class="boat">
    <path d="M230 520 L330 520 L316 540 L246 540 Z" fill="#fff6e3" stroke="#23374b" stroke-width="3.5" stroke-linejoin="round"/>
    <rect x="236" y="525" width="88" height="5" fill="#f47b63"/>
    <path d="M282 516 L282 440" stroke="#23374b" stroke-width="3.5"/>
    <path d="M286 446 L324 510 L286 510 Z" fill="#fff6e3" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
    <path d="M278 452 L246 508 L278 508 Z" fill="#f6c94c" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
  </g>

  <!-- sea -->
  <path class="wave w1" d="M-40 530 C20 518 60 518 110 530 S200 542 260 530 S350 518 410 530 S500 542 560 530 S650 518 710 530 S800 542 860 530 S950 518 1000 530 L1000 800 L-40 800 Z" fill="#6fd0c6"/>
  <path class="wave w2" d="M-40 580 C20 566 70 566 120 580 S220 594 280 580 S380 566 440 580 S540 594 600 580 S700 566 760 580 S860 594 920 580 L1000 580 L1000 800 L-40 800 Z" fill="#3eb2ad"/>
  <path class="wave w3" d="M-40 640 C30 626 80 626 140 640 S250 654 310 640 S420 626 480 640 S590 654 650 640 S760 626 820 640 S930 654 1000 640 L1000 800 L-40 800 Z" fill="#23909a"/>
  <g stroke="#fff6e3" stroke-width="4" stroke-linecap="round" opacity=".7" class="glints">
    <path d="M520 600 h40"/><path d="M600 616 h24"/><path d="M700 596 h32"/><path d="M760 690 h40"/><path d="M640 720 h28"/>
  </g>

  <!-- quay -->
  <path d="M-10 660 L520 660 C540 660 548 668 548 680 L548 810 L-10 810 Z" fill="#f3dcb4" stroke="#23374b" stroke-width="4"/>
  <path d="M-10 690 L548 690" stroke="#23374b" stroke-width="3"/>
  <g stroke="#d9bd8f" stroke-width="3">
    <path d="M60 690 v120 M150 660 v30 M230 690 v120 M320 660 v30 M410 690 v120 M480 660 v30"/>
  </g>
  <rect x="470" y="628" width="26" height="36" rx="10" fill="#6b4428" stroke="#23374b" stroke-width="3.5"/>

  <!-- vespa -->
  <g class="vespa" transform="translate(70 548)">
    <circle cx="36" cy="104" r="20" fill="#23374b"/><circle cx="36" cy="104" r="8" fill="#fff6e3"/>
    <circle cx="156" cy="104" r="20" fill="#23374b"/><circle cx="156" cy="104" r="8" fill="#fff6e3"/>
    <path d="M4 92 C2 60 30 48 70 52 L106 56 C112 76 118 88 132 92 Z" fill="#8fd3c0" stroke="#23374b" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M46 52 C52 36 84 34 100 44 L102 54 Z" fill="#c8643c" stroke="#23374b" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M130 92 L150 18 C160 16 166 22 164 30 L148 94 Z" fill="#8fd3c0" stroke="#23374b" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M132 94 C150 76 174 78 184 94 Z" fill="#8fd3c0" stroke="#23374b" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M142 16 L176 10" stroke="#23374b" stroke-width="5" stroke-linecap="round"/>
    <circle cx="164" cy="30" r="8" fill="#fff3cf" stroke="#23374b" stroke-width="3"/>
    <path d="M14 74 C30 66 60 66 92 72" stroke="#fff" stroke-width="4" fill="none" opacity=".6" stroke-linecap="round"/>
  </g>

  <!-- hero blob -->
  <g class="hero-blob" transform="translate(292 520) scale(1.12)">${blobInner("#ff8a7a")}</g>
  </g>
  <g class="splats">
    <g transform="translate(40 40) scale(1.7)"><path d="${splatPath(50, 50, 30, 3)}" fill="#f47b63"/><circle cx="96" cy="30" r="6" fill="#f47b63"/><circle cx="12" cy="86" r="5" fill="#f47b63"/><path d="M42 72 C42 96 40 112 45 122 C50 128 55 120 54 108 C53 94 55 82 56 72 Z" fill="#f47b63"/></g>
    <g transform="translate(790 560) scale(.9)"><path d="${splatPath(50, 50, 30, 8)}" fill="#f6c94c"/><circle cx="8" cy="20" r="6" fill="#f6c94c"/><circle cx="94" cy="70" r="4" fill="#f6c94c"/></g>
    <g transform="translate(820 60) scale(.7)"><path d="${splatPath(50, 50, 30, 5)}" fill="#8c7cf0"/><circle cx="4" cy="60" r="6" fill="#8c7cf0"/></g>
  </g>
</svg>`;
}

// The blob drawn inside another SVG (no outer <svg>), holding a marker.
function blobInner(hex: string): string {
  const inner = blobSvg(hex, { marker: true, blink: true });
  return inner.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

export const icons = {
  crown: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="#f6c94c" stroke="#23374b" stroke-width="2" stroke-linejoin="round"/></svg>`,
  dice: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="#fff" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.6" fill="currentColor"/></svg>`,
  link: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3.5-3.5a4 4 0 0 0-5.7-5.7L12 6.3M14 10a4 4 0 0 0-5.7 0l-3.5 3.5a4 4 0 0 0 5.7 5.7l1.5-1.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  back: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  send: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-7-6 16-2.5-6.5z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>`,
  bot: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="5" fill="#fff6e3" stroke="#23374b" stroke-width="2"/><path d="M12 7V3.5" stroke="#23374b" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="3" r="1.6" fill="#f47b63"/><circle cx="9" cy="13" r="1.7" fill="#23374b"/><circle cx="15" cy="13" r="1.7" fill="#23374b"/></svg>`,
  signal: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18v-3M10 18v-6M15 18v-9M20 18V6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`,
  refresh: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.1-5M19 4v4h-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

/** Little boat for the loading route. */
export function boatSvg(hex: string): string {
  return `<svg class="route-boat" viewBox="0 0 80 60" aria-hidden="true">
    <path d="M36 42 L36 6" stroke="#23374b" stroke-width="3"/>
    <path d="M39 9 L64 38 L39 38 Z" fill="#fff6e3" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
    <path d="M33 13 L14 38 L33 38 Z" fill="${hex}" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
    <path d="M6 42 L74 42 L64 56 L16 56 Z" fill="${hex}" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
    <rect x="12" y="45" width="56" height="4" fill="#fff6e3" opacity=".8"/>
  </svg>`;
}

/** Small island for the end of the loading route. */
export function isletSvg(): string {
  return `<svg class="route-islet" viewBox="0 0 160 110" aria-hidden="true">
    <path d="M8 92 C22 60 50 44 80 44 C112 44 140 62 152 92 Z" fill="#8fbf55" stroke="#23374b" stroke-width="3.5"/>
    <path d="M8 92 L152 92 L148 100 L12 100 Z" fill="#e9a77e" stroke="#23374b" stroke-width="3.5" stroke-linejoin="round"/>
    <rect x="58" y="52" width="24" height="26" fill="#f5e0b5" stroke="#23374b" stroke-width="3"/>
    <path d="M55 54 L70 40 L85 54 Z" fill="#c8643c" stroke="#23374b" stroke-width="3" stroke-linejoin="round"/>
    <rect x="86" y="60" width="22" height="18" fill="#e89f8f" stroke="#23374b" stroke-width="3"/>
    <rect x="84" y="54" width="26" height="7" rx="2" fill="#c8643c" stroke="#23374b" stroke-width="3"/>
    <path d="M40 78 C34 60 37 40 44 26 C51 40 54 60 48 78 Z" fill="#3f7a4a" stroke="#23374b" stroke-width="3"/>
    <path d="M124 78 L124 52" stroke="#6b4428" stroke-width="5"/>
    <path d="M104 54 C108 38 142 38 146 54 C136 60 114 60 104 54 Z" fill="#5d8f45" stroke="#23374b" stroke-width="3"/>
  </svg>`;
}
