// Headless screenshot + console capture using the system Chrome (GPU on).
//
//   node scripts/shot.mjs <url> [out.png] [--wait=ms] [--w=1280] [--h=720]
//                         [--eval="js expression"] [--timeout=ms]
//
// Waits until `window.__ready === true` (or --timeout), then an extra --wait ms,
// then screenshots. Prints console errors/warnings and page errors, and if
// `window.__stats` exists prints it as JSON (fps, draw calls, etc.).
// --eval runs an expression after ready and prints its (JSON) result — handy
// for moving a debug camera: --eval="__debug.camera(100, 40, 20, 0, 0)".
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.join("=") || "1"];
  }),
);
const [url, out = "shots/shot.png"] = args.filter((a) => !a.startsWith("--"));
if (!url) {
  console.error("usage: node scripts/shot.mjs <url> [out.png] [--wait=ms] [--eval=js]");
  process.exit(2);
}
const W = Number(flags.w ?? 1280);
const H = Number(flags.h ?? 720);
const timeout = Number(flags.timeout ?? 60000);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal", "--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning" || flags.verbose) console.log(`[console.${t}] ${m.text()}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}\n${e.stack ?? ""}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: "load" });
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout, polling: 100 });
  console.log(`ready after ${Date.now() - t0} ms`);
} catch {
  console.log(`NOT ready after ${timeout} ms (window.__ready never set)`);
}
if (flags.eval) {
  const r = await page.evaluate(flags.eval);
  console.log("eval:", JSON.stringify(r));
}
await page.waitForTimeout(Number(flags.wait ?? 500));
const stats = await page.evaluate(() => window.__stats ?? null);
if (stats) console.log("stats:", JSON.stringify(stats));
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log(`wrote ${out}`);
await browser.close();
