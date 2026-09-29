// Headless bot-match harness launcher: bundles scripts/botsim.ts with esbuild
// (already installed with vite) and runs it under Node, much faster than real
// time. See scripts/botsim.ts for the options.
//
//   node scripts/botsim.mjs --seeds=1,2,3 --minutes=3 --bots=20 --difficulty=mix
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "botsim-"));
const out = join(dir, "botsim.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("./botsim.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  sourcemap: "inline",
  logLevel: "warning",
});
await import(pathToFileURL(out).href);
