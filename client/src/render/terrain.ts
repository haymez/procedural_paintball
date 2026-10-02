// Chunked heightfield terrain with distance LOD (skirts hide cracks), frustum
// culling (three.js per-chunk bounds), holes for cave mouths, and a splat
// shader over CC0 photo textures (ground.ts): biome-tinted grass, forest
// floors, sand, rock (biplanar on faces), dirt paths, village ground, blended
// by height, plus wet sand, seabed caustics and the world paint layer.
import * as THREE from "three";
import { CELL, GRID_RES, WORLD_HALF, type World } from "../../../shared/world/types";
import { makeStyledMaterial } from "./patch";
import { GRID_UV_GLSL, type WorldTextures } from "./worldTextures";
import { PAINT_SAMPLE_GLSL } from "./paint";
import { WORLD_PALETTE } from "./style";
import { GROUND_GLSL, LAYER, loadGroundLayers, type GroundLayers } from "./ground";

const CHUNK = 64; // cells per chunk side (128 m)
const NCH = (GRID_RES - 1) / CHUNK; // 8
const LOD_STEPS = [1, 2, 4, 8];

export interface TerrainOptions {
  lodDistances: number[]; // distance thresholds for LOD 0->1, 1->2, 2->3
}

export interface Terrain {
  group: THREE.Group;
  material: THREE.MeshToonMaterial;
  /** Ground texture layers (rock / soil arrays, climate knobs) for materials that should match the terrain. */
  ground: GroundLayers["uniforms"];
  update(camera: THREE.Camera): void;
  dispose(): void;
}

const glslColor = (hex: number) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

