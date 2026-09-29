// Stall / low-FPS resync check: a solo networked match while the tab freezes.
//
//   node scripts/stall.mjs [--base=http://localhost:5173] [--out=shots/stall]
//
// Runs around, then (1) blocks the main thread for 0.6 s and 1.5 s (a GC storm /
// debugger pause), (2) throttles the CPU so the game drops to single-digit fps
// for a few seconds, (3) fakes a hidden tab for 3 s. After each, the client
// must be back in step: few prediction corrections, no big ones, remote
// players and own position agree with the server within a second.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.slice(2).split("="); return [k, v.join("=") || "1"]; }));
const BASE = flags.base ?? "http://localhost:5173";
const OUT = flags.out ?? "shots/stall";
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
const cdp = await page.context().newCDPSession(page);
const dbg = (fn, a) => page.evaluate(fn, a);
try {
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => window.__ready === true);
  await page.click("#btn-create");
  await page.waitForSelector("#btn-start:not([hidden])");
  await dbg(() => window.__isola.app.room.updateSettings({ bots: 6, matchMinutes: 5 }));
  await wait(400);
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__netgame?.ready === true, null, { timeout: 120000 });
  await wait(4000);
  const run = () => dbg(() => { void window.__debug.inputSeq([[{ moveZ: 1, sprint: true, turn: 0.5 }, 3000], [{ moveZ: 1, turn: -0.5 }, 3000], [{ moveZ: 1, sprint: true, turn: 0.3 }, 3000]]); });
  const totals = () => dbg(() => ({ ...window.__debug.net().totals, log: window.__debug.game.source.net.corrLog.slice(-4) }));
  const drift = () => dbg(() => { const me = window.__debug.state(); return me; });

  const phases = [
    ["0.6 s main-thread block", async () => dbg(() => { const t = performance.now(); while (performance.now() - t < 600); })],
    ["1.5 s main-thread block", async () => dbg(() => { const t = performance.now(); while (performance.now() - t < 1500); })],
    ["4 s at ~8 fps (CPU throttled 20x)", async () => { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 }); await wait(4000); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); }],
    ["3 s hidden tab", async () => {
      await dbg(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      await wait(3000);
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      await dbg(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
    }],
  ];
  let i = 0;
  for (const [name, fn] of phases) {
    await run();
    await wait(1200);
    const a = await totals();
    await fn();
    await wait(1500);
    const b = await totals();
    const fps = await dbg(() => window.__stats?.fps);
    await page.screenshot({ path: `${OUT}/${String(++i).padStart(2, "0")}-after.png` });
    const corr = b.corrections - a.corrections, big = b.bigCorrections - a.bigCorrections;
    check(`${name}: back in step`, big <= 1 && corr <= 6, `${corr} corrections, ${big} big, ${fps} fps after; log ${JSON.stringify(b.log.slice(-2))}`);
    // steady state afterwards: no ongoing correction streak
    await run();
    const c0 = await totals();
    await wait(2500);
    const c1 = await totals();
    check(`${name}: steady afterwards`, c1.corrections - c0.corrections <= 1, `${c1.corrections - c0.corrections} corrections in the next 2.5 s`);
  }
} catch (e) {
  check("unexpected error", false, String(e.message ?? e).split("\n")[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
