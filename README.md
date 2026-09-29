# Isola

A browser third-person paintball free-for-all on procedurally generated
Italian-Riviera islands (think Pixar's *Luca*). Soft pastel blobs, slow arcing
paintballs, and **paint is health**: three coats and you splat into a puddle;
jump in the sea to wash paint off. Rowboats, gondolas, Vespas and ziplines, caves
and villages, all generated from a seed. Up to 20 players per room plus bots,
multiplayer through Cloudflare Durable Objects. Most splats in the time limit wins.

## Run it

```sh
npm install
npm run dev          # client + Worker + Durable Objects on one server
```

Open http://localhost:5173 — **Play now** drops you in an open room (or makes
one), **Create room** gives you a 4-letter code / invite link, **Practice with
bots** runs everything offline in the tab.

## Controls

| | |
|---|---|
| WASD · Shift | move · sprint |
| Space | jump / climb ledges |
| C (Ctrl) | slide · dive in the air · swim down |
| Mouse · LMB · RMB | look · fire · aim (shows the arc) |
| R | reload |
| E (F) | boats, Vespa, zipline, hop off |
| Q | swap shoulder |
| M · Tab · Esc | map · scores · menu (settings) |
| 1 / 2 | pick a spawn when splatted |

## Dev tools

- `/tools/map.html?seed=N` 2D map viewer · `/tools/view.html?seed=N` free-fly
  world viewer · `/tools/actors.html` characters and vehicles ·
  `/tools/play.html?seed=N&bots=12` offline match with real bot brains
  (`&spectate=1`, `&quality=`, `&fps=1`) · `/tools/audio.html` sound bank ·
  `/tools/nav.html` bot nav graph.
- Any page: `?lag=120&jitter=20&loss=2` simulates a bad network (sticks for the
  tab, `?lag=0` clears it). **F3** (or `?net=1`) toggles the net stats overlay.
- In a match `window.__debug` has helpers (`state()`, `tp(x, z)`, `bots(0|1|2)`,
  `summon(id)`, `input({...}, ms)`, …) and `window.__stats` fps / draws /
  triangles / net stats.

## Layout

```
shared/     pure TS, runs everywhere (browser, worker, DO, Node)
  world/    deterministic island generator + collision (types.ts is the contract)
  sim/      movement, paintballs, vehicles, the match rules (client + server)
  net/      binary protocol, lobby/room messages
  bots/     nav graph, pathing, bot brains (bots run on the server)
client/src/ app (menus, routing), game (client, prediction, HUD, camera),
            render (three.js world + actors), audio (synthesised, no files), ui
worker/     Cloudflare Worker: IsolaLobby + IsolaRoom Durable Objects
tools/      the debug pages above
tests/      vitest
scripts/    headless-Chrome checks and load tools
```

## Tests and scripts

```sh
npm run typecheck
npx vitest run                  # ~1-2 min
npx vite build
```

Against a running dev server (headless Chrome, screenshots under `shots/`):

- `node scripts/shot.mjs <url> out.png [--eval=js]` — screenshot + stats
- `node scripts/e2e-rooms.mjs` — lobby, codes, reconnect, late join, results
- `node scripts/e2e-match.mjs [--lag=120 --jitter=20]` — 3 players: prediction, hits, smoothness
- `node scripts/playtest.mjs [--matches=3]` — solo full flow (bots, combat, water, pickups,
  vehicle, results, next match) with leak checks (heap, GL, listeners, timers)
- `node scripts/stall.mjs` — frozen tab / low fps / hidden tab resync
- `node scripts/netload.mjs`, `node scripts/botsim.mjs` — server load and headless bot matches