export function terrainShaderHooks(tex: WorldTextures, paint: Record<string, THREE.IUniform>, ground: GroundLayers) {
  return {
    key: "terrain-v3",
    uniforms: {
      tGround: { value: tex.ground },
      tFloor: { value: tex.floor },
      tMask: { value: tex.mask },
      tNrm: { value: tex.normal },
      ...ground.uniforms,
      ...paint,
    },
    fragPars: /* glsl */ `
      uniform sampler2D tGround, tMask, tNrm, tFloor;
      ${PAINT_SAMPLE_GLSL}
      ${GRID_UV_GLSL}
      ${GROUND_GLSL}
      vec3 gN;
      float causticsAt(vec2 p, float t) {
        vec2 w = (noiseT(p * 0.031 + vec2(t * 0.006, 0.0)).ra - 0.5) * 1.6; // warp so the net isn't regular
        float a = noiseT((p + w) * 0.16 + vec2(t * 0.02, t * 0.011)).g;
        float b = noiseT((p - w) * 0.21 + vec2(-t * 0.014, t * 0.018) + 0.37).g;
        return pow(smoothstep(0.22, 0.0, min(a, b)), 2.0) * smoothstep(0.3, 0.65, noiseT(p * 0.05 + t * 0.004).r);
      }
    `,
    fragColor: /* glsl */ `
      vec2 guv = gridUV(vWPos.xz);
      vec4 G = texture2D(tGround, guv);
      vec4 M = texture2D(tMask, guv);
      vec4 NR = texture2D(tNrm, guv);
      vec3 n = vec3(NR.r * 2.0 - 1.0, 0.0, NR.g * 2.0 - 1.0);
      n.y = sqrt(max(1.0 - dot(n.xz, n.xz), 0.0));
      // geometry steeper than the 2 m grid says (cave-mouth patches, overhang walls): trust the facet
      float facetSlope;
      {
        vec3 fn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
        if (dot(fn, cameraPosition - vWPos) < 0.0) fn = -fn;
        facetSlope = 1.0 - abs(fn.y);
        if (fn.y < n.y - 0.35) n = fn;
      }
      // materials follow the real facet where it is cliff-steep (the 2 m grid normal smooths the
      // foot of a cliff into a gentle slope, which would put sand arches up the rock)
      float slope = max(1.0 - n.y, facetSlope * smoothstep(0.35, 0.7, facetSlope));
      vec2 p = vWPos.xz;
      float y = vWPos.y;
      float dist = length(vWPos - cameraPosition);
      float mid = 1.0 - smoothstep(120.0, 400.0, dist);
      vec4 nA = noiseT(p * 0.0045);
      vec4 nB = noiseT(p * 0.021);
      vec4 nC = noiseT(p * 0.09);
      vec4 nD = noiseT(p * 0.37);
      float ao = G.a;
      float tileK = smoothstep(0.35, 0.65, nB.r * 0.7 + nA.g * 0.3); // anti-tiling blend
      gNearN = dist < 170.0 && y > -5.0 ? 1.0 : 0.0; // far or deep under water: no detail normals
      // uv gradients for the texture fetches (taken here, in uniform control flow)
      vec2 pdx = dFdx(p), pdy = dFdy(p);
      vec2 zdx = dFdx(vec2(vWPos.z, y)), zdy = dFdy(vec2(vWPos.z, y));
      vec2 xdx = dFdx(vec2(vWPos.x, y)), xdy = dFdy(vec2(vWPos.x, y));
      vec3 base = G.rgb * (0.9 + 0.2 * nB.r);                        // biome color, macro variation
      // tangent-space detail normal (xy) accumulated over layers; h = current surface height
      vec2 dn; float h;
      vec2 tn; float th;

      // coverage of the layers that sit on top of the grass (decided first so hidden grass isn't sampled)
      float sandW = smoothstep(0.25, 0.75, M.g + (nD.r - 0.5) * 0.45) * (1.0 - smoothstep(0.22, 0.42, slope));
      // --- rock: outcrops (rock biome) and steep ground. Lush islands keep green on slopes
      // until it gets really steep, with rock showing in vertical runnels. ---
      vec2 fd = normalize(n.xz + vec2(1e-4));
      float along = dot(p, vec2(fd.y, -fd.x));                 // horizontal coordinate across a face
      float vegK = uClimate.x;
      float biomeRock = smoothstep(0.35, 0.75, M.r + (nC.r - 0.5) * 0.4) * (1.0 - vegK * 0.55 * smoothstep(0.8, 0.95, n.y) * smoothstep(0.4, 0.7, nC.g + nB.a * 0.4));
      // runnels only matter where there can be rock: below slope 0.11 the slope rock stays 0 for
      // any runnel value (lower edge >= 0.3, runnel shifts at most 0.18), so skip the two fetches
      vec2 rq = vec2(along * 0.09, y * 0.006), rqx = dFdx(rq), rqy = dFdy(rq);
      float runnel = 0.5;
      if (slope > 0.11 || biomeRock > 0.002) {
        const vec2 RQ2 = vec2(0.31 / 0.09, 0.02 / 0.006);
        runnel = textureGrad(uNoise, rq, rqx, rqy).r * 0.65 + textureGrad(uNoise, rq * RQ2, rqx * RQ2, rqy * RQ2).b * 0.35;
      }
      float slopeRock = smoothstep(mix(0.3, 0.46, vegK), mix(0.46, 0.66, vegK), slope + (runnel - 0.5) * mix(0.1, 0.36, vegK));
      float rockW = max(biomeRock, slopeRock);
      float steep = smoothstep(0.25, 0.6, slope);
      rockW *= 1.0 - smoothstep(-0.5, -3.0, y) * 0.6 * (1.0 - steep);
      // --- grass: photo detail on the biome color ---
      vec3 gc = uLayerMean[${LAYER.grass}];
      dn = vec2(0.0); h = 0.5;
      if (max(sandW, rockW) < 0.985) {
        gc = groundC(${LAYER.grass}.0, p / 2.6, pdx / 2.6, pdy / 2.6, tileK, dn, h).rgb;
        // steep vegetated slopes: project from the side (dominant axis) so the texture doesn't smear into stripes
        float steepG = smoothstep(0.22, 0.5, slope);
        if (steepG > 0.01) {
          vec2 t1; float h1;
          bool xa = abs(n.x) > abs(n.z);
          vec3 g1 = xa ? groundC(${LAYER.grass}.0, vec2(vWPos.z, y) / 2.6, zdx / 2.6, zdy / 2.6, tileK, t1, h1).rgb
                       : groundC(${LAYER.grass}.0, vec2(vWPos.x, y) / 2.6, xdx / 2.6, xdy / 2.6, tileK, t1, h1).rgb;
          gc = mix(gc, g1, steepG);
          h = mix(h, h1, steepG);
          dn *= 1.0 - steepG;
        }
      }
      vec3 col = base * detailOf(gc, ${LAYER.grass}.0);
      // sun-bleached and damp patches
      col = mix(col, col * vec3(1.08, 1.04, 0.84), smoothstep(0.58, 0.85, nA.a) * 0.45 * (0.4 + uClimate.w));
      col = mix(col, col * vec3(0.82, 0.92, 0.86), smoothstep(0.55, 0.8, nC.r) * 0.35);
      float bump = 0.55;

      // --- forest floors: rainforest leaf litter / Mediterranean needle duff ---
      vec2 FL = texture2D(tFloor, guv).rg;
      float floorF = max(FL.r, FL.g);
      if (floorF > 0.004) {
        float jl = FL.r / max(FL.r + FL.g, 1e-3);
        vec4 jc = vec4(0.0), fc = vec4(0.0);
        if (jl > 0.005) jc = groundC(${LAYER.jungle}.0, p / 2.2, pdx / 2.2, pdy / 2.2, tileK, tn, th);
        if (jl < 0.995) fc = groundC(${LAYER.forest}.0, p / 2.2, pdx / 2.2, pdy / 2.2, tileK, tn, th);
        vec3 jcol = mix(jc.rgb, base * detailOf(jc.rgb, ${LAYER.jungle}.0), 0.4) * 0.85;
        vec3 fcol = mix(fc.rgb, base * detailOf(fc.rgb, ${LAYER.forest}.0), 0.3);
        // mossy damp patches on the rainforest floor
        jcol = mix(jcol, base * 0.7 * detailOf(gc, ${LAYER.grass}.0), smoothstep(0.5, 0.75, nC.r * 0.7 + nD.a * 0.3) * 0.55);
        vec3 flc = mix(fcol, jcol, jl);
        float fh = mix(fc.a, jc.a, jl);
        float t = hblend(floorF, fh, h);
        col = mix(col, flc, t);
        h = mix(h, fh, t);
      }

      // --- sand: fine grains, golden on volcanic islands, paler on limestone ones ---
      if (sandW > 0.002) {
        vec4 sc = groundC(${LAYER.sand}.0, p / 3.2, pdx / 3.2, pdy / 3.2, tileK, tn, th);
        vec3 sd = pow(detailOf(sc.rgb, ${LAYER.sand}.0), vec3(0.55));
        vec3 sandC = uGroundT[3] * sd * (0.95 + 0.1 * nC.a);
        sandC = mix(sandC, ${glslColor(WORLD_PALETTE.seabed)} * sd * 0.82, smoothstep(0.5, -2.5, y));
        float t = hblend(sandW, sc.a * 0.6, h);
        col = mix(col, sandC, t);
        dn = mix(dn, tn * 0.6, t);
        h = mix(h, sc.a * 0.6, t);
      }

      if (rockW > 0.002) {
        // top-down sample for outcrops; biplanar (two vertical planes) for faces
        vec3 rcol = vec3(0.0); vec2 rn = vec2(0.0); float rh = 0.5;
        if (steep < 0.99) {
          vec4 rt = groundC(${LAYER.rockTop}.0, p / 5.5, pdx / 5.5, pdy / 5.5, tileK, tn, th);
          rcol = uGroundT[0] * pow(detailOf(rt.rgb, ${LAYER.rockTop}.0), vec3(uClimate.y)); rn = tn; rh = rt.a;
        }
        if (steep > 0.01) {
          vec2 wx = vec2(abs(n.x), abs(n.z));
          wx = pow(wx, vec2(4.0)); wx /= (wx.x + wx.y + 1e-4);
          vec2 tnx = vec2(0.0), tnz = vec2(0.0); float thx, thz;
          float faceK = smoothstep(0.3, 0.7, nB.g * 0.6 + nA.r * 0.4); // anti-tiling on big faces
          vec4 fx = vec4(0.0), fz = vec4(0.0);
          if (wx.x > 0.01) fx = groundC(${LAYER.rockFace}.0, vec2(vWPos.z, y * 1.15) / 9.0, zdx / 9.0, zdy / 9.0, faceK, tnx, thx);
          if (wx.y > 0.01) fz = groundC(${LAYER.rockFace}.0, vec2(vWPos.x, y * 1.15) / 9.0, xdx / 9.0, xdy / 9.0, faceK, tnz, thz);
          vec3 fcol = uGroundT[1] * pow(detailOf(fx.rgb * wx.x + fz.rgb * wx.y, ${LAYER.rockFace}.0), vec3(uClimate.y));
          vec2 fn = vec2(tnx.x * sign(n.x), tnx.y) * wx.x + vec2(tnz.x * sign(n.z), tnz.y) * wx.y; // (across, up)
          float fh = fx.a * wx.x + fz.a * wx.y;
          rcol = mix(rcol, fcol, steep);
          rn = mix(rn, fn, steep);
          rh = mix(rh, fh, steep);
        }
        rcol *= 0.88 + 0.24 * nC.a;
        // weathering: warm rust streaks on basalt, darker water stains down faces
        rcol = mix(rcol, rcol * vec3(1.25, 1.0, 0.82), smoothstep(0.55, 0.8, runnel) * 0.35 * uClimate.z);
        rcol *= 1.0 - mix(0.1, 0.25, uClimate.z) * smoothstep(0.6, 0.85, noiseT(vec2(along * 0.18, y * 0.004)).g) * steep;
        // big-scale tone variation so long faces don't read as one repeated swatch
        rcol *= 0.82 + 0.36 * noiseT(vec2(along * 0.011, y * 0.02) + 0.37).a;
        // moss / ferns creeping over rock where it isn't too steep (strongest on lush islands)
        float moss = smoothstep(0.55, 0.85, n.y + (nD.r - 0.5) * 0.35 + (runnel - 0.5) * 0.25 * vegK) * (0.35 + 0.65 * vegK);
        vec3 mossC = base * detailOf(gc, ${LAYER.grass}.0) * 0.8;
        rcol = mix(rcol, mossC, moss * (1.0 - M.g) * 0.85);
        float t = hblend(rockW, rh + 0.25, h);
        col = mix(col, rcol, t);
        dn = mix(dn, rn, t);
        h = mix(h, rh, t);
        bump = mix(bump, 1.1 - steep * 0.3, t);
      }

      // --- dirt paths: red laterite on volcanic islands, pale gravel elsewhere ---
      float pathW = smoothstep(0.28, 0.6, M.b + (nD.g - 0.5) * 0.35);
      if (pathW > 0.002) {
        vec4 dc = groundC(${LAYER.dirt}.0, p / 2.4, pdx / 2.4, pdy / 2.4, tileK, tn, th);
        vec3 dcol = uGroundT[2] * detailOf(dc.rgb, ${LAYER.dirt}.0) * (0.9 + 0.15 * nC.r);
        dcol = mix(dcol, dcol * 0.8, smoothstep(0.75, 1.0, M.b) * 0.4); // compacted center
        float t = hblend(pathW * (1.0 - rockW * 0.7), dc.a, h);
        col = mix(col, dcol, t);
        dn = mix(dn, tn, t);
        h = mix(h, dc.a, t);
      }

      // --- village yards, green and ballfield: trampled lawn with bare dirt patches (streets are paths) ---
      float paveW = smoothstep(0.35, 0.7, M.a + (nD.r - 0.5) * 0.3) * (1.0 - pathW);
      if (paveW > 0.002) {
        col = mix(col, col * vec3(1.04, 0.98, 0.82), paveW * 0.6); // drier, walked-on grass
        float bare = smoothstep(0.42, 0.68, nC.g * 0.55 + nD.b * 0.3 + nB.a * 0.25);
        if (bare > 0.002) {
          vec4 pc = groundC(${LAYER.pave}.0, p / 2.8, pdx / 2.8, pdy / 2.8, tileK, tn, th);
          float t = hblend(paveW * bare, pc.a, h);
          col = mix(col, pc.rgb * 0.95, t);
          dn = mix(dn, tn, t);
          h = mix(h, pc.a, t);
        }
      }

      // --- wet sand at the waterline ---
      float wave = 0.18 * sin(uTime * 0.9 + dot(p, vec2(0.05, 0.03)));
      float wet = (1.0 - smoothstep(0.0, 0.9, y - wave)) * step(-0.05, y - wave * 0.5);
      col *= 1.0 - wet * 0.38 * (0.4 + sandW);
      gSpec = wet * 0.35 * sandW;
      gShine = 40.0;

      // --- underwater: caustics and blue absorption on the seabed ---
      if (y < 0.0) {
        float depth = -y;
        col = mix(col, col * vec3(0.55, 0.85, 0.88), smoothstep(0.0, 6.0, depth));
        float ca = depth < 9.0 && mid > 0.01 ? causticsAt(p, uTime) : 0.0;
        col += vec3(0.55, 0.75, 0.7) * ca * 0.14 * smoothstep(0.0, 0.8, depth) * exp(-depth * 0.12) * mid;
      }

      // distant vegetated ground: shrub masses so forests and slopes don't read as flat felt
      {
        float veg = (1.0 - sandW) * (1.0 - rockW) * (1.0 - pathW) * (1.0 - paveW) * step(0.3, y);
        float farK = smoothstep(30.0, 120.0, dist);
        if (veg * farK > 0.0) {
          float shrubN = textureGrad(uNoise, p * 0.045 + 3.7, pdx * 0.045, pdy * 0.045).r * 0.6 + textureGrad(uNoise, p * 0.17 + 1.3, pdx * 0.17, pdy * 0.17).a * 0.4;
          col = mix(col, col * vec3(0.66, 0.78, 0.62), smoothstep(0.5, 0.66, shrubN) * veg * 0.6 * farK);
        }
      }
      // natural, slightly muted greens
      {
        float vg = (1.0 - sandW) * (1.0 - rockW * 0.5);
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, vec3(lum), 0.16 * vg);
      }
      col *= mix(0.45, 1.0, ao);

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
          dn *= 1.0 - edge * 0.7;
        }
      }

      diffuseColor.rgb = col;

      // detail normal: photo normals on top of the terrain normal (planar: tangent x = +X, y = +Z;
      // faces: x across the face, y = up), faded with distance
      float nk = bump * (1.0 - smoothstep(50.0, 165.0, dist));
      vec3 pn = n + vec3(dn.x, 0.0, dn.y) * nk * (1.0 - steep);
      // on faces, "up" in the texture tilts the normal up/down the slope
      vec3 acrossV = normalize(vec3(fd.y, 0.0, -fd.x));
      pn += (acrossV * dn.x + vec3(0.0, 1.0, 0.0) * dn.y) * nk * steep * 0.8;
      gN = normalize(pn);
    `,
    fragNormal: /* glsl */ `
      normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
    `,
  };
}

export function createTerrain(world: World, tex: WorldTextures, env: Record<string, THREE.IUniform>, paint: Record<string, THREE.IUniform>, opts: TerrainOptions): Terrain {
  const group = new THREE.Group();
  group.name = "terrain";
  const ground = loadGroundLayers(world);
  const material = makeStyledMaterial(env, terrainShaderHooks(tex, paint, ground), {});

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
      // no skirt along the edge of a hole (cave mouths): it would hang across the opening
      if (holeTest) {
        const cx = Math.min(m - 1, Math.min(top0 % vs, top1 % vs)), cz = Math.min(m - 1, Math.min(Math.floor(top0 / vs), Math.floor(top1 / vs)));
        if (holeTest(cx, cz)) continue;
      }
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
      // Draw order: the chunk(s) right around the camera first (a hill in front hides
      // what's behind it), the rest after the near props and buildings (renderOrder 0)
      // and before the far foliage LODs, so the splat shader skips ground they cover.
      ch.mesh.renderOrder = d < 12 ? 0 : 0.5;
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
    ground: ground.uniforms,
    update,
    dispose() {
      for (const ch of chunks) for (const g of ch.lods) g?.dispose();
      material.dispose();
      ground.dispose();
    },
  };
}
