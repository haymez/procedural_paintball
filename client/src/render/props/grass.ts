// GPU grass: dense short blades around the camera.
//
// One patch geometry (a 4 m tile of blades, sorted by a random rank) is
// instanced over the visible tiles within `radius` of the camera: two draw
// calls (near tiles draw every blade, far tiles a rank prefix). The vertex
// shader places each blade on the terrain (world height texture), keeps it
// only where the ground grows grass (biome density map baked here + the
// terrain's own sand / rock / path / paving masks and slope), thins it out
// with distance by rank, leans it (static, no sway) and colors it from the
// terrain's ground color so the lawn and the ground under it agree.
import * as THREE from "three";
import { Biome, CELL, GRID_RES, NO_WATER, WORLD_HALF, WORLD_SIZE, type World } from "../../../../shared/world/types";
import { makeStyledMaterial, type PatchHooks } from "../patch";
import { GRID_UV_GLSL, type WorldTextures } from "../worldTextures";
import { PAINT_SAMPLE_GLSL } from "../paint";

export interface GrassOptions {
  /** fade-out radius (m) */
  radius: number;
  /** blade density multiplier (0..1) */
  density: number;
  paint?: Record<string, THREE.IUniform>;
}

const TILE = 4; // m
const BLADES = 1600; // per tile at full density (100 / m2)
const NT = WORLD_SIZE / TILE;
/** full density out to THIN_D0 m, then falling with 1 / d^2 (never below THIN_MIN) */
const THIN_D0 = 8, THIN_MIN = 0.03;

/** Base grass density, dryness, height by biome. */
const BIOME_GRASS: Partial<Record<Biome, [number, number, number]>> = {
  [Biome.Meadow]: [1.0, 0.1, 1.0],
  [Biome.PalmGrove]: [0.8, 0.15, 0.75],
  [Biome.Riverbank]: [0.9, 0.0, 1.0],
  [Biome.Scrub]: [0.7, 0.7, 0.8],
  [Biome.Village]: [0.45, 0.2, 0.45],
  [Biome.Mangrove]: [0.3, 0.0, 0.8],
  [Biome.Forest]: [0.28, 0.5, 0.7],
  [Biome.Jungle]: [0.14, 0.0, 0.85],
  [Biome.Rock]: [0.14, 0.4, 0.55],
  [Biome.Cliff]: [0.04, 0.3, 0.5],
};

