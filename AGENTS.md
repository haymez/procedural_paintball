# Isola — agent guide

A browser third-person paintball shooter on a procedurally generated tropical
island. The world aims at stylized realism: a lush volcanic Pacific island
(Kauai / Moorea) with CC0 photo textures, natural greens, realistic water and
sky, realism applied within each climate. The characters keep the soft
Pixar *Luca* look.
Free-for-all, up to 20 players per room, bots optional, multiplayer through
Cloudflare Durable Objects. Local-only for now (`npm run dev`).

## Game design (agreed with the user)

- **Characters**: human-shaped soft blobs (not humans), pastel, cute, a small
  sea-monster crest/fin as a *Luca* nod. They keep their own color in the
  water (no skin change); the fins just fan out and a little tail paddles.
- **Paint is health**: each hit coats you in the shooter's color; 3 coats =
  eliminated (splat into a puddle, then after ~3 s a **sky drop**, below).
  **Paint wears off** on its own: ~5 s
  after the last hit, one coat flakes off every ~4 s. **Water washes it off
  faster** (~1.5 s submerged per coat) — but swimming is slow, you can't
  shoot, and breath is limited: ~8 s submerged, then you're forced to the
  surface gasping and can't dive again for a few seconds.
- **Sky drop** (every spawn, match start included): you appear ~170–215 m
  over the middle of the island and glide down like a flying squirrel (limbs
  spread, skin flaps; `Move.Glide`), controlled like Apex Legends' skydive:
  the view steers and its pitch sets the flight path (look down to dive, level
  or up for the flattest glide: reaches any corner), W speeds up, S slows
  down, A/D slip. Speed carries: dive to build it, pull up and coast. No
  parachute: you splat onto the ground (`Move.Splat`, ~0.4 s pancake, no
  damage) and pop back up; water = belly-flop into a swim. No shooting and
  shielded for the whole drop + 1.5 s. While dropping, the HUD shows every
  enemy live, hot zones (hits/eliminations in the last 20 s) glow as light
  columns, and your landing spot is marked. Bots drop toward the action too.
- **Paint persists** on the world for the whole match.
- **Movement**: bouncy, arcade, squash-and-stretch. Sprint (unlimited), jump,
  slide, belly-flop dive, ledge mantle, cliff-jump into water, swim.
- **Paintball marker**: slow arcing projectiles (~45 m/s, gravity), effective
  range ~40 m, limited hopper + reserve. Ammo caches and upgrades around the
  island (BigHopper, RapidFire, LongBarrel, Scope, Vest, QuickFeet, Snorkel).
  Upgrades are lost on elimination and drop as a pickup, along with the
  victim's leftover paintballs (hopper + reserve).
