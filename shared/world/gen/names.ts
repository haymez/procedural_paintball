// Stage 11: names. An Italian-flavoured island name and landmark labels for
// peaks, bays, coves, beaches, falls, caves, lakes, ruins and the hamlet.
import type { Rng } from "../../math/rng";
import type { Ctx } from "../context";
import { N, toI } from "../grid";
import type { Landmark } from "../types";

const SAINTS = [
  "Sant'Erasmo", "San Giorgio", "Santa Lucia", "San Nicola", "Sant'Elena", "San Michele", "Santa Rosalia",
  "San Vito", "Santa Chiara", "San Lorenzo", "Sant'Agata", "San Silvestro", "Santa Marina", "San Pietro",
];
const ISLAND_FORMS = [
  (r: Rng) => "Isola di " + r.pick(SAINTS),
  (r: Rng) => "Isola " + r.pick(["Bella", "Serena", "Chiara", "Verde", "Azzurra", "Dorata", "Ventosa", "Fiorita", "Selvaggia", "Smeralda", "Solitaria", "Incantata", "Perduta", "Gemella", "Ridente"]),
  (r: Rng) => r.pick(["Isola Grande di ", "Isola Piccola di ", "Isolotto di "]) + r.pick(["Capo Rosso", "Vallechiara", "Acquaviva", "Roccabella", "Castelmare", "Pietrasanta", "Marinella", "Portofino Vecchio"]),
  (r: Rng) => "Isola dei " + r.pick(["Gabbiani", "Pescatori", "Limoni", "Coralli", "Delfini", "Pini", "Venti", "Fichi", "Gamberi", "Cormorani", "Mulini", "Naufraghi"]),
  (r: Rng) => "Isola delle " + r.pick(["Sirene", "Capre", "Conchiglie", "Lucertole", "Rondini", "Stelle", "Tartarughe", "Meduse", "Farfalle", "Lanterne", "Vele"]),
  (r: Rng) => "Isola di " + r.pick(["Montevera", "Portorosa", "Lunamare", "Scogliera", "Pietrablu", "Solemare", "Borgofiore"]),
];
const ADJ_F = ["Azzurra", "Rossa", "Verde", "Chiara", "Lunga", "Stretta", "Segreta", "Dorata", "Nascosta", "Serena", "Bianca", "Vecchia"];
const ADJ_M = ["Azzurro", "Rosso", "Verde", "Chiaro", "Lungo", "Stretto", "Segreto", "Dorato", "Nascosto", "Sereno", "Bianco", "Vecchio", "Alto"];
const OF = [
  "dei Pescatori", "dei Gabbiani", "delle Sirene", "del Vento", "del Sole", "della Luna", "dei Limoni", "degli Ulivi",
  "dei Pini", "del Corallo", "delle Capre", "del Mostro Marino", "dei Delfini", "delle Conchiglie", "dei Pirati",
  "del Tramonto", "delle Rondini", "dei Fichi",
];

