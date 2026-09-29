// Chunked heightfield terrain with distance LOD (skirts hide cracks), frustum
// culling (three.js per-chunk bounds), holes for cave mouths, and a
// stylized splat shader: biome base + slope rock + dirt paths + paving +
// wet sand + seabed caustics + procedural detail + world paint layer.
import * as THREE from "three";
import { CELL, GRID_RES, WORLD_HALF, type World } from "../../../shared/world/types";
import { makeStyledMaterial } from "./patch";
import { GRID_UV_GLSL, type WorldTextures } from "./worldTextures";
import { PAINT_SAMPLE_GLSL } from "./paint";
import { WORLD_PALETTE, PALETTE } from "./style";

const CHUNK = 64; // cells per chunk side (128 m)
const NCH = (GRID_RES - 1) / CHUNK; // 8
const LOD_STEPS = [1, 2, 4, 8];

export interface TerrainOptions {
  lodDistances: number[]; // distance thresholds for LOD 0->1, 1->2, 2->3
}

export interface Terrain {
  group: THREE.Group;
  material: THREE.MeshToonMaterial;
  update(camera: THREE.Camera): void;
  dispose(): void;
}

const glslColor = (hex: number) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

export function terrainShaderHooks(tex: WorldTextures, paint: Record<string, THREE.IUniform>) {
  return {
    key: "terrain-v1",
    uniforms: {
      tGround: { value: tex.ground },
      tMask: { value: tex.mask },
      tNrm: { value: tex.normal },
      ...paint,
    },
    fragPars: /* glsl */ `
      uniform sampler2D tGround, tMask, tNrm;
      ${PAINT_SAMPLE_GLSL}
      ${GRID_UV_GLSL}
      vec3 gN;
      float causticsAt(vec2 p, float t) {
        float a = noiseT(p * 0.16 + vec2(t * 0.02, t * 0.011)).g;
        float b = noiseT(p * 0.21 + vec2(-t * 0.014, t * 0.018) + 0.37).g;
        return pow(smoothstep(0.3, 0.0, min(a, b)), 1.5);
      }
    `,
    fragColor: /* glsl */ `
      vec2 guv = gridUV(vWPos.xz);
      vec4 G = texture2D(tGround, guv);
      vec4 M = texture2D(tMask, guv);
      vec4 NR = texture2D(tNrm, guv);
      vec3 n = vec3(NR.r * 2.0 - 1.0, 0.0, NR.g * 2.0 - 1.0);
      n.y = sqrt(max(1.0 - dot(n.xz, n.xz), 0.0));
      float slope = 1.0 - n.y;
      vec2 p = vWPos.xz;
      float y = vWPos.y;
      float dist = length(vWPos - cameraPosition);
      float fine = 1.0 - smoothstep(25.0, 80.0, dist);
      float mid = 1.0 - smoothstep(120.0, 400.0, dist);
      vec4 nA = noiseT(p * 0.0045);
      vec4 nB = noiseT(p * 0.021);
      vec4 nC = noiseT(p * 0.09);
      vec4 nD = noiseT(p * 0.37);
      vec4 nE = noiseT(p * 1.7);

      vec3 base = G.rgb;
      float ao = G.a;
      // large patchy variation, sun-bleached areas
      base *= 0.88 + 0.24 * nB.r;
      base = mix(base, base * vec3(1.1, 1.03, 0.82), smoothstep(0.55, 0.85, nA.a) * 0.5);

      // --- grass / vegetated ground ---
      vec3 col = base;
      float clump = mix(0.5, nE.b, fine);
      col *= mix(1.0, 0.8 + 0.4 * nD.r, mid) * (0.9 + 0.2 * clump);
      // painterly patches: sunny yellow-green vs cool deep green
      float patchG = smoothstep(0.3, 0.7, nC.r * 0.7 + nD.g * 0.3);
      col = mix(col * vec3(0.86, 0.96, 0.9), col * vec3(1.1, 1.06, 0.84), patchG);
      // blade streaks + tiny meadow flowers close to the camera
      if (fine > 0.0) {
        float blades = noiseT(p * vec2(3.1, 0.9) + nD.r).b;
        col *= 1.0 + (blades - 0.5) * 0.22 * fine;
        vec2 fc = floor(p * 2.3);
        float fh = hash12(fc);
        vec2 fo = fract(p * 2.3) - 0.5 - (hash22(fc) - 0.5) * 0.6;
        float dotF = smoothstep(0.13, 0.07, length(fo)) * step(0.965, fh) * smoothstep(0.55, 0.75, nB.a) * fine;
        vec3 fcol = mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.8, 0.2), step(0.985, fh));
        col = mix(col, fcol, dotF * (1.0 - M.g));
      }
      // darker, cooler grass in shady hollows
      col = mix(col, col * vec3(0.8, 0.95, 0.9), (1.0 - ao) * 0.8);

      // --- sand: ripples + speckle ---
      float sandW = smoothstep(0.25, 0.75, M.g + (nD.r - 0.5) * 0.45);
      float rip = sin(dot(p, vec2(0.83, 0.55)) * 3.1 + nC.r * 9.0) * 0.5 + 0.5;
      vec3 sandC = ${glslColor(PALETTE.sand)} * (0.93 + 0.08 * nC.a) * (1.0 - 0.06 * rip * fine) * (0.97 + 0.06 * nE.b);
      sandC = mix(sandC, ${glslColor(WORLD_PALETTE.seabed)}, smoothstep(0.5, -2.0, y));
      col = mix(col, sandC, sandW);

      // --- rock / cliffs: warm limestone with strata ---
      float rockW = max(smoothstep(0.35, 0.75, M.r + (nC.r - 0.5) * 0.4), smoothstep(0.34, 0.5, slope + (nC.r - 0.5) * 0.16));
      rockW *= 1.0 - smoothstep(-0.5, -3.0, y) * 0.6;
      float steep = smoothstep(0.25, 0.6, slope);
      vec2 rp = mix(p, vec2((p.x + p.y) * 0.707, y * 1.3), steep); // cliff faces: sample the vertical plane
      vec4 rD = noiseT(rp * 0.37);
      float strata = noiseT(vec2((p.x + p.y) * 0.02, y * 0.12)).r;
      float bands = sin(y * 0.85 + nC.a * 4.0 + strata * 3.0) * 0.5 + 0.5;
      vec3 rockC = mix(${glslColor(WORLD_PALETTE.limestone)}, ${glslColor(WORLD_PALETTE.limestoneWarm)}, smoothstep(0.3, 0.8, bands * 0.6 + strata * 0.5));
      rockC *= 0.9 + 0.16 * rD.a;
      rockC *= 1.0 - 0.16 * smoothstep(0.88, 1.0, bands) * mid * steep; // ledge lines on faces
      // moss / grass creeping on flatter rock tops
      float moss = smoothstep(0.75, 0.9, n.y + (nD.r - 0.5) * 0.3) * (1.0 - M.g);
      rockC = mix(rockC, base * 0.9, moss * 0.8);
      col = mix(col, rockC, rockW);

      // --- dirt paths ---
      float pathW = smoothstep(0.28, 0.6, M.b + (nD.g - 0.5) * 0.35 + (nE.r - 0.5) * 0.15 * fine);
      vec3 dirt = ${glslColor(PALETTE.dirt)} * (0.88 + 0.2 * nC.r);
      float peb = smoothstep(0.1, 0.0, noiseT(p * 0.8).g);
      dirt = mix(dirt, dirt * 1.18, peb * fine);
      dirt = mix(dirt, dirt * 0.85, smoothstep(0.75, 1.0, M.b) * 0.5);
      col = mix(col, dirt, pathW * (1.0 - rockW * 0.7));

      // --- village paving: warm cobbles ---
      float paveW = smoothstep(0.35, 0.7, M.a + (nD.r - 0.5) * 0.3);
      vec2 cp = p * 1.4;
      float cob = noiseT(cp * 0.0625).g; // cell edges
      vec3 cobC = mix(vec3(0.62, 0.52, 0.41), vec3(0.8, 0.7, 0.56), noiseT(cp * 0.07 + 3.1).b);
      cobC *= mix(0.6, 1.0, smoothstep(0.02, 0.14, cob));
      cobC = mix(cobC, col, smoothstep(0.55, 0.8, nC.g) * 0.5); // grass between the stones
      col = mix(col, cobC, paveW * (1.0 - pathW * 0.5));

      // --- wet sand at the waterline ---
      float wave = 0.18 * sin(uTime * 0.9 + dot(p, vec2(0.05, 0.03)));
      float wet = (1.0 - smoothstep(0.0, 0.9, y - wave)) * step(-0.05, y - wave * 0.5);
      col *= 1.0 - wet * 0.3 * (0.4 + sandW);
      gSpec = wet * 0.35 * sandW;
      gShine = 30.0;

      // --- underwater: caustics and blue absorption on the seabed ---
      if (y < 0.0) {
        float depth = -y;
        col = mix(col, col * vec3(0.62, 0.9, 0.92), smoothstep(0.0, 6.0, depth));
        float ca = causticsAt(p, uTime);
        col += vec3(0.55, 0.75, 0.7) * ca * 0.3 * smoothstep(0.0, 0.6, depth) * exp(-depth * 0.12) * mid;
      }

      // undergrowth masses: darker, cooler shrub thickets and bush speckle on vegetated ground
      {
        float veg = (1.0 - sandW) * (1.0 - rockW) * (1.0 - pathW) * (1.0 - paveW) * step(0.3, y);
        float shrubN = noiseT(p * 0.045 + 3.7).r * 0.6 + noiseT(p * 0.17 + 1.3).a * 0.4;
        float shrub = smoothstep(0.5, 0.64, shrubN) * veg;
        col = mix(col, col * vec3(0.6, 0.78, 0.58), shrub * 0.7);
        col = mix(col, col * vec3(1.12, 1.08, 0.86), smoothstep(0.46, 0.5, shrubN) * (1.0 - smoothstep(0.5, 0.54, shrubN)) * veg * 0.5);
        vec2 sc = floor(p * 0.55);
        vec2 so = fract(p * 0.55) - 0.5 - (hash22(sc) - 0.5) * 0.5;
        float speck = smoothstep(0.32, 0.18, length(so)) * step(0.8 - shrub * 0.3, hash12(sc + 17.0));
        float farK = smoothstep(25.0, 90.0, dist) * (1.0 - smoothstep(500.0, 900.0, dist));
        col = mix(col, col * vec3(0.55, 0.72, 0.52), speck * veg * farK * 0.8);
      }
      // calm the lime: slightly desaturate vegetated ground
      {
        float vg = (1.0 - sandW) * (1.0 - rockW);
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, vec3(lum), 0.14 * vg);
      }
      col *= mix(0.5, 1.0, ao);

      // --- world paint layer ---
      {
        vec4 P = samplePaint(p);
        float aa = fwidth(P.a) * 0.75 + 0.02;
        float edge = smoothstep(0.5 - aa, 0.5 + aa, P.a);
        if (edge > 0.0) {
          vec3 pc = P.rgb / max(P.a, 1e-3);
          float rim = 1.0 - smoothstep(0.5, 0.75, P.a);
          col = mix(col, pc * (1.0 - rim * 0.25), edge);
          gSpec = mix(gSpec, 0.9, edge);
          gShine = mix(gShine, 70.0, edge);
        }
      }

      diffuseColor.rgb = col;

      // detail normal: bumpy rock, gentle ground undulation
      float bumpS = (rockW * (1.4 - steep * 0.9) + 0.3) * mid;
      float b0 = nD.a, bx = noiseT((p + vec2(0.35, 0.0)) * 0.37).a, bz = noiseT((p + vec2(0.0, 0.35)) * 0.37).a;
      n.xz -= vec2(bx - b0, bz - b0) * bumpS;
      gN = normalize(n);
    `,
    fragNormal: /* glsl */ `
      normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
    `,
  };
}

