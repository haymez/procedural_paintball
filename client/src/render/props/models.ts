// Models for every PropKind, three LODs each, with wind weights and foliage
// texture coordinates baked in (see builder.ts / atlas.ts). Plants live in
// plants.ts; the rock props are here.
// Units are meters at scale 1; the base sits at y = 0.
import * as THREE from "three";
import { PropKind } from "../../../../shared/world/types";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Builder, col, rng, v3, wobble } from "./builder";
import { PLANTS } from "./plants";

export interface PropModel { lod0: THREE.BufferGeometry; lod1: THREE.BufferGeometry; lod2: THREE.BufferGeometry; height: number; radius: number }

const tmpC = new THREE.Color();
const mixC = (a: number, b: number, t: number) => tmpC.set(a).lerp(col(b), t).clone();

// ------------------------------------------------------------------ rocks
function rock(lod: number, o: { seed: number; r: number; sq: number; moss: number }): THREE.BufferGeometry {
  // chipped boulder: an icosphere cut by random planes (flat fractured faces,
  // a flat-ish base), then lightly roughened. Color is white: the rock shader
  // textures it with the island's own rock (props.ts rockHooks).
  const b = new Builder();
  const r = rng(o.seed);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, lod === 0 ? 3 : lod === 1 ? 2 : 1);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  const planes: [THREE.Vector3, number][] = [];
  for (let k = 0; k < 9; k++) {
    const a = r() * Math.PI * 2, y = r() * 1.6 - 0.5;
    planes.push([v3(Math.cos(a), y, Math.sin(a)).normalize(), 0.58 + r() * 0.28]);
  }
  planes.push([v3(0, -1, 0), 0.45]); // sits flat on the ground
  const pa = g.getAttribute("position") as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) {
    p.fromBufferAttribute(pa, i);
    for (const [n, d] of planes) {
      const t = p.dot(n) - d;
      if (t > 0) p.addScaledVector(n, -t);
    }
    p.multiplyScalar(1 + wobble(p, 3.1, o.seed) * 0.05 + wobble(p, 7.3, o.seed + 1) * 0.02);
    pa.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  const m = new THREE.Matrix4().compose(v3(0, o.r * o.sq * 0.45, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * 6.28, 0)), v3(o.r * 1.15, o.r * o.sq, o.r * 0.95));
  b.add(g, m, (q) => mixC(0xb8b8b8, 0xffffff, Math.min(1, Math.max(0, q.y / (o.r * o.sq) + 0.2))), [0, 0, 0]);
  g.dispose();
  return b.build();
}

// --------------------------------------------------------------- catalog
let cache: Map<PropKind, PropModel> | null = null;

export function propModels(): Map<PropKind, PropModel> {
  if (cache) return cache;
  const m = new Map<PropKind, PropModel>();
  const both = (kind: PropKind, fn: (lod: number) => THREE.BufferGeometry, height: number, radius: number) => m.set(kind, { lod0: fn(0), lod1: fn(1), lod2: fn(2), height, radius });
  both(PropKind.Palm, PLANTS.palm, 11, 5);
  both(PropKind.PalmLeaning, PLANTS.palmLeaning, 10, 6.5);
  both(PropKind.Broadleaf, PLANTS.broadleaf, 15, 6.5);
  both(PropKind.JungleGiant, PLANTS.jungleGiant, 23, 11);
  both(PropKind.HolmOak, PLANTS.holmOak, 9.5, 4.8);
  both(PropKind.Pine, PLANTS.pine, 14, 4.5);
  both(PropKind.TreeFern, PLANTS.treeFern, 5, 2.8);
  both(PropKind.Understory, PLANTS.understory, 1.8, 1.4);
  both(PropKind.Log, PLANTS.log, 1.4, 2);
  both(PropKind.UmbrellaPine, PLANTS.umbrellaPine, 9, 5.8);
  both(PropKind.Cypress, PLANTS.cypress, 10, 1.4);
  both(PropKind.Olive, PLANTS.olive, 4.6, 2.5);
  both(PropKind.LemonTree, PLANTS.lemon, 3.5, 1.7);
  both(PropKind.Banana, PLANTS.banana, 4, 2.6);
  both(PropKind.Fern, PLANTS.fern, 1, 1.3);
  both(PropKind.Bush, PLANTS.bush, 1.8, 1.5);
  both(PropKind.Bougainvillea, PLANTS.bougainvillea, 2.3, 2);
  both(PropKind.Agave, PLANTS.agave, 1.1, 0.9);
  both(PropKind.GrassTuft, PLANTS.grassTuft, 0.9, 0.4);
  both(PropKind.Flowers, PLANTS.flowers, 0.6, 0.4);
  both(PropKind.RockSmall, (l) => rock(l, { seed: 23, r: 0.35, sq: 0.6, moss: 0.3 }), 0.4, 0.4);
  both(PropKind.RockMedium, (l) => rock(l, { seed: 29, r: 1.0, sq: 0.75, moss: 0.6 }), 1.3, 1.1);
  both(PropKind.Boulder, (l) => rock(l, { seed: 37, r: 2.3, sq: 0.85, moss: 0.8 }), 3.4, 2.6);
  both(PropKind.Driftwood, PLANTS.driftwood, 0.5, 1.4);
  both(PropKind.Reed, PLANTS.reeds, 2, 0.6);
  both(PropKind.Mangrove, PLANTS.mangrove, 6, 3);
  both(PropKind.TiPlant, PLANTS.tiPlant, 2.2, 0.9);
  cache = m;
  return m;
}
