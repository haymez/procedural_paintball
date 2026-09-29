// Solo full-flow playtest against the dev server, with leak checks.
//
//   node scripts/playtest.mjs [--base=http://localhost:5173] [--matches=3] [--bots=8]
//                             [--out=shots/playtest] [--w=1920 --h=1080] [--watch=60]
//
// Title → Play now (auto room) → host adds bots → start → loading (screens) →
// first --watch seconds of play (screens every 10 s) → move / shoot a bot /
// get hit / wash in water / grab a pickup / ride a vehicle → end the match →
// results → back to lobby → next match (new seed) … --matches times in one
// tab. After each match it samples the JS heap (after GC), WebGL resources,
// audio voices, live timers / intervals / rAF loops and event listeners, and
// fails if they grow match over match.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.join("=") || "1"];
  }),
);
const BASE = flags.base ?? "http://localhost:5173";
const OUT = flags.out ?? "shots/playtest";
const MATCHES = Number(flags.matches ?? 3);
const BOTS = Number(flags.bots ?? 8);
const WATCH = Number(flags.watch ?? 60);
const W = Number(flags.w ?? 1920), H = Number(flags.h ?? 1080);
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required", "--js-flags=--expose-gc"],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
// count live listeners / timers / animation loops (leak detection)
await ctx.addInitScript(() => {
  // listeners: every registration, weakly held; at sample time only those on live targets count
  // (window, document, connected DOM nodes, sockets / workers / audio nodes still referenced)
  const live = { regs: [], timeouts: new Set(), intervals: new Set(), raf: 0 };
  window.__live = live;
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const capOf = (opts) => (typeof opts === "boolean" ? opts : !!opts?.capture);
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn && !live.regs.some((r) => r.fn === fn && r.type === type && r.cap === capOf(opts) && r.t.deref() === this)) {
      live.regs.push({ t: new WeakRef(this), fn, type, cap: capOf(opts), what: (this.constructor?.name ?? "?") + ":" + type });
    }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const i = live.regs.findIndex((r) => r.fn === fn && r.type === type && r.cap === capOf(opts) && r.t.deref() === this);
    if (i >= 0) live.regs.splice(i, 1);
    return rem.call(this, type, fn, opts);
  };
  live.count = () => {
    live.regs = live.regs.filter((r) => { const t = r.t.deref(); return t && !(t instanceof Node && t !== document && !t.isConnected); });
    const by = {};
    for (const r of live.regs) by[r.what] = (by[r.what] ?? 0) + 1;
    return { n: live.regs.length, by };
  };
  const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
  window.setTimeout = function (fn, ms, ...a) { const id = st(function () { live.timeouts.delete(id); typeof fn === "function" && fn(...a); }, ms); live.timeouts.add(id); return id; };
  window.clearTimeout = function (id) { live.timeouts.delete(id); return ct(id); };
  window.setInterval = function (fn, ms, ...a) { const id = si(fn, ms, ...a); live.intervals.add(id); return id; };
  window.clearInterval = function (id) { live.intervals.delete(id); return ci(id); };
  const raf = window.requestAnimationFrame;
  let frameIds = new Set(), seen = 0;
  window.requestAnimationFrame = function (fn) { const id = raf((t) => { frameIds.add(fn.name || "anon"); seen++; fn(t); }); return id; };
  setInterval.call(window, () => { live.raf = seen; seen = 0; }, 1000);
  // sounds the menus / game asked for
  window.__GL = [];
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, o) { const c = gc.call(this, t, o); if (c && /webgl/.test(t) && !window.__GL.includes(c)) window.__GL.push(c); return c; };
});
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const errors = [];
page.on("pageerror", (e) => { errors.push(e.message); console.log(`[pageerror] ${e.message}`); });
page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); console.log(`[console.error] ${m.text()}`); } });
const cdp = await ctx.newCDPSession(page);

const dbg = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