export function createTerrain(world: World, tex: WorldTextures, env: Record<string, THREE.IUniform>, paint: Record<string, THREE.IUniform>, opts: TerrainOptions): Terrain {
  const group = new THREE.Group();
  group.name = "terrain";
  const material = makeStyledMaterial(env, terrainShaderHooks(tex, paint), {});

  const h = world.height;
  const nrm = tex.normals;

  // shared index buffers per LOD (with skirt), per-chunk ones when holes exist
  const indexCache = new Map<number, THREE.BufferAttribute>();
  function buildIndex(step: number, holeTest: ((cx: number, cz: number) => boolean) | null): THREE.BufferAttribute {
    const m = CHUNK / step; // quads per side
    const vs = m + 1;
    const idx: number[] = [];
    for (let z = 0; z < m; z++) {
      for (let x = 0; x < m; x++) {
        if (holeTest && holeTest(x, z)) continue;
        const a = z * vs + x, b = a + 1, c = a + vs, d = c + 1;
        // alternate diagonals for a less directional look
        if ((x + z) & 1) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
    }
    // skirts: ring of vertices after the grid, in order: bottom edge (z=0), right, top, left
    const base = vs * vs;
    const ring: number[] = [];
    for (let x = 0; x < vs; x++) ring.push(x); // z = 0
    for (let z = 1; z < vs; z++) ring.push(z * vs + m); // x = m
    for (let x = m - 1; x >= 0; x--) ring.push(m * vs + x); // z = m
    for (let z = m - 1; z >= 1; z--) ring.push(z * vs); // x = 0
    for (let i = 0; i < ring.length; i++) {
      const top0 = ring[i], top1 = ring[(i + 1) % ring.length];
      const bot0 = base + i, bot1 = base + ((i + 1) % ring.length);
      idx.push(top0, bot0, top1, top1, bot0, bot1);
    }
    const arr = new Uint32Array(idx);
    return new THREE.BufferAttribute(arr, 1);
  }
  function sharedIndex(step: number) {
    let a = indexCache.get(step);
    if (!a) { a = buildIndex(step, null); indexCache.set(step, a); }
    return a;
  }

  interface Chunk {
    mesh: THREE.Mesh;
    lods: (THREE.BufferGeometry | null)[];
    cx: number;
    cz: number;
    center: THREE.Vector3;
    box: THREE.Box3;
    hasHoles: boolean;
    lod: number;
  }
  const chunks: Chunk[] = [];

  function buildGeometry(ch: Chunk, lod: number): THREE.BufferGeometry {
    const step = LOD_STEPS[lod];
    const m = CHUNK / step;
    const vs = m + 1;
    const ringLen = 4 * m;
    const count = vs * vs + ringLen;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const x0 = ch.cx * CHUNK, z0 = ch.cz * CHUNK;
    for (let z = 0; z < vs; z++) {
      for (let x = 0; x < vs; x++) {
        const gx = x0 + x * step, gz = z0 + z * step;
        const gi = gz * GRID_RES + gx;
        const vi = z * vs + x;
        pos[vi * 3] = -WORLD_HALF + gx * CELL;
        pos[vi * 3 + 1] = h[gi];
        pos[vi * 3 + 2] = -WORLD_HALF + gz * CELL;
        nor[vi * 3] = nrm[gi * 3]; nor[vi * 3 + 1] = nrm[gi * 3 + 1]; nor[vi * 3 + 2] = nrm[gi * 3 + 2];
      }
    }
    const ring: number[] = [];
    for (let x = 0; x < vs; x++) ring.push(x);
    for (let z = 1; z < vs; z++) ring.push(z * vs + m);
    for (let x = m - 1; x >= 0; x--) ring.push(m * vs + x);
    for (let z = m - 1; z >= 1; z--) ring.push(z * vs);
    const skirt = 1.5 + step * 1.5;
    for (let i = 0; i < ring.length; i++) {
      const src = ring[i], dst = vs * vs + i;
      pos[dst * 3] = pos[src * 3];
      pos[dst * 3 + 1] = pos[src * 3 + 1] - skirt;
      pos[dst * 3 + 2] = pos[src * 3 + 2];
      nor[dst * 3] = nor[src * 3]; nor[dst * 3 + 1] = nor[src * 3 + 1]; nor[dst * 3 + 2] = nor[src * 3 + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    if (lod === 0 && ch.hasHoles) {
      g.setIndex(buildIndex(1, (x, z) => world.holes[(z0 + z) * GRID_RES + x0 + x] === 1 || world.holes[(z0 + z + 1) * GRID_RES + x0 + x + 1] === 1 || world.holes[(z0 + z) * GRID_RES + x0 + x + 1] === 1 || world.holes[(z0 + z + 1) * GRID_RES + x0 + x] === 1));
    } else {
      g.setIndex(sharedIndex(step));
    }
    g.boundingBox = ch.box.clone();
    g.boundingSphere = ch.box.getBoundingSphere(new THREE.Sphere());
    return g;
  }

  for (let cz = 0; cz < NCH; cz++) {
    for (let cx = 0; cx < NCH; cx++) {
      let minH = Infinity, maxH = -Infinity, holes = false;
      for (let z = 0; z <= CHUNK; z++) {
        for (let x = 0; x <= CHUNK; x++) {
          const gi = (cz * CHUNK + z) * GRID_RES + cx * CHUNK + x;
          const v = h[gi];
          if (v < minH) minH = v;
          if (v > maxH) maxH = v;
          if (world.holes[gi]) holes = true;
        }
      }
      if (maxH < -16) continue; // deep sea: water is opaque there
      const x0 = -WORLD_HALF + cx * CHUNK * CELL, z0 = -WORLD_HALF + cz * CHUNK * CELL;
      const box = new THREE.Box3(new THREE.Vector3(x0, minH - 15, z0), new THREE.Vector3(x0 + CHUNK * CELL, maxH, z0 + CHUNK * CELL));
      const ch: Chunk = {
        mesh: null as unknown as THREE.Mesh,
        lods: LOD_STEPS.map(() => null),
        cx, cz,
        center: box.getCenter(new THREE.Vector3()),
        box,
        hasHoles: holes,
        lod: -1,
      };
      const geo = buildGeometry(ch, LOD_STEPS.length - 1);
      ch.lods[LOD_STEPS.length - 1] = geo;
      ch.lod = LOD_STEPS.length - 1;
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `terrain-${cx}-${cz}`;
      ch.mesh = mesh;
      group.add(mesh);
      chunks.push(ch);
    }
  }

  const tmp = new THREE.Vector3();
  function update(camera: THREE.Camera) {
    const cp = camera.position;
    for (const ch of chunks) {
      const d = ch.box.distanceToPoint(tmp.copy(cp));
      let lod = 0;
      while (lod < opts.lodDistances.length && d > opts.lodDistances[lod]) lod++;
      lod = Math.min(lod, LOD_STEPS.length - 1);
      if (lod !== ch.lod) {
        let g = ch.lods[lod];
        if (!g) { g = buildGeometry(ch, lod); ch.lods[lod] = g; }
        ch.mesh.geometry = g;
        ch.lod = lod;
      }
    }
  }

  return {
    group,
    material,
    update,
    dispose() {
      for (const ch of chunks) for (const g of ch.lods) g?.dispose();
      material.dispose();
    },
  };
}
