// Live end-to-end check of the lobby/room flow against the dev server.
//
//   node scripts/e2e-rooms.mjs [--base=http://localhost:5173] [--out=shots/e2e]
//
// Drives three headless pages: host creates a room, guest joins by code, a
// third watches the room browser. Covers settings sync, chat, reconnect
// (socket drop + full reload keep the same slot), start -> loading ->
// match -> end -> results -> lobby. Screenshots every screen.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.join("=") || "1"];
  }),
);
const BASE = flags.base ?? "http://localhost:5173";
const OUT = flags.out ?? "shots/e2e";
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
async function newPage(label, w = 1280, h = 720) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => console.log(`[${label} pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${label} console.error] ${m.text()}`);
  });
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const roomState = (page) =>
  page.evaluate(() => {
    const r = window.__isola?.app?.room;
    return r?.state ? { me: r.me, phase: r.state.phase, settings: r.state.settings, players: r.state.players } : null;
  });

try {
  const host = await newPage("host");
  const guest = await newPage("guest");
  const watcher = await newPage("watcher");

  // --- title + create -------------------------------------------------------------
  await host.goto(BASE + "/");
  await host.waitForFunction(() => window.__ready === true);
  await host.fill("#player-name", "Pesce Veloce");
  await host.click("#btn-create");
  await host.waitForURL(/\/r\/[A-Z2-9]{4}$/);
  await host.waitForSelector("#btn-start:not([hidden])");
  const code = host.url().split("/r/")[1];
  check("host created a room", /^[A-Z2-9]{4}$/.test(code), code);
  const hs = await roomState(host);
  check("creator is host", hs.players[0].host && hs.players[0].name === "Pesce Veloce");

  // --- browser: private room is hidden, then appears once public --------------------
  await watcher.goto(BASE + "/rooms");
  await watcher.waitForSelector(".live:not(.off)");
  await watcher.waitForTimeout(400);
  const listedPrivate = await watcher.locator(`.room-row:has-text("${code}")`).count();
  check("private room not listed", listedPrivate === 0);

  // --- guest joins by code ---------------------------------------------------------------
  await guest.goto(BASE + "/");
  await guest.waitForFunction(() => window.__ready === true);
  await guest.fill("#player-name", "Polpo Pazzo");
  await guest.fill("#join-code", code.toLowerCase());
  await guest.click("#btn-join");
  await guest.waitForURL(new RegExp(`/r/${code}$`));
  await guest.waitForSelector(".waiting:not([hidden])");
  await host.waitForFunction(() => window.__isola.app.room.state.players.filter((p) => !p.bot).length === 2);
  check("guest joined by code", true);

  // bad code shows an error on the title
  await watcher.goto(BASE + "/");
  await watcher.fill("#join-code", "ZZZZ");
  await watcher.click("#btn-join");
  await watcher.waitForFunction(() => document.querySelector("#join-error")?.textContent?.length > 0);
  check("unknown code is rejected on the title", true);
  await shot(watcher, "01-title-bad-code");
  await watcher.goto(BASE + "/rooms");
  await watcher.waitForSelector(".live:not(.off)");

  // --- host changes settings --------------------------------------------------------------
  const setRange = (page, sel, v) =>
    page.$eval(
      sel,
      (el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      v,
    );
  await host.fill(".settings input.input >> nth=0", "Cala dei Polpi");
  await host.press(".settings input.input >> nth=0", "Enter");
  await host.click("#btn-reroll");
  await setRange(host, ".settings input.range >> nth=0", 4);
  await setRange(host, ".settings input.range >> nth=1", 8);
  await host.click('.segmented label:has-text("Hard")');
  await host.click('label.switch:has-text("Listed publicly")');
  await guest.waitForFunction(
    () => {
      const s = window.__isola.app.room.state.settings;
      return s.name === "Cala dei Polpi" && s.bots === 4 && s.matchMinutes === 8 && s.difficulty === 2 && s.public;
    },
    null,
    { timeout: 5000 },
  ).catch(async (e) => {
    console.log("guest settings:", JSON.stringify((await roomState(guest)).settings));
    console.log("host settings:", JSON.stringify((await roomState(host)).settings));
    throw e;
  });
  const [hSeed, gSeed] = [await roomState(host), await roomState(guest)].map((s) => s.settings.seed);
  check("guest sees host's settings", hSeed === gSeed && hSeed !== hs.settings.seed, `seed ${gSeed}`);
  const guestReadOnly = await guest.$eval(".settings input.range", (el) => el.disabled);
  check("guest settings are read-only", guestReadOnly);

  // guest can't change settings (server enforces)
  await guest.evaluate(() => window.__isola.app.room.updateSettings({ bots: 0 }));
  await guest.waitForTimeout(300);
  check("server ignores non-host settings", (await roomState(host)).settings.bots === 4);

  // lobby list updates live
  await watcher.waitForSelector(`.room-row:has-text("${code}")`, { timeout: 5000 });
  const rowText = await watcher.locator(`.room-row:has-text("${code}")`).innerText();
  check("room browser updated live", rowText.includes("Cala dei Polpi") && rowText.includes("2/20"), rowText.replace(/\s+/g, " "));

  // colors + chat
  await guest.click('.swatch[title="Mare"]');
  await guest.fill("#chat-input", "Ciao a tutti! Pronti?");
  await guest.press("#chat-input", "Enter");
  await host.fill("#chat-input", "Si! Porto le banane.");
  await host.press("#chat-input", "Enter");
  await host.waitForFunction(() => [...document.querySelectorAll(".chat-log li")].some((li) => li.textContent.includes("Pronti")));
  check("chat delivered", true);
  await host.waitForTimeout(2600); // let pings show in the list
  await shot(host, "02-lobby-host");
  await shot(guest, "03-lobby-guest");
  await shot(watcher, "04-browser");

  // --- reconnect: socket drop, then full reload --------------------------------------------
  const guestId = (await roomState(guest)).me;
  await guest.evaluate(() => window.__isola.app.room.conn.simulateDrop());
  await host.waitForFunction(
    (id) => window.__isola.app.room.state.players.find((p) => p.id === id)?.connected === false,
    guestId,
    { timeout: 3000 },
  ).catch(() => {});
  await guest.waitForFunction(() => window.__isola.app.room.conn.status === "open" && window.__isola.app.room.welcome?.rejoined);
  check("socket drop reconnects to the same slot", (await roomState(guest)).me === guestId);
  await guest.reload();
  await guest.waitForFunction(() => window.__isola?.app?.room?.welcome?.rejoined === true);
  const afterReload = await roomState(guest);
  const players = afterReload.players.filter((p) => !p.bot);
  check("reload keeps the same slot", afterReload.me === guestId && players.length === 2, `id ${afterReload.me}`);

  // --- narrow window ------------------------------------------------------------------------
  const narrow = await newPage("narrow", 390, 844);
  await narrow.goto(`${BASE}/r/${code}`);
  await narrow.waitForSelector(".waiting:not([hidden])");
  await shot(narrow, "05-lobby-narrow");
  await narrow.click("#btn-leave");
  await narrow.waitForURL(BASE + "/");
  await narrow.close();
  await host.waitForFunction(() => window.__isola.app.room.state.players.filter((p) => !p.bot).length === 2, null, { timeout: 5000 });
  check("explicit leave frees the slot", true);

  // --- start -> loading -> match ------------------------------------------------------
  await host.click("#btn-start");
  await guest.waitForSelector(".loading");
  await guest.waitForTimeout(900);
  await shot(guest, "06-loading");
  check("clients enter loading", true);
  const inGame = (p) => p.waitForFunction(() => window.__netgame?.ready === true, null, { timeout: 60000 });
  await inGame(host);
  await inGame(guest);
  check("both reach the match", (await roomState(host)).phase === 2);
  await host.waitForTimeout(500);
  await shot(host, "07-match");

  // late joiner drops in during play
  const late = await newPage("late");
  await late.goto(`${BASE}/r/${code}`);
  await inGame(late);
  check("late joiner drops into the running match", true);

  // --- end -> results -> lobby ---------------------------------------------------------------
  await host.evaluate(() => window.__isola.app.room.endMatch());
  await guest.waitForSelector(".board");
  await shot(guest, "08-results");
  check("results shown", (await roomState(guest)).phase === 3);
  await host.click("#btn-lobby");
  await guest.waitForSelector(".waiting:not([hidden])");
  check("back to lobby", (await roomState(guest)).phase === 0);
  await late.click("#btn-leave");
  await late.close();

  // leaving updates the list
  await host.click("#btn-leave");
  await guest.waitForFunction(() => window.__isola.app.room.isHost, null, { timeout: 5000 });
  check("host promotion on leave", true);
  await watcher.waitForFunction(
    (c) => [...document.querySelectorAll(".room-row")].some((r) => r.textContent.includes(c) && r.textContent.includes("1/20")),
    code,
    { timeout: 5000 },
  );
  check("room browser reflects the leave", true);
} catch (e) {
  check("unexpected error", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