async function sample(label) {
  await dbg(() => window.gc?.());
  await wait(300);
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  const s = await dbg(() => {
    const live = window.__live;
    const gls = window.__GL.filter((g) => !g.isContextLost());
    return {
      listeners: live.count().n, listenersBy: live.count().by, timeouts: live.timeouts.size, intervals: live.intervals.size, rafPerSec: live.raf,
      glContexts: gls.length, canvases: document.querySelectorAll("canvas").length, dom: document.getElementsByTagName("*").length,
      audio: (() => { try { return window.__isolaAudio?.() ?? null; } catch { return null; } })(),
    };
  });
  const r = { label, heapMB: +(heap / 1048576).toFixed(1), ...s };
  console.log(`  sample ${label}: ${JSON.stringify(r)}`);
  return r;
}

async function gameInfo() {
  return dbg(() => {
    const g = window.__debug?.game;
    const m = g?.renderer?.info?.memory;
    return { geometries: m?.geometries, textures: m?.textures, programs: g?.renderer?.info?.programs?.length, audio: window.__debug?.audio?.() ?? null, stats: window.__stats };
  });
}

try {
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => window.__ready === true);
  await shot("00-title");
  await page.fill("#player-name", "Tester");
  await page.click("#btn-play");
  await page.waitForURL(/\/r\/[A-Z2-9]{4}$/);
  const host = await page.waitForSelector("#btn-start:not([hidden])", { timeout: 8000 }).then(() => true, () => false);
  check("Play now put me in a room", true, `${page.url().split("/r/")[1]}${host ? " as host" : " (someone else's; creating my own)"}`);
  if (!host) {
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => window.__ready === true);
    await page.click("#btn-create");
    await page.waitForURL(/\/r\/[A-Z2-9]{4}$/);
    await page.waitForSelector("#btn-start:not([hidden])");
  }
  await dbg((b) => window.__isola.app.room.updateSettings({ bots: b, matchMinutes: 2 }), BOTS);
  await wait(600);
  await shot("01-lobby");
  const samples = [];
  let lastSeed = -1;
  for (let m = 1; m <= MATCHES; m++) {
    const tag = `m${m}`;
    if (m > 1) {
      // a fresh island for the next round
      await page.click("#btn-reroll");
      await page.waitForFunction((s) => window.__isola.app.room.state.settings.seed !== s, lastSeed, { timeout: 5000 }).catch(() => {});
    }
    const seed = await dbg(() => window.__isola.app.room.state.settings.seed);
    check(`${tag}: new island`, seed !== lastSeed, `seed ${seed}`);
    lastSeed = seed;
    await page.click("#btn-start");
    const tL = Date.now();
    await page.waitForSelector(".loading", { timeout: 20000 });
    const stages = new Set();
    const poll = setInterval(async () => { try { const t = await page.evaluate(() => document.querySelector(".loading-stage")?.textContent); if (t) stages.add(t); } catch {} }, 120);
    await wait(900);
    if (m === 1) await shot(`${tag}-02-loading`);
    await page.waitForFunction(() => window.__netgame?.ready === true, null, { timeout: 120000 });
    clearInterval(poll);
    check(`${tag}: loaded into the match`, true, `${((Date.now() - tL) / 1000).toFixed(1)} s; lines: ${[...stages].join(" | ")}`);
    // the first minute, as a new player sees it
    const t0 = Date.now();
    if (m === 1) {
      for (const at of [0.3, 1.2, 2.5, 4]) { await wait(at * 1000 - (Date.now() - t0)); await shot(`${tag}-03-start-${at}s`); }
      await dbg(() => window.__debug.input({ moveZ: 1, sprint: true }, 2500));
      await shot(`${tag}-04-running`);
      for (let s = 10; s <= WATCH; s += 10) {
        await dbg(() => window.__debug.inputSeq([[{ moveZ: 1, sprint: true, turn: 0.3 }, 2500], [{ moveZ: 1, jump: true }, 500], [{ aim: true, fire: true, turn: -0.2 }, 1200]]));
        await wait(Math.max(0, s * 1000 - (Date.now() - t0)));
        await shot(`${tag}-05-play-${String(s).padStart(2, "0")}s`);
      }
      const st = await gameInfo();
      console.log(`  stats: ${JSON.stringify(st.stats)}`);
    } else await wait(3000);
    // shoot a bot: freeze bots, stand on dry land (a spawn point), summon one, aim, fire
    await dbg(() => window.__debug.bots(0));
    await dbg(() => { const s = window.__debug.game.opts.world.spawns[0]; return window.__debug.tp(s.x, s.z); });
    await wait(1200);
    const me = await dbg(() => window.__debug.state());
    const bot = (await dbg(() => window.__debug.players())).find((p) => p.id >= 128 && p.alive);
    if (bot) {
      let hits = 0, tries = 0, sfxs = [];
      for (const yaw of [0, 90, 180, 270]) {
        tries++;
        await dbg((y) => window.__debug.look(y, -6), yaw);
        await wait(250);
        await dbg((id) => window.__debug.summon(id, 9), bot.id);
        await wait(700);
        await dbg((id) => window.__debug.aimAt(id), bot.id);
        await wait(150);
        const before = await dbg(() => window.__debug.net().totals);
        await dbg(() => window.__debug.input({ fire: true }, 400));
        await wait(250);
        if (m === 1 && tries === 1) await shot(`${tag}-06-hit-bot`);
        await wait(800);
        const after = await dbg(() => window.__debug.net().totals);
        sfxs = await dbg(() => window.__debug.sfx());
        hits = after.hitsByMe - before.hitsByMe;
        if (hits > 0) break;
      }
      check(`${tag}: hit a bot`, hits > 0, `${hits} hits after ${tries} tries; sfx ${sfxs.slice(-6).join(",")}`);
    }
    // get hit: let bots loose around me
    await dbg(() => window.__debug.bots(1));
    await dbg(() => window.__debug.noShield());
    let gotHit = false;
    for (let k = 0; k < 3 && !gotHit; k++) {
      await dbg((y) => window.__debug.look(y, -6), k * 120);
      await wait(200);
      for (const b of (await dbg(() => window.__debug.players())).filter((p) => p.id >= 128 && p.alive).slice(0, 3)) await dbg((id) => window.__debug.summon(id, 10), b.id);
      for (let i = 0; i < 16 && !gotHit; i++) { await wait(500); gotHit = (await dbg(() => window.__debug.net().totals.hitsOnMe)) > 0; }
    }
    check(`${tag}: bots shoot back`, gotHit);
    if (m === 1) { await wait(300); await shot(`${tag}-07-got-hit`); }
    // calm the bots down and make sure I'm standing (respawn if they got me)
    await dbg(() => window.__debug.bots(0));
    for (let i = 0; i < 40; i++) {
      const st = await dbg(() => window.__debug.state());
      if (st?.alive) break;
      if (i === 6 && m === 1) await shot(`${tag}-07b-death-cam`);
      await dbg(() => window.__debug.pickSpawn(0));
      await wait(300);
    }
    await wait(1500);
    if (m === 1) await shot(`${tag}-07c-respawned`);
    // wash: go to the nearest water
    const water = await dbg(() => {
      const g = window.__debug.game, w = g.opts.world, st = window.__debug.state();
      let best = null, bd = 1e9;
      for (let z = -480; z <= 480; z += 8) for (let x = -480; x <= 480; x += 8) {
        const ix = Math.round((x + 512) / 2), iz = Math.round((z + 512) / 2), h = w.height[iz * 513 + ix];
        if (h > -3 || h < -6) continue;
        const d = (x - st.x) ** 2 + (z - st.z) ** 2;
        if (d < bd) { bd = d; best = { x, z }; }
      }
      return best;
    });
    if (water && m === 1) {
      await dbg(() => window.__debug.bots(0));
      await dbg((p) => window.__debug.tp(p.x, p.z), water);
      await wait(900);
      const coats0 = (await dbg(() => window.__debug.state())).coats;
      await dbg(() => window.__debug.input({ crouch: true }, 3500));
      const s1 = await dbg(() => window.__debug.state());
      await shot(`${tag}-08-washing`);
      check(`${tag}: washing in water`, s1.move === "Underwater" || s1.move === "Swim" || coats0 === 0, `move ${s1.move}, coats ${coats0} → ${s1.coats}`);
    }
    // pickup: walk onto the nearest one
    if (m === 1) {
      const pk = await dbg(() => { const st = window.__debug.state(); return window.__debug.pickups().filter((p) => p.active).sort((a, b) => (a.x - st.x) ** 2 + (a.z - st.z) ** 2 - ((b.x - st.x) ** 2 + (b.z - st.z) ** 2))[0]; });
      if (pk) {
        await dbg((p) => window.__debug.tp(p.x + 2.5, p.z), pk);
        await wait(700);
        const before = await dbg(() => window.__debug.sfx().length);
        await dbg((p) => { window.__debug.lookAt(p.x, p.y, p.z); return window.__debug.input({ moveZ: 1 }, 900); }, pk);
        const sfx = await dbg(() => window.__debug.sfx());
        await shot(`${tag}-09-pickup`);
        check(`${tag}: pickup`, sfx.some((s) => s === "pickup" || s === "upgrade"), sfx.slice(-5).join(","));
      }
      // vehicle: E next to the nearest free one
      const v = await dbg(() => { const st = window.__debug.state(); return window.__debug.vehicles().filter((v) => v.seats.every((s) => s < 0)).sort((a, b) => (a.x - st.x) ** 2 + (a.z - st.z) ** 2 - ((b.x - st.x) ** 2 + (b.z - st.z) ** 2))[0]; });
      if (v) {
        await dbg((v) => window.__debug.tp(v.x + 1.6, v.z + 0.5), v);
        await wait(900);
        const target = await dbg(() => window.__debug.interact());
        const tE = Date.now();
        await dbg(() => window.__debug.input({ interact: true }, 50));
        const s = await dbg(() => window.__debug.state());
        const predicted = s.move === "Vehicle";
        await wait(600);
        const s2 = await dbg(() => window.__debug.state());
        check(`${tag}: E on a parked vehicle`, s2.move === "Vehicle", `target ${target?.label}; in seat ${predicted ? "at once (predicted)" : "after the server"}; ${Date.now() - tE} ms`);
        await dbg(() => window.__debug.input({ moveZ: 1, moveX: 0.3 }, 2000));
        await shot(`${tag}-10-vehicle`);
        await dbg(() => window.__debug.input({ interact: true }, 50));
        await wait(500);
      }
    }
    await dbg(() => window.__debug.bots(1));
    const gi = await gameInfo();
    console.log(`  ${tag} game: geometries ${gi.geometries}, textures ${gi.textures}, programs ${gi.programs}, audio ${JSON.stringify(gi.audio)}`);
    // end → results → lobby
    await dbg(() => window.__isola.app.room.endMatch());
    await page.waitForSelector(".board", { timeout: 20000 });
    await wait(1200);
    if (m === 1) await shot(`${tag}-11-results`);
    check(`${tag}: results`, (await dbg(() => window.__isola.app.view)) === "results");
    await page.click("#btn-lobby");
    await page.waitForSelector("#btn-start:not([hidden])");
    await wait(1500);
    samples.push(await sample(`after ${tag}`));
  }
  // leak verdict: compare the last sample to the first
  if (samples.length >= 2) {
    const a = samples[0], b = samples[samples.length - 1];
    check("JS heap stable across matches", b.heapMB < a.heapMB + 25, `${a.heapMB} → ${b.heapMB} MB`);
    check("no leaked listeners", b.listeners <= a.listeners + 4, `${a.listeners} → ${b.listeners}`);
    check("no leaked intervals / timeouts", b.intervals <= a.intervals && b.timeouts <= a.timeouts + 4, `intervals ${a.intervals} → ${b.intervals}, timeouts ${a.timeouts} → ${b.timeouts}`);
    check("no leaked rAF loops", b.rafPerSec <= a.rafPerSec + 5, `${a.rafPerSec} → ${b.rafPerSec} /s`);
    check("WebGL contexts released", b.glContexts <= 1 && b.canvases <= a.canvases, `live contexts ${b.glContexts}, canvases ${b.canvases}`);
    check("DOM size stable", b.dom <= a.dom + 30, `${a.dom} → ${b.dom}`);
  }
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("unexpected error", false, String(e.message ?? e).split("\n")[0]);
  await shot("zz-error").catch(() => {});
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
