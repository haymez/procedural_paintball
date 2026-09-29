// Multi-browser end-to-end check of the networked match against the dev server.
//
//   node scripts/e2e-match.mjs [--base=http://localhost:5173] [--lag=120 --jitter=20]
//                              [--out=shots/net/e2e] [--bots=2]
//
// Three headless Chrome pages (host + 2 guests, the guests join by code).
// The host adds bots and starts; everyone loads the island and drops in.
// Bots are frozen, the guests are summoned in front of the host, and each
// page screenshots what it sees. The host shoots guest 1: the hit must show
// up on the shooter (hit confirm), the victim (paint on itself) and the
// bystander (paint on guest 1's blob). Then everyone moves for a while and we
// log prediction corrections and remote smoothness per page. Finally the
// host ends the match and all three must land on the results screen.
// With --lag/--jitter every page simulates that network (?lag=&jitter=).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.join("=") || "1"];
  }),
);
const BASE = flags.base ?? "http://localhost:5173";
const LAG = Number(flags.lag ?? 0), JITTER = Number(flags.jitter ?? 0);
const OUT = flags.out ?? (LAG || JITTER ? "shots/net/e2e-lag" : "shots/net/e2e");
const BOTS = Number(flags.bots ?? 2);
const Q = `?lag=${LAG}&jitter=${JITTER}&net=1`;
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
});
async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.__label = label;
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => console.log(`[${label} pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || t.includes("MISMATCH") || t.startsWith("[net] simulating")) console.log(`[${label} ${m.type()}] ${t}`);
  });
  return page;
}
// Trace the app's view routing (printed if a page doesn't reach the match view).
const traceViews = (page) =>
  page.evaluate(() => {
    const app = window.__isola.app;
    window.__trace = [];
    const orig = app.syncRoom.bind(app);
    app.syncRoom = () => {
      orig();
      const r = app.room;
      window.__trace.push(`${Math.round(performance.now())} phase=${r?.state?.phase} status=${r?.myPlayer?.status} begun=${app.match?.begun} begin=${!!r?.begin} view=${app.view}`);
    };
  });
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const dbg = async (page, fn, arg) => {
  try {
    return await page.evaluate(fn, arg);
  } catch (e) {
    const where = await page.evaluate(() => ({ url: location.href, netgame: !!window.__netgame, debug: !!window.__debug })).catch(() => null);
    throw new Error(`${page.__label}: ${String(e.message).split("\n")[0]} ${JSON.stringify(where)}`);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`e2e-match: lag ${LAG} ms ± ${JITTER} ms → ${OUT}`);
  const host = await newPage("host");
  const g1 = await newPage("guest1");
  const g2 = await newPage("guest2");
  const pages = [host, g1, g2];

  await host.goto(`${BASE}/${Q}`);
  await host.waitForFunction(() => window.__ready === true);
  await host.fill("#player-name", "Ospite");
  await host.click("#btn-create");
  await host.waitForURL(/\/r\/[A-Z2-9]{4}$/);
  await host.waitForSelector("#btn-start:not([hidden])");
  const code = host.url().split("/r/")[1];
  await host.evaluate((b) => window.__isola.app.room.updateSettings({ bots: b, matchMinutes: 5 }), BOTS);
  for (const [p, name] of [[g1, "Polpo"], [g2, "Gelato"]]) {
    await p.goto(`${BASE}/${Q}`);
    await p.waitForFunction(() => window.__ready === true);
    await p.fill("#player-name", name);
    await p.fill("#join-code", code);
    await p.click("#btn-join");
    await p.waitForSelector(".waiting:not([hidden])");
  }
  await host.waitForFunction(() => window.__isola.app.room.state.players.filter((p) => !p.bot).length === 3);
  check("two guests joined by code", true, code);

  for (const p of pages) await traceViews(p);
  await host.click("#btn-start");
  const t0 = Date.now();
  for (const p of pages) await p.waitForFunction(() => window.__netgame?.ready === true, null, { timeout: 90000 });
  check("all three pages are in the match", true, `${Date.now() - t0} ms from start`);
  await wait(500);
  const views = await Promise.all(pages.map((p) => p.evaluate(() => window.__isola.app.view)));
  check("all three pages show the match view", views.every((v) => v === "match"), views.join(","));
  for (let i = 0; i < 3; i++) if (views[i] !== "match") console.log((await pages[i].evaluate(() => window.__trace)).join("\n"));
  const ids = await Promise.all(pages.map((p) => dbg(p, () => window.__netgame.localId)));
  const [hid, g1id, g2id] = ids;
  const botIds = (await dbg(host, () => window.__debug.players())).map((p) => p.id).filter((id) => id >= 128);
  const counts = await Promise.all(pages.map((p) => dbg(p, () => window.__debug.players().length)));
  check("everyone sees 3 humans + bots", counts.every((n) => n === 3 + botIds.length), counts.join(","));

  // freeze bots, gather the guests in front of the host
  await dbg(host, () => window.__debug.bots(0));
  await wait(400);
  await dbg(host, () => window.__debug.look(0, -8));
  await wait(300);
  await dbg(host, (id) => window.__debug.summon(id, 9), g1id);
  await wait(200);
  await dbg(host, () => window.__debug.look(35, -8));
  await wait(300);
  await dbg(host, (id) => window.__debug.summon(id, 13), g2id);
  await wait(300);
  await dbg(host, () => window.__debug.look(18, -6));
  for (const p of [g1, g2]) await dbg(p, (id) => window.__debug.aimAt(id), hid);
  await wait(1500 + LAG * 2);

  // positions agree across clients
  const truth = await Promise.all(pages.map((p) => dbg(p, () => window.__debug.state())));
  const seenBy = await Promise.all(pages.map((p) => dbg(p, () => window.__debug.players())));
  let maxErr = 0;
  pages.forEach((_, i) => {
    for (const q of seenBy[i]) {
      const j = ids.indexOf(q.id);
      if (j < 0 || j === i) continue;
      maxErr = Math.max(maxErr, Math.hypot(q.x - truth[j].x, q.z - truth[j].z));
    }
  });
  check("each client draws the others where they are", maxErr < 0.5, `max ${maxErr.toFixed(3)} m`);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  if (flags.verbose) seenBy.forEach((l, i) => console.log(`  page ${i} (me ${ids[i]}, at ${truth[i].x},${truth[i].y},${truth[i].z}) sees`, JSON.stringify(l.map((q) => [q.id, q.x, q.y, q.z]))));
  check("guests stand in front of the host", dist(truth[0], truth[1]) < 12 && dist(truth[0], truth[2]) < 16, `${dist(truth[0], truth[1]).toFixed(1)} m, ${dist(truth[0], truth[2]).toFixed(1)} m`);
  await Promise.all([shot(host, "01-host-sees-guests"), shot(g1, "02-guest1-sees-host"), shot(g2, "03-guest2-sees-both")]);

  // the host shoots guest 1
  await dbg(g1, () => window.__debug.noShield());
  await dbg(host, (id) => window.__debug.aimAt(id), g1id);
  await wait(150);
  const before = await Promise.all(pages.map((p) => dbg(p, () => window.__debug.net().totals)));
  const fire = dbg(host, () => window.__debug.input({ fire: true }, 260));
  await wait(120);
  await shot(host, "04-host-firing");
  await fire;
  await wait(900 + LAG * 2);
  const after = await Promise.all(pages.map((p) => dbg(p, () => window.__debug.net().totals)));
  const g1state = await dbg(g1, () => window.__debug.state());
  const g1seenBy2 = (await dbg(g2, () => window.__debug.players())).find((p) => p.id === g1id);
  check("shooter predicted its shots and the server confirmed them", after[0].shotsPredicted > before[0].shotsPredicted && after[0].shotsConfirmed === after[0].shotsPredicted,
    `${after[0].shotsPredicted - before[0].shotsPredicted} shots, unpredicted ${after[0].shotsUnpredicted}`);
  check("hit confirmed on the shooter", after[0].hitsByMe > before[0].hitsByMe, `${after[0].hitsByMe - before[0].hitsByMe} hits`);
  check("hit landed on the victim", after[1].hitsOnMe > before[1].hitsOnMe && (g1state.coats > 0 || !g1state.alive), `coats ${g1state.coats}, alive ${g1state.alive}`);
  check("bystander sees the paint on the victim", !!g1seenBy2 && (g1seenBy2.coats > 0 || !g1seenBy2.alive), `coats ${g1seenBy2?.coats}`);
  await Promise.all([shot(host, "05-host-after-hit"), shot(g1, "06-guest1-painted"), shot(g2, "07-guest2-sees-paint")]);

  // everybody runs around for a while: measure prediction + smoothness under these conditions
  const base = await Promise.all(pages.map((p) => dbg(p, () => window.__debug.net().totals)));
  await dbg(host, () => window.__debug.bots(1));
  await Promise.all(pages.map((p, i) =>
    dbg(p, (k) => window.__debug.inputSeq([
      [{ moveZ: 1, sprint: true, turn: 0.6 * (k % 2 ? 1 : -1) }, 2500],
      [{ moveZ: 1, jump: true }, 600],
      [{ moveX: 1, moveZ: 0.5, turn: -0.8 }, 2000],
      [{ moveZ: 1, fire: true, turn: 0.4 }, 1500],
      [{ moveZ: -1 }, 800],
    ]), i)));
  const end = await Promise.all(pages.map((p) => dbg(p, () => ({ ...window.__debug.net(), fps: window.__stats?.fps, rtt: window.__stats?.rtt, log: window.__debug.game.source.net.corrLog }))));
  end.forEach((n, i) => {
    const t = n.totals, b = base[i];
    const corr = t.corrections - b.corrections;
    const ticks = t.ticks - b.ticks;
    if (corr > 5) console.log(`  ${["host", "guest1", "guest2"][i]} corrections: ${JSON.stringify(n.log.slice(-8))}; hits on me ${t.hitsOnMe - b.hitsOnMe}`);
    const jerk = (t.jerkSum - b.jerkSum) / Math.max(1, t.jerkN - b.jerkN);
    console.log(`  ${["host", "guest1", "guest2"][i]}: ${corr} corrections in ${ticks} ticks (${((100 * corr) / Math.max(1, ticks)).toFixed(2)} %), max ever ${(t.corrMax * 100).toFixed(1)} cm;` +
      ` interp ${n.stats.interpDelayMs.toFixed(0)} ms (jitter ${n.stats.jitterMs.toFixed(0)}); remote |Δ²x| ${(jerk * 1000).toFixed(2)} mm/tick²; down ${n.rates?.inKBs?.toFixed(1)} KB/s up ${n.rates?.outKBs?.toFixed(1)} KB/s; ${n.fps} fps, rtt ${n.rtt} ms`);
  });
  const worst = Math.max(...end.map((n, i) => (n.totals.corrections - base[i].corrections) / Math.max(1, n.totals.ticks - base[i].ticks)));
  check("prediction corrections are rare while moving", worst < 0.03, `worst ${(worst * 100).toFixed(2)} % of ticks`);
  await Promise.all([shot(host, "08-host-moving"), shot(g1, "09-guest1-moving"), shot(g2, "10-guest2-moving")]);

  // end the match: everyone lands on the results
  await host.evaluate(() => window.__isola.app.room.endMatch());
  for (const p of pages) await p.waitForSelector(".board", { timeout: 15000 });
  const rows = await dbg(g2, () => window.__isola.app.room.results?.rows ?? []);
  check("results screen on all three pages", rows.length === 3 + botIds.length, `${rows.length} rows, top ${rows[0]?.name} ${rows[0]?.score}`);
  await shot(g1, "11-results");
} catch (e) {
  check("unexpected error", false, String(e.message ?? e).split("\n")[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