export function namesStage(ctx: Ctx, rng: Rng): void {
  const used = ctx.usedNames;
  const uniq = (gen: () => string): string => {
    for (let k = 0; k < 20; k++) {
      const s = gen();
      if (!used.has(s)) {
        used.add(s);
        return s;
      }
    }
    const s = gen() + " " + (used.size + 1);
    used.add(s);
    return s;
  };
  const tail = () => (rng.chance(0.5) ? rng.pick(ADJ_F) : rng.pick(OF));
  ctx.name = uniq(() => rng.pick(ISLAND_FORMS)(rng));
  const L: Landmark[] = ctx.landmarks;
  const add = (name: string, x: number, z: number, kind: Landmark["kind"]) => L.push({ name, x, z, kind });

  // peaks (by height)
  const peaks = ctx.peaks.slice().sort((a, b) => b.h - a.h);
  peaks.forEach((p, k) => {
    // snap to the real summit nearby
    let bx = p.x, bz = p.z, bh = -1e9;
    const ci = toI(p.x), cj = toI(p.z);
    for (let dz = -20; dz <= 20; dz += 2)
      for (let dx = -20; dx <= 20; dx += 2) {
        const ix = ci + dx, iz = cj + dz;
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        const v = ctx.height[iz * N + ix];
        if (v > bh) {
          bh = v;
          bx = -512 + ix * 2;
          bz = -512 + iz * 2;
        }
      }
    const nm = k === 0
      ? uniq(() => (p.caldera ? "Monte " + rng.pick(["Fumo", "Vulcano", "Cenere", "Brace", "Fuoco"]) : "Monte " + rng.pick(ADJ_M.concat(["Grande", "Cielo", "Falco", "Aquila"]))))
      : uniq(() => rng.pick(["Pizzo ", "Monte ", "Colle ", "Punta "]) + rng.pick(ADJ_M.concat(["Falco", "Corvo", "Lupo", "Capraro"])));
    add(nm, bx, bz, "peak");
  });
  for (const lk of ctx.lakes) {
    // twin basins of the same water body get one name
    if (L.some((l) => l.kind === "lake" && (l.x - lk.x) * (l.x - lk.x) + (l.z - lk.z) * (l.z - lk.z) < 90 * 90)) continue;
    const crater = ctx.peaks.some((p) => p.caldera && (p.x - lk.x) * (p.x - lk.x) + (p.z - lk.z) * (p.z - lk.z) < 80 * 80);
    add(uniq(() => "Lago " + (crater ? rng.pick(["del Cratere", "Vulcano", "Specchio", "Azzurro", "Nero"]) : rng.pick(ADJ_M.concat(["delle Rane", "Specchio", "dei Salici"])))), lk.x, lk.z, "lake");
  }
  ctx.bays.forEach((b, k) => {
    const big = k === 0 && b.size > 25000;
    add(uniq(() => (big ? rng.pick(["Baia ", "Golfo "]) + tail() : "Cala " + tail())), b.x, b.z, big ? "bay" : "cove");
  });
  for (const f of ctx.waterfalls) add(uniq(() => "Cascata " + tail()), f.x, f.z, "falls");
  for (const c of ctx.caves) {
    const grotto = c.entrances.some((e) => e.y < 0);
    const hub = c.nodes[0];
    add(uniq(() => (grotto ? "Grotta " + rng.pick(["Azzurra", "Marina", "delle Sirene", "del Mostro Marino", "Smeralda"]) : "Grotta " + tail())), hub.x, hub.z, "cave");
  }
  for (const s of ctx.sites) {
    let nm = "";
    let kind: Landmark["kind"] = "ruin";
    switch (s.kind) {
      case "lighthouse":
        nm = uniq(() => (rng.chance(0.35) ? "Punta del Faro" : "Faro " + rng.pick(ADJ_M.concat(["di Levante", "di Ponente", "del Capo"]))));
        kind = "point";
        break;
      case "hamlet":
        nm = uniq(() => rng.pick(["Borgo ", "Porto ", "Villaggio "]) + rng.pick(["Rosa", "Vecchio", "dei Pescatori", "Fiorito", "Marino", "Perduto", "San Rocco"]));
        kind = "village";
        break;
      case "chapel":
        nm = uniq(() => "Chiesetta di " + rng.pick(SAINTS));
        break;
      case "watchtower":
        nm = uniq(() => "Torre " + rng.pick(["Saracena", "di Guardia", "Vecchia", "del Vento", "Spezzata"]));
        break;
      case "boathouse":
        nm = uniq(() => rng.pick(["Rimessa ", "Darsena "]) + rng.pick(["dei Pescatori", "Vecchia", "del Porto", "Azzurra"]));
        break;
      case "shed":
        nm = uniq(() => "Officina " + rng.pick(["Vespa", "Scooter", "del Meccanico", "di Giulio"]));
        break;
      case "aqueduct":
        nm = uniq(() => "Acquedotto " + rng.pick(["Romano", "Antico", "Spezzato", "dei Monaci"]));
        break;
    }
    s.name = nm;
    add(nm, s.x, s.z, kind);
  }
  // a couple of beaches and headlands
  for (const hd of ctx.headlands.slice(0, 2)) {
    if (ctx.sites.some((s) => s.kind === "lighthouse" && (s.x - hd.x) * (s.x - hd.x) + (s.z - hd.z) * (s.z - hd.z) < 120 * 120)) continue;
    add(uniq(() => "Capo " + tail()), hd.x, hd.z, "point");
  }
  for (const v of ctx.vehicles) {
    if (v.kind !== 0) continue;
    if (L.some((l) => l.kind === "beach" && (l.x - v.x) * (l.x - v.x) + (l.z - v.z) * (l.z - v.z) < 150 * 150)) continue;
    add(uniq(() => "Spiaggia " + tail()), v.x, v.z, "beach");
    if (L.filter((l) => l.kind === "beach").length >= 2) break;
  }
  for (const s of ctx.islets) add(uniq(() => "Scoglio " + tail()), s.x, s.z, "point");
  if (ctx.stacks.length) {
    let sx = 0, sz = 0;
    for (const s of ctx.stacks) {
      sx += s.x;
      sz += s.z;
    }
    add(uniq(() => (ctx.stacks.length > 1 ? "Faraglioni " : "Faraglione ") + tail()), sx / ctx.stacks.length, sz / ctx.stacks.length, "point");
  }
}