- **Transport**: fast boats — jetskis (1 rider, hop off swells) on beaches
  and Riva-style speedboats (driver + 2 passengers who can shoot) at docks and
  cove jetties — Vespas on dirt paths, 2 pastel gyrocopters on open flat
  ground (arcade flight, pilot can't shoot, bail out any time), ziplines from
  high points. (Later: rope swings, stream currents, sidecars.)
- **Match**: 10-minute timed FFA, most eliminations wins. Host picks seed,
  bot count. Rooms via lobby list or 4-char code.
- **Island character** from the seed (shared/world/gen/character.ts), on top
  of the archetype: climate (lush rainforest / tropical / Mediterranean /
  dry), coast style (beaches / cliffs / calanque coves with jetties and moored
  speedboats / mixed) and relief (low and rolling … tall). Forests grow in
  contiguous stands (rainforest `Jungle`, holm-oak/pine `Forest`).
- **Places**: a living Polynesian / plantation town on every island (homes
  with lanai, store, hotel, church, thatched hale, green, sometimes a
  ballfield; shared/world/gen/village.ts), Pacific ruins (sugar mill, heiau,
  plantation manor; ruins.ts) plus lighthouse, boathouse, watchtower.
  Caves are multi-chamber networks with loops, 2–4 entrances, skylights and
  rock cover (pillars, slabs, low walls) inside.
- **Time of day** from the seed, always sunny (8:00–17:30), fair-weather
  cumulus with moving cloud shadows.
- **Audio**: CC0 SFX, biome-aware ambience, menu-only music.

## Architecture

```
shared/          Pure TS. No DOM, no Workers globals, no three.js. Runs in
                 browser, Web Worker, Durable Object and Node (vitest).
  math/          seeded RNG, deterministic noise, vector helpers
  world/         types.ts (THE CONTRACT), generator stages, collision queries
  sim/           movement / projectile / vehicle simulation shared by client
                 prediction and the authoritative server
  net/           binary protocol
client/src/      Browser game (three.js).
  render/        style.ts (shared materials/palette), terrain, water, sky,
                 foliage, structures, caves, actors/ (characters, vehicles, fx)
  game/ net/ ui/ audio/ workers/
tools/           Debug pages: map.html (2D map viewer), view.html (free-fly
                 3D world viewer), actors.html (character/vehicle showcase)
worker/          Cloudflare Worker + Durable Objects (IsolaLobby, IsolaRoom).
tests/           vitest (`npm test`).
scripts/shot.mjs Headless Chrome screenshot tool (real GPU).
```

- Imports are **relative** (no path aliases — TS 7 dropped baseUrl).
- `shared/world/types.ts` is the contract between generator, renderer, sim and
  server. Additive changes are fine; coordinate before changing existing fields.
- The server regenerates the world from the seed and needs identical collision
  data, so **world generation must be bit-deterministic across JS engines**:
  only `+ - * /`, `Math.sqrt`, `Math.floor/ceil/round/trunc/abs/min/max/sign`,
  `Math.imul`, `Math.fround`, integer bit ops. **Never** `Math.sin/cos/tan/
  atan2/exp/log/pow/hypot/cbrt`, `Math.random`, `Date`. Use the polynomial
  helpers in `shared/math` instead. Each stage draws from its own forked RNG
  stream so `skipDecor` can't perturb anything else.
- three.js r186, WebGL2 renderer. Vite 8 + `@cloudflare/vite-plugin`: one
  `npm run dev` serves client, Worker and DOs on http://localhost:5173.

## Working rules

- Stay inside the directories you were assigned; other agents are editing the
  rest of the tree concurrently. Don't reformat or "fix" their files. If you
  need a change in someone else's area, note it in your final report.
- Don't add npm dependencies without saying so in your report (three, vite,
  vitest, playwright-core, wrangler are installed).
- A dev server is normally already running on :5173. Check with
  `curl -s localhost:5173 >/dev/null`; if it's down, start `npm run dev` in the
  background. Never kill a server you didn't start.
- `npm run typecheck` checks everything; only errors in your own files are
  yours to fix while others are mid-change.
- No git commits.

## Verifying visually

```
node scripts/shot.mjs "http://localhost:5173/tools/view.html?seed=42" shots/view.png --wait=1500
```

Pages set `window.__ready = true` when the first good frame is up and may
expose `window.__stats` (fps, frame ms, draw calls, triangles) and
`window.__debug` (camera moves etc. for `--eval`). Look at the PNGs (Read
tool) and iterate on what you see. Headless Chrome uses the M2 GPU, so timing
numbers are meaningful. Put screenshots in `shots/` (gitignored).

## Performance budget

60 fps on an M1/M2 MacBook Air at 1080p on the default preset: aim for
< 10 ms GPU frame, < 400 draw calls, < 1.5 M triangles on screen. World
generation < 4 s in the browser (in a Web Worker), < 3 s with `skipDecor`.

`window.__ready/__stats/__debug` are declared once in tools/globals.d.ts; do not redeclare them.

## Textures

CC0 images live in `public/tex/<asset_id>/` (credits in `public/tex/CREDITS.md`).
Ground/rock sets are packed as `<id>_c.jpg` (sRGB color) and `<id>_nh.jpg`
(R,G = OpenGL normal xy, B = height). Load everything through
`client/src/render/assets.ts` so `WorldView.loading` (and `__ready`) waits
for it.
