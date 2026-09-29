// Launcher for the headless load test (scripts/netload.ts): bundles it with
// esbuild (the protocol and NetClient are TypeScript) and runs it.
//   node scripts/netload.mjs --clients=19 --bots=1 --seconds=180
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "node_modules/.cache/isola/netload.mjs");
mkdirSync(dirname(out), { recursive: true });
await build({
  entryPoints: [resolve(root, "scripts/netload.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: out,
  logLevel: "warning",
});
await import(pathToFileURL(out).href);