function boxBlur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const w = 1 / (2 * r + 1);
  for (let z = 0; z < n; z++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[z * n + Math.min(n - 1, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      tmp[z * n + x] = acc * w;
      acc += src[z * n + Math.min(n - 1, x + r + 1)] - src[z * n + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
    for (let z = 0; z < n; z++) {
      out[z * n + x] = acc * w;
      acc += tmp[Math.min(n - 1, z + r + 1) * n + x] - tmp[Math.max(0, z - r) * n + x];
    }
  }
  return out;
}

/** GRID_RES^2 RGBA: r density, g dryness, b height. */
function buildGrassMap(world: World): THREE.DataTexture {
  const N = GRID_RES, n = N * N, H = world.height;
  const dens = new Float32Array(n), dry = new Float32Array(n), hgt = new Float32Array(n);
  const climateDry = world.climate === "dry" ? 0.35 : world.climate === "mediterranean" ? 0.18 : world.climate === "lush" ? -0.1 : 0;
  // structure footprints (+0.6 m)
  const occ = new Uint8Array(n);
  for (const st of world.structures) for (const s of st.solids) {
    const r = Math.hypot(s.hx, s.shape === "cylinder" ? s.hx : s.hz) + 0.6;
    const i0 = Math.max(0, Math.floor((s.cx - r + WORLD_HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((s.cx + r + WORLD_HALF) / CELL));
    const j0 = Math.max(0, Math.floor((s.cz - r + WORLD_HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((s.cz + r + WORLD_HALF) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) occ[j * N + i] = 1;
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const g = BIOME_GRASS[world.biome[k] as Biome];
    if (!g) continue;
    const h = H[k];
    const m = world.moisture[k] / 255;
    let d = g[0];
    if (h < 0.5 || occ[k] || world.holes[k]) d = 0;
    if (world.water[k] !== NO_WATER && world.water[k] > h - 0.1) d = 0;
    d *= 1 - Math.min(1, Math.max(0, (world.path[k] - 25) / 60));
    const hl = H[k - (i > 0 ? 1 : 0)], hr = H[k + (i < N - 1 ? 1 : 0)], hd = H[k - (j > 0 ? N : 0)], hu = H[k + (j < N - 1 ? N : 0)];
    const sl = Math.hypot(hr - hl, hu - hd) / (2 * CELL);
    d *= 1 - Math.min(1, Math.max(0, (sl - 0.5) / 0.45));
    // drier ground: sparser and straw-colored; wet: lush
    d *= 0.75 + 0.25 * Math.min(1, m * 1.6);
    dens[k] = d;
    dry[k] = Math.min(1, Math.max(0, g[1] + climateDry + (0.45 - m) * 0.5));
    hgt[k] = Math.min(1, Math.max(0, g[2] * (0.8 + m * 0.35)));
  }
  const dB = boxBlur(dens, N, 1), yB = boxBlur(dry, N, 2), hB = boxBlur(hgt, N, 2);
  const data = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    // keep hard zeros (structures, water, holes) sharp
    const d = dens[k] === 0 ? Math.min(dB[k], 0.15) : dB[k];
    data[k * 4] = Math.round(Math.min(1, d) * 255);
    data[k * 4 + 1] = Math.round(yB[k] * 255);
    data[k * 4 + 2] = Math.round(hB[k] * 255);
    data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** One tile of blades: 5 vertices / 3 triangles each, sorted by rank. */
function buildPatch(): THREE.BufferGeometry {
  let s = 0x9e3779b9;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((s ^ (s >>> 13)) >>> 0) / 4294967296; };
  const side = Math.round(Math.sqrt(BLADES));
  const blades: [number, number, number, number][] = [];
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    blades.push([((i + rnd()) / side) * TILE, ((j + rnd()) / side) * TILE, rnd(), rnd()]);
  }
  blades.sort((a, b) => a[2] - b[2]);
  const bp = new Float32Array(blades.length * 5 * 4);
  const bv = new Float32Array(blades.length * 5 * 2);
  const idx: number[] = [];
  const verts: [number, number][] = [[0, -1], [0, 1], [0.5, -1], [0.5, 1], [1, 0]];
  blades.forEach((bl, b) => {
    for (let v = 0; v < 5; v++) {
      const o = b * 5 + v;
      bp.set(bl, o * 4);
      bv.set(verts[v], o * 2);
    }
    const o = b * 5;
    idx.push(o, o + 1, o + 3, o, o + 3, o + 2, o + 2, o + 3, o + 4);
  });
  const g = new THREE.BufferGeometry();
  // three needs a position attribute; the shader builds the real position
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(blades.length * 5 * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(blades.length * 5 * 3), 3));
  g.setAttribute("bp", new THREE.BufferAttribute(bp, 4));
  g.setAttribute("bv", new THREE.BufferAttribute(bv, 2));
  g.setIndex(idx);
  return g;
}

function grassHooks(world: World, tex: WorldTextures, map: THREE.DataTexture, opts: GrassOptions): PatchHooks {
  const paint = !!opts.paint;
  return {
    key: "grass" + (paint ? "-p" : ""),
    uniforms: {
      tHeight: { value: tex.height }, tGround: { value: tex.ground }, tGMask: { value: tex.mask }, tNrm: { value: tex.normal }, tGrass: { value: map },
      uGrass: { value: new THREE.Vector4(opts.radius, opts.density, 0, 0) },
      ...(opts.paint ?? {}),
    },
    defines: paint ? { GRASS_PAINT: 1 } : {},
    vertexPars: /* glsl */ `
      attribute vec4 bp; // tile x, z, rank, seed
      attribute vec2 bv; // t along the blade, side
      attribute vec2 tile; // tile origin x z
      uniform sampler2D tHeight, tGround, tGMask, tNrm, tGrass;
      uniform vec4 uGrass; // radius, density
      varying vec3 vGCol;
      varying float vGT;
      ${GRID_UV_GLSL}
      ${paint ? PAINT_SAMPLE_GLSL : ""}
      float gHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
      vec2 gXZ; vec2 gUV; vec3 gTN; vec2 gDir; float gSeed;
    `,
    vertexNormal: /* glsl */ `
      gXZ = tile + bp.xy;
      gUV = gridUV(gXZ);
      vec4 gNR = texture2D(tNrm, gUV);
      gTN = vec3(gNR.r * 2.0 - 1.0, 0.0, gNR.g * 2.0 - 1.0);
      gTN.y = sqrt(max(1.0 - dot(gTN.xz, gTN.xz), 0.0));
      gSeed = bp.w;
      float ga = gSeed * 6.2831853;
      gDir = vec2(cos(ga), sin(ga));
      // mostly the ground's normal, so blades light like the terrain under them
      objectNormal = normalize(mix(vec3(gDir.x, 0.25, gDir.y), gTN, 0.7));
    `,
    vertexTransform: /* glsl */ `
      {
        vec4 D = texture2D(tGrass, gUV);
        vec4 M = texture2D(tGMask, gUV);
        float slope = 1.0 - gTN.y;
        float dens = D.r * uGrass.y;
        // where the terrain draws sand, rock, paths or paving there is no grass
        dens *= 1.0 - smoothstep(0.2, 0.55, M.g);
        dens *= 1.0 - smoothstep(0.3, 0.7, M.r);
        dens *= 1.0 - smoothstep(0.25, 0.55, M.b);
        dens *= 1.0 - smoothstep(0.3, 0.6, M.a);
        dens *= 1.0 - smoothstep(0.34, 0.52, slope);
        dens *= step(texture2D(tNrm, gUV).a, 0.5);
        float y = texture2D(tHeight, gUV).r;
        float dist = length(vec3(gXZ.x, y, gXZ.y) - cameraPosition);
        float R = uGrass.x;
        // thin out with distance by rank (far tiles only draw a rank prefix)
        // ~constant blades per pixel: density falls with the square of the distance
        float thin = clamp(${(THIN_D0 * THIN_D0).toFixed(1)} / max(dist * dist, 1.0), ${THIN_MIN.toFixed(3)}, 1.0);
        float keep = dens * thin;
        float k = clamp((keep - bp.z) / 0.03, 0.0, 1.0) * (1.0 - smoothstep(R * 0.8, R, dist));
        float h1 = gHash(gSeed * 91.7 + 3.1), h2 = gHash(gSeed * 47.3 + 7.7), h3 = gHash(gSeed * 13.1 + 1.3);
        float h = mix(0.09, 0.33, D.b) * (0.55 + 0.9 * h1 * h1) * k;
        // static: each blade leans its own way, the field combed a little downwind
        vec2 lean = gDir * (0.12 + 0.4 * h2);
        vec2 bend = lean + uWind * (0.12 + 0.2 * h3);
        float t = bv.x;
        vec3 p = vec3(gXZ.x, y - 0.04, gXZ.y);
        p.xz += bend * h * t * t;
        p.y += h * t * (1.0 - 0.25 * min(dot(bend, bend), 1.0) * t);
        // sparser far away: wider blades keep the coverage
        float w = 0.02 * (0.7 + 0.6 * h2) * (1.0 - t * 0.85) * k * min(3.0, inversesqrt(thin));
        p.xz += vec2(-gDir.y, gDir.x) * bv.y * w;
        transformed = p;
        #ifndef IS_DEPTH
        vec4 G = texture2D(tGround, gUV);
        vec3 c = G.rgb;
        // straw on dry ground (and a few dead blades anywhere), hue and value scatter per blade
        float dryK = clamp(D.g * (0.4 + 0.8 * h3) + step(0.93, h3) * 0.6, 0.0, 1.0);
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3(lum) * vec3(1.5, 1.25, 0.7), dryK * 0.75);
        c *= (0.78 + 0.44 * h2) * vec3(1.0 + (h3 - 0.5) * 0.18, 1.0, 1.0 - (h1 - 0.5) * 0.2);
        c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.16); // match the terrain's muted greens
        c *= mix(0.45, 1.0, G.a);
        #ifdef GRASS_PAINT
        vec4 P = samplePaint(gXZ);
        if (P.a > 0.5) c = mix(c, P.rgb / max(P.a, 1e-3), 0.85);
        #endif
        vGCol = c;
        vGT = t;
        #endif
      }
    `,
    fragPars: /* glsl */ `
      varying vec3 vGCol;
      varying float vGT;
    `,
    fragColor: /* glsl */ `
      // darker in the thatch, sunlit tips
      diffuseColor.rgb = vGCol * mix(0.5, 1.2, vGT * (2.0 - vGT));
      gTransl = diffuseColor.rgb * 0.9 * vGT;
    `,
    fragNormal: /* glsl */ `
      normal *= faceDirection;
    `,
  };
}

export function createGrass(world: World, tex: WorldTextures, env: Record<string, THREE.IUniform>, opts: GrassOptions) {
  const group = new THREE.Group();
  group.name = "grass";
  const t0 = performance.now();
  const map = buildGrassMap(world);
  // per-tile height range for culling
  const minY = new Float32Array(NT * NT).fill(1e9), maxY = new Float32Array(NT * NT).fill(-1e9);
  const dMax = new Uint8Array(NT * NT);
  const md = map.image.data as Uint8Array;
  for (let j = 0; j < GRID_RES; j++) for (let i = 0; i < GRID_RES; i++) {
    const x = -WORLD_HALF + i * CELL, z = -WORLD_HALF + j * CELL;
    const tx = Math.min(NT - 1, Math.floor((x + WORLD_HALF) / TILE)), tz = Math.min(NT - 1, Math.floor((z + WORLD_HALF) / TILE));
    // a grid sample touches the tiles on both sides of a tile edge
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const ux = (x + WORLD_HALF) / TILE + dx * 0.01, uz = (z + WORLD_HALF) / TILE + dz * 0.01;
      const ax = Math.min(NT - 1, Math.max(0, Math.floor(ux))), az = Math.min(NT - 1, Math.max(0, Math.floor(uz)));
      const c = az * NT + ax;
      const h = world.height[j * GRID_RES + i];
      if (h < minY[c]) minY[c] = h;
      if (h > maxY[c]) maxY[c] = h;
      dMax[c] = Math.max(dMax[c], md[(j * GRID_RES + i) * 4]);
    }
    void tx; void tz;
  }
  const patch = buildPatch();
  const hk = grassHooks(world, tex, map, opts);
  const mat = makeStyledMaterial(env, hk, { side: THREE.DoubleSide });
  const maxTiles = Math.ceil(Math.PI * (opts.radius / TILE + 2) ** 2);
  const mk = (blades: number) => {
    const g = new THREE.InstancedBufferGeometry();
    for (const n of ["position", "normal", "bp", "bv"]) g.setAttribute(n, patch.getAttribute(n));
    g.setIndex(patch.getIndex());
    g.setDrawRange(0, blades * 9);
    const arr = new Float32Array(maxTiles * 2);
    const ib = new THREE.InstancedBufferAttribute(arr, 2);
    ib.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("tile", ib);
    g.instanceCount = 0;
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    group.add(m);
    return { mesh: m, geo: g, ib, arr };
  };
  // Blade-count levels (rank prefixes of the patch). A tile draws the smallest prefix that holds
  // every blade the shader can keep there: density thinning at its nearest point x its densest ground.
  const LEVELS = [1, 0.45, 0.2, 0.09, 0.04];
  const thinAt = (d: number) => Math.min(1, Math.max(THIN_MIN, (THIN_D0 * THIN_D0) / Math.max(1, d * d)));
  const rings = LEVELS.map((keep, i) => {
    const L = mk(Math.round(BLADES * keep));
    L.mesh.name = "grass-" + i;
    return { ...L, keep };
  });
  const buildMs = performance.now() - t0;

  const frustum = new THREE.Frustum();
  const pv = new THREE.Matrix4();
  const box = new THREE.Box3();
  const last = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), dir = new THREE.Vector3();
  let drawn = 0;
  function rebuild(camera: THREE.Camera) {
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv, THREE.WebGLCoordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    const cp = camera.position;
    const R = opts.radius;
    const counts = rings.map(() => 0);
    const cx = Math.floor((cp.x + WORLD_HALF) / TILE), cz = Math.floor((cp.z + WORLD_HALF) / TILE);
    const rt = Math.ceil(R / TILE) + 1;
    for (let dz = -rt; dz <= rt; dz++) for (let dx = -rt; dx <= rt; dx++) {
      const tx = cx + dx, tz = cz + dz;
      if (tx < 0 || tz < 0 || tx >= NT || tz >= NT) continue;
      const c = tz * NT + tx;
      if (dMax[c] < 3) continue;
      const x0 = -WORLD_HALF + tx * TILE, z0 = -WORLD_HALF + tz * TILE;
      const ddx = Math.max(x0 - cp.x, 0, cp.x - x0 - TILE), ddz = Math.max(z0 - cp.z, 0, cp.z - z0 - TILE);
      const d = Math.hypot(ddx, ddz, Math.max(0, cp.y - maxY[c] - 0.5));
      if (d > R) continue;
      if (cp.y - maxY[c] > R) continue;
      box.min.set(x0 - 0.6, minY[c] - 0.2, z0 - 0.6);
      box.max.set(x0 + TILE + 0.6, maxY[c] + 0.8, z0 + TILE + 0.6);
      if (!frustum.intersectsBox(box)) continue;
      const need = thinAt(d) * (dMax[c] / 255) * opts.density + 0.03;
      let ri = 0;
      while (ri < rings.length - 1 && rings[ri + 1].keep >= need) ri++;
      const L = rings[ri], n = counts[ri]++;
      L.arr[n * 2] = x0; L.arr[n * 2 + 1] = z0;
    }
    drawn = 0;
    rings.forEach((L, i) => {
      const n = counts[i];
      L.ib.clearUpdateRanges(); L.ib.addUpdateRange(0, n * 2); L.ib.needsUpdate = true;
      L.geo.instanceCount = n;
      L.mesh.visible = n > 0;
      drawn += n;
    });
  }
  return {
    group,
    buildMs,
    update(camera: THREE.Camera) {
      camera.getWorldDirection(dir);
      if (camera.position.distanceToSquared(last) > 0.5 || dir.dot(lastDir) < 0.9995) {
        last.copy(camera.position);
        lastDir.copy(dir);
        rebuild(camera);
      }
    },
    tiles: () => drawn,
    dispose() {
      patch.dispose(); rings.forEach((L) => L.geo.dispose()); mat.dispose(); map.dispose();
    },
  };
}
