// Caves: chunked surface nets over each cave using the shared collision SDF
// (shared/world/collide.ts caveShellSdf: walls plus the big rock features), so
// what you see is what you hit. The small free-standing rocks (stalagmites,
// boulders) are drawn as separate tessellated meshes of the same round cones
// the collision uses; stalactites and rubble are decor.
//
// Look: triplanar CC0 rock (dark wet basalt on volcanic islands, limestone with
// pale flowstone streaks elsewhere) with normal maps. Lighting is baked per
// vertex: daylight flows in from every opening along the cave graph (geodesic
// falloff, plus direct light where an opening is in view), its direction is
// kept so the normal maps and wet highlights respond to it; deep inside only a
// faint cool ambient and a few dim glow accents remain. Mouths keep a short
// additive light shaft, skylights a vertical one.
import * as THREE from "three";
import { CELL, GRID_RES, WORLD_HALF, type Cave, type CaveRock, type World } from "../../../shared/world/types";
import { caveSdf as collideCaveSdf, caveShellSdf, CAVE_FLOOR, CHAMBER_R, CHAMBER_SQUASH } from "../../../shared/world/collide";
import { ENV_PARS, NOISE_FNS } from "./glsl";
import { heightAt } from "./worldTextures";
import { loadTextureArray, texUrl } from "./assets";

export type CaveSdf = (x: number, y: number, z: number) => number;

/** Voxel size (m) of the wall mesh. */
const VOX = 0.8;
/** Voxels per mesh chunk side (XZ). */
const TILE = 40;
/** Coarse pre-pass stride (voxels). */
const CS = 2;
/** Skip exact evaluation this far (m) from a coarse sample's surface: chunk half-diagonal + wall wobble. */
const SAFE = CS * VOX * 0.5 * Math.sqrt(3) + 1.25;

// --------------------------------------------------------------------------------------------
// materials

const ROCK_VS = /* glsl */ `
  attribute vec3 aLight; attribute vec4 aDay; attribute vec2 aMisc;
  varying vec3 vLight; varying vec4 vDay; varying vec2 vMisc; varying vec3 vW; varying vec3 vN;
  void main() {
    vLight = aLight; vDay = aDay; vMisc = aMisc; vN = normal;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const ROCK_FS = /* glsl */ `
  precision highp sampler2DArray;
  ${ENV_PARS}
  ${NOISE_FNS}
  uniform sampler2DArray tCol, tNh;
  uniform float uLava;
  varying vec3 vLight; varying vec4 vDay; varying vec2 vMisc; varying vec3 vW; varying vec3 vN;
  void main() {
    vec3 n = normalize(vN);
    vec3 bw = pow(abs(n), vec3(4.0));
    bw /= dot(bw, vec3(1.0));
    float s = mix(0.31, 0.42, uLava);
    // a gentle warp keeps layered textures from reading as straight courses
    vec2 wp = (noiseT(vW.xz * 0.03 + vW.y * 0.02).ra - 0.5) * 0.14;
    vec2 uvX = vW.zy * s + wp, uvY = vW.xz * 0.31 + wp.yx, uvZ = vW.xy * s + wp;
    float fm = smoothstep(0.45, 0.85, n.y);
    float mouth = vMisc.y;
    // floors: limestone floors take the second layer; basalt floors are patchy rubble
    float kY = mix(fm, fm * smoothstep(0.42, 0.62, noiseT(vW.xz * 0.025).a) * 0.75, uLava);
    vec4 cX = texture(tCol, vec3(uvX, 0.0)), cZ = texture(tCol, vec3(uvZ, 0.0));
    // basalt rubble is toned down to sit with the walls
    vec4 cY = mix(texture(tCol, vec3(uvY, 0.0)), texture(tCol, vec3(uvY * 0.8, 1.0)) * mix(1.0, 0.5, uLava), kY);
    vec4 hX = texture(tNh, vec3(uvX, 0.0)), hZ = texture(tNh, vec3(uvZ, 0.0));
    vec4 hY = mix(texture(tNh, vec3(uvY, 0.0)), texture(tNh, vec3(uvY * 0.8, 1.0)), kY);
    vec3 alb = cX.rgb * bw.x + cY.rgb * bw.y + cZ.rgb * bw.z;
    float height = hX.b * bw.x + hY.b * bw.y + hZ.b * bw.z;
    vec2 tX = hX.xy * 2.0 - 1.0, tY = hY.xy * 2.0 - 1.0, tZ = hZ.xy * 2.0 - 1.0;
    vec3 pert = vec3(0.0, tX.y, tX.x) * bw.x + vec3(tY.x, 0.0, tY.y) * bw.y + vec3(tZ.x, tZ.y, 0.0) * bw.z;
    // macro variation breaks the tiling
    float m1 = noiseT(vW.xz * 0.013 + vW.y * 0.007).r, m2 = noiseT(vW.zy * 0.021 + 0.3).a;
    alb *= 0.72 + 0.5 * m1;
    float wet;
    float flow = 0.0;
    if (uLava > 0.5) {
      // basalt: near-black grey with faint oxidised red-brown bands where old lava levels stood
      float lum = dot(alb, vec3(0.3, 0.55, 0.15));
      alb = mix(alb, vec3(lum), 0.65) * vec3(0.95, 0.96, 1.0) * 0.8;
      float band = smoothstep(0.58, 0.82, noiseT(vec2(vW.y * 0.11 + m2 * 0.6, (vW.x + vW.z) * 0.004)).a);
      alb = mix(alb, alb * vec3(1.4, 1.0, 0.8), band * 0.3 * (1.0 - fm));
      wet = clamp(0.3 + 0.3 * fm + (1.0 - height) * 0.25, 0.0, 1.0);
    } else {
      // limestone: pale, slightly grey; thin flowstone streaks running down the walls
      alb = mix(alb, vec3(dot(alb, vec3(0.3, 0.5, 0.2))), 0.35) * vec3(1.05, 1.02, 0.97);
      float st = noiseT(vec2((vW.x - vW.z) * 0.42 + m2 * 0.3, vW.y * 0.022)).r * 0.65 + noiseT(vec2((vW.x + vW.z) * 0.2, vW.y * 0.03 + 0.5)).a * 0.35;
      flow = smoothstep(0.56, 0.74, st) * (1.0 - fm) * smoothstep(0.9, 0.35, abs(n.y)) * (0.4 + 0.6 * m2);
      alb = mix(alb, vec3(0.74, 0.66, 0.54) * (0.9 + 0.2 * m1), flow * 0.25);
      wet = clamp(0.25 + 0.5 * fm + flow * 0.5 + (1.0 - height) * 0.2, 0.0, 1.0);
    }
    // lichen and moss only where daylight reaches
    float moss = smoothstep(0.45, 0.95, mouth) * smoothstep(mix(0.5, 0.15, uLava), 0.8, n.y) * smoothstep(0.4, 0.7, noiseT(vW.xz * 0.07 + 0.2).r + height * 0.3);
    alb = mix(alb, vec3(0.16, 0.2, 0.08), moss * 0.5 * (0.4 + 0.6 * uLava));
    alb *= 1.0 - 0.28 * wet;
    vec3 N = normalize(n + pert * mix(mix(0.8, 0.5, uLava), 0.4, flow));
    // light: baked daylight (direction in vDay.xyz) re-shaded with the normal map
    float day = vDay.w;
    vec3 L = normalize(vDay.xyz + vec3(0.0, 1e-4, 0.0));
    float g0 = dot(n, L) * 0.55 + 0.45, g1 = dot(N, L) * 0.55 + 0.45;
    float shade = clamp(g1 / max(g0, 0.15), 0.35, 1.7);
    vec3 dayCol = mix(vec3(0.6, 0.68, 0.78), uSunColor * vec3(1.0, 0.92, 0.8), 0.45) * 1.5;
    float cav = mix(0.5, 1.05, height);
    // dark basalt gets a little more fill so rooms stay readable
    vec3 lin = vLight * mix(1.0, 1.35, uLava) * cav * mix(0.8, 1.15, g1) + dayCol * day * shade * cav;
    vec3 col = alb * lin;
    // wet sheen: highlight from the daylight, grazing glints from everything
    vec3 V = normalize(cameraPosition - vW);
    vec3 Hh = normalize(L + V);
    float gloss = mix(14.0, 70.0, wet);
    float sp = pow(max(dot(N, Hh), 0.0), gloss) * (gloss + 8.0) * 0.004 * (0.05 + 0.5 * wet);
    col += dayCol * min(day, 1.0) * sp;
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += (vLight + dayCol * min(day, 1.0) * 0.25) * fres * wet * 0.25;
    gl_FragColor = vec4(col, 1.0);
  }`;

// --------------------------------------------------------------------------------------------
// geometry helpers

/** Round cone (capped cone) mesh around the segment a-b, radii ra/rb; same shape as the collision rock. */
function roundCone(r: CaveRock, seg: number, rough: number, seed: number, pos: number[], nrm: number[], idx: number[]): void {
  const ax = r.ax, ay = r.ay, az = r.az;
  let bx = r.bx - ax, by = r.by - ay, bz = r.bz - az;
  let L = Math.hypot(bx, by, bz);
  let ra = r.ra, rb = r.rb;
  let cx = ax, cy = ay, cz = az;
  if (L < 1e-3 || Math.abs(ra - rb) >= L - 1e-3) {
    // degenerate: the bigger sphere
    if (rb > ra) { cx = r.bx; cy = r.by; cz = r.bz; ra = rb; }
    rb = ra;
    L = 0;
    bx = 0; by = 1; bz = 0;
  }
  const ux = L > 0 ? bx / L : 0, uy = L > 0 ? by / L : 1, uz = L > 0 ? bz / L : 0;
  // basis perpendicular to the axis
  let px = 1, py = 0, pz = 0;
  if (Math.abs(ux) > 0.9) { px = 0; py = 1; }
  let qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
  const ql = Math.hypot(qx, qy, qz);
  qx /= ql; qy /= ql; qz /= ql;
  px = qy * uz - qz * uy; py = qz * ux - qx * uz; pz = qx * uy - qy * ux;
  const th = L > 0 ? Math.asin(Math.max(-1, Math.min(1, (ra - rb) / L))) : 0;
  // profile: (radial, axial, normal angle) from the bottom pole up
  const prof: [number, number, number][] = [];
  const nA = 4, nB = 4;
  for (let k = 0; k <= nA; k++) {
    const a = -Math.PI / 2 + ((th + Math.PI / 2) * k) / nA;
    prof.push([ra * Math.cos(a), ra * Math.sin(a), a]);
  }
  for (let k = 0; k <= nB; k++) {
    const a = th + ((Math.PI / 2 - th) * k) / nB;
    prof.push([rb * Math.cos(a), L + rb * Math.sin(a), a]);
  }
  const b0 = pos.length / 3;
  const rows = prof.length;
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const bumps = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  for (let i = 0; i < rows; i++) {
    const [rr, hh, a] = prof[i];
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      const ct = Math.cos(t), st = Math.sin(t);
      const dx = px * ct + qx * st, dy = py * ct + qy * st, dz = pz * ct + qz * st;
      const nx = dx * ca + ux * sa, ny = dy * ca + uy * sa, nz = dz * ca + uz * sa;
      const pole = i === 0 || i === rows - 1 ? 0 : 1;
      const d = rough * pole * (Math.sin(t * 3 + bumps[0] + hh) * 0.45 + Math.sin(t * 5 + bumps[1] - hh * 2) * 0.25 + Math.sin(hh * 7 + bumps[2]) * 0.3 * Math.max(0.3, rr));
      pos.push(cx + ux * hh + dx * rr + nx * d, cy + uy * hh + dy * rr + ny * d, cz + uz * hh + dz * rr + nz * d);
      nrm.push(nx, ny, nz);
    }
  }
  const W = seg + 1;
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < seg; j++) {
      const a = b0 + i * W + j, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
}

/** Small irregular lump (rubble), radius r, sitting at p. */
const LUMP = new THREE.IcosahedronGeometry(1, 1);
function lump(x: number, y: number, z: number, r: number, seed: number, pos: number[], nrm: number[], idx: number[]): void {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const sx = r * (0.8 + rnd() * 0.5), sy = r * (0.5 + rnd() * 0.35), sz = r * (0.8 + rnd() * 0.5);
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  // the icosphere is non-indexed: weld by position so the lump shades smoothly
  const p = LUMP.getAttribute("position");
  const map = new Map<string, number>();
  const b0 = pos.length / 3;
  let nv = 0;
  for (let i = 0; i < p.count; i++) {
    const ux = p.getX(i), uy = p.getY(i), uz = p.getZ(i);
    const key = `${ux.toFixed(3)},${uy.toFixed(3)},${uz.toFixed(3)}`;
    let v = map.get(key);
    if (v === undefined) {
      const k = 1 + 0.18 * Math.sin(ux * 3 + ph[0]) * Math.sin(uy * 3 + ph[1]) + 0.12 * Math.sin(uz * 4 + ph[2]);
      pos.push(x + ux * sx * k, y + uy * sy * k, z + uz * sz * k);
      const nx = ux / sx, ny = uy / sy, nz = uz / sz, l = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / l, ny / l, nz / l);
      v = nv++;
      map.set(key, v);
    }
    idx.push(b0 + v);
  }
}

// --------------------------------------------------------------------------------------------

interface Opening {
  px: number; py: number; pz: number;
  /** outward direction (mouths) */
  ox: number; oz: number;
  sky: boolean;
  /** shaft radius (skylights) */
  r: number;
  I: number;
  geo: Float64Array;
}

export function createCaves(world: World, env: Record<string, THREE.IUniform>, sdfIn?: CaveSdf, terrainMaterial?: THREE.Material) {
  const group = new THREE.Group();
  group.name = "caves";
  group.matrixAutoUpdate = false; // all cave meshes are static: no per-frame matrix recompose
  // collision-exact SDF from the shared collision module (negative inside the air)
  const fullSdf: CaveSdf = sdfIn ?? ((x, y, z) => collideCaveSdf(world, x, y, z));
  const shellSdf: CaveSdf = sdfIn ?? ((x, y, z) => caveShellSdf(world, x, y, z));
  const disposables: { dispose(): void }[] = [];
  const lavaIsle = world.climate === "lush" || world.climate === "tropical";

  // ---------------------------------------------------------------- textures + materials
  const ids = lavaIsle ? ["rock_surface", "gray_rocks"] : ["rock_face_03", "rock_boulder_cracked"];
  const tcol = loadTextureArray(ids.map((id) => texUrl(`${id}/${id}_c.jpg`)), 512, {
    srgb: true,
    fallback: lavaIsle ? [[46, 44, 42, 255], [78, 66, 56, 255]] : [[140, 116, 88, 255], [160, 132, 104, 255]],
  });
  const tnh = loadTextureArray(ids.map((id) => texUrl(`${id}/${id}_nh.jpg`)), 512, { srgb: false, fallback: [[128, 128, 160, 255], [128, 128, 160, 255]] });
  const rockU = { ...env, tCol: { value: tcol.texture as THREE.Texture }, tNh: { value: tnh.texture as THREE.Texture }, uLava: { value: lavaIsle ? 1 : 0 } };
  void tcol.ready.then(() => { rockU.tCol.value = tcol.texture; });
  void tnh.ready.then(() => { rockU.tNh.value = tnh.texture; });
  disposables.push({ dispose: () => { tcol.texture.dispose(); tnh.texture.dispose(); } });
  const rockMat = new THREE.ShaderMaterial({ uniforms: rockU, vertexShader: ROCK_VS, fragmentShader: ROCK_FS });
  disposables.push(rockMat);

  const glowMat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    vertexShader: /* glsl */ `
      attribute vec3 color; attribute float aEmit; varying vec3 vC; varying float vE; varying vec3 vN; varying vec3 vW;
      void main() { vC = color; vE = aEmit; vN = normal; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${ENV_PARS}
      varying vec3 vC; varying float vE; varying vec3 vN; varying vec3 vW;
      void main() {
        float pulse = 0.85 + 0.15 * sin(uTime * 0.9 + vW.x * 2.0 + vW.z);
        vec3 c = vC * mix(0.05 + 0.05 * max(normalize(vN).y, 0.0), 0.9 * pulse, vE);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  disposables.push(glowMat);

  const shaftMat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vW; void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${ENV_PARS}
      ${NOISE_FNS}
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 v = normalize(cameraPosition - vW);
        float facing = pow(abs(dot(normalize(vN), v)), 1.5);
        float along = smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
        float dust = 0.6 + 0.4 * noiseT(vW.xz * 0.15 + vec2(0.0, uTime * 0.008) + vW.y * 0.05).r;
        float a = facing * along * dust * 0.07;
        gl_FragColor = vec4(uSunColor * vec3(1.0, 0.95, 0.82) * a, 1.0);
      }`,
  });
  disposables.push(shaftMat);

  let rs = (world.seed * 31 + 7) >>> 0;
  const rnd = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296);

  // ---------------------------------------------------------------- terrain holes (cave mouths)
  // terrain cells the terrain mesh drops (any corner is a hole) — the mouth patch must fill these
  const removed = (ix: number, iz: number) => {
    if (ix < 0 || iz < 0 || ix >= GRID_RES - 1 || iz >= GRID_RES - 1) return false;
    const i = iz * GRID_RES + ix, Hh = world.holes;
    return Hh[i] === 1 || Hh[i + 1] === 1 || Hh[i + GRID_RES] === 1 || Hh[i + GRID_RES + 1] === 1;
  };
  const cellOf = (v: number) => Math.floor((v + WORLD_HALF) / CELL);
  const removedAt = (x: number, z: number, m: number) =>
    removed(cellOf(x - m), cellOf(z - m)) || removed(cellOf(x + m), cellOf(z - m)) || removed(cellOf(x - m), cellOf(z + m)) || removed(cellOf(x + m), cellOf(z + m));
  /** Height of the rendered terrain triangles (same diagonals as terrain.ts LOD0). */
  const triHeight = (x: number, z: number) => {
    const gx = (x + WORLD_HALF) / CELL, gz = (z + WORLD_HALF) / CELL;
    const ix = Math.max(0, Math.min(GRID_RES - 2, Math.floor(gx))), iz = Math.max(0, Math.min(GRID_RES - 2, Math.floor(gz)));
    const fx = gx - ix, fz = gz - iz;
    const i = iz * GRID_RES + ix, Hh = world.height;
    const a = Hh[i], b = Hh[i + 1], c = Hh[i + GRID_RES], d = Hh[i + GRID_RES + 1];
    if ((ix + iz) & 1) return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
    return fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (c - a) * fz + (d - c) * fx;
  };
  /** approx. Euclidean distance to the terrain surface (vertical distance / slope factor) */
  const terrainDist = (x: number, y: number, z: number) => {
    const hx = heightAt(world, x + 0.5, z) - heightAt(world, x - 0.5, z);
    const hz = heightAt(world, x, z + 0.5) - heightAt(world, x, z - 0.5);
    return (triHeight(x, z) - y) / Math.sqrt(1 + hx * hx + hz * hz);
  };

  const caveBoxes: (THREE.Box3 | undefined)[] = [];
  const chunks: { mesh: THREE.Mesh; box: THREE.Box3; nearOpening: boolean; cave: number }[] = [];
  const openingsAll: { x: number; y: number; z: number }[][] = [];
  const timings: number[][] = [];

  function* buildCave(cave: Cave, ci: number): Generator<void, void> {
    if (cave.nodes.length === 0) return;
    const nodes = cave.nodes;
    // ---------------------------------------------------------- bounds
    const box = new THREE.Box3();
    const prims: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }[] = [];
    const floorOf = (n: (typeof nodes)[0]) => (n.r >= CHAMBER_R ? n.y - 0.45 * n.r : n.y - CAVE_FLOOR * n.r);
    for (const n of nodes) {
      const r = n.r >= CHAMBER_R ? n.r : n.r;
      const top = n.r >= CHAMBER_R ? n.y + n.r / CHAMBER_SQUASH : n.y + n.r;
      prims.push({ x0: n.x - r - 2, x1: n.x + r + 2, z0: n.z - r - 2, z1: n.z + r + 2, y0: floorOf(n) - 2, y1: top + 2 });
    }
    for (const [a, b] of cave.edges) {
      const A = nodes[a], B = nodes[b];
      const r = Math.max(A.r >= CHAMBER_R && B.r < CHAMBER_R ? 4.5 : A.r, B.r >= CHAMBER_R && A.r < CHAMBER_R ? 4.5 : B.r);
      prims.push({
        x0: Math.min(A.x, B.x) - r - 2, x1: Math.max(A.x, B.x) + r + 2, z0: Math.min(A.z, B.z) - r - 2, z1: Math.max(A.z, B.z) + r + 2,
        y0: Math.min(floorOf(A), floorOf(B)) - 2, y1: Math.max(A.y, B.y) + r + 2,
      });
    }
    for (const s of cave.shafts ?? []) {
      const top = Math.min(s.y1, heightAt(world, s.x, s.z) + 3);
      prims.push({ x0: s.x - s.r - 2, x1: s.x + s.r + 2, z0: s.z - s.r - 2, z1: s.z + s.r + 2, y0: s.y0 - 2, y1: top });
    }
    // dropped terrain cells around each mouth (their full height on cliffs)
    for (const en of cave.entrances) {
      const R = en.sky ? 10 : 18;
      const c0x = cellOf(en.x - R), c1x = cellOf(en.x + R), c0z = cellOf(en.z - R), c1z = cellOf(en.z + R);
      for (let iz = c0z; iz <= c1z; iz++) for (let ix = c0x; ix <= c1x; ix++) {
        if (!removed(ix, iz)) continue;
        let lo = 1e9, hi = -1e9;
        for (const [ox, oz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const gi = (iz + oz) * GRID_RES + ix + ox;
          lo = Math.min(lo, world.height[gi]);
          hi = Math.max(hi, world.height[gi]);
        }
        const x = -WORLD_HALF + ix * CELL, z = -WORLD_HALF + iz * CELL;
        prims.push({ x0: x - 2, x1: x + CELL + 2, z0: z - 2, z1: z + CELL + 2, y0: lo - 2.5, y1: hi + 2.5 });
      }
    }
    for (const p of prims) {
      box.expandByPoint(new THREE.Vector3(p.x0, p.y0, p.z0));
      box.expandByPoint(new THREE.Vector3(p.x1, p.y1, p.z1));
    }
    caveBoxes[ci] = box;

    // ---------------------------------------------------------- openings + geodesic light
    const openings: Opening[] = [];
    const graph: number[][] = nodes.map(() => []);
    cave.edges.forEach(([a, b], k) => { graph[a].push(k); graph[b].push(k); });
    const nearestNode = (x: number, y: number, z: number) => {
      let bi = 0, bd = 1e9;
      nodes.forEach((n, i) => { const d = Math.hypot(n.x - x, n.y - y, n.z - z) - n.r; if (d < bd) { bd = d; bi = i; } });
      return bi;
    };
    const dijkstra = (src: number, d0: number) => {
      const dist = new Float64Array(nodes.length).fill(1e9);
      const done = new Uint8Array(nodes.length);
      dist[src] = d0;
      for (;;) {
        let u = -1;
        for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
        if (u < 0 || dist[u] >= 1e9) break;
        done[u] = 1;
        for (const k of graph[u]) {
          const [a, b] = cave.edges[k];
          const v = a === u ? b : a;
          const A = nodes[u], B = nodes[v];
          const w = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
          if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;
        }
      }
      return dist;
    };
    for (const e of cave.entrances) {
      if (e.sky) {
        const sh = (cave.shafts ?? []).reduce((b, s) => (Math.hypot(s.x - e.x, s.z - e.z) < Math.hypot(b.x - e.x, b.z - e.z) ? s : b), (cave.shafts ?? [])[0]);
        if (!sh) continue;
        const src = nearestNode(sh.x, sh.y0, sh.z);
        openings.push({ px: sh.x, py: sh.y0, pz: sh.z, ox: 0, oz: 0, sky: true, r: sh.r, I: 1.25, geo: dijkstra(src, Math.hypot(nodes[src].x - sh.x, nodes[src].z - sh.z)) });
      } else {
        const px = e.x + e.dx * 1.5, py = e.y + 1.8, pz = e.z + e.dz * 1.5;
        const src = nearestNode(e.x, e.y + 1, e.z);
        openings.push({ px, py, pz, ox: e.dx, oz: e.dz, sky: false, r: 3, I: 1, geo: dijkstra(src, Math.hypot(nodes[src].x - px, nodes[src].y - py, nodes[src].z - pz)) });
      }
    }
    openingsAll.push(openings.map((o) => ({ x: o.px, y: o.py, z: o.pz })));
    // segment table for "which part of the cave is this point in"
    const segs = cave.edges.map(([a, b]) => {
      const A = nodes[a], B = nodes[b];
      return { a, b, ax: A.x, ay: A.y, az: A.z, bx: B.x, by: B.y, bz: B.z, ra: A.r >= CHAMBER_R && B.r < CHAMBER_R ? 4.5 : A.r, rb: B.r >= CHAMBER_R && A.r < CHAMBER_R ? 4.5 : B.r };
    });
    const chambers = nodes.map((n, i) => ({ n, i })).filter((c) => c.n.r >= CHAMBER_R);
    // glow accents: a few dim clusters deep inside (placed after the mesh exists)
    const glows: { x: number; y: number; z: number; c: THREE.Color; r: number }[] = [];

    const bakeOut = { lr: 0, lg: 0, lb: 0, dx: 0, dy: 1, dz: 0, day: 0, mouth: 0 };
    const tmpV = new THREE.Vector3();
    /** Baked light at a surface point with normal n and ambient occlusion ao (0..1). */
    const bake = (x: number, y: number, z: number, nx: number, ny: number, nz: number, ao: number, sdf: CaveSdf) => {
      // where in the graph is this point?
      let best = 1e9, ga = -1, gb = -1;
      for (const s of segs) {
        const bx = s.bx - s.ax, by = s.by - s.ay, bz = s.bz - s.az;
        const l2 = bx * bx + by * by + bz * bz;
        let u = l2 > 0 ? ((x - s.ax) * bx + (y - s.ay) * by + (z - s.az) * bz) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const qx = x - s.ax - bx * u, qy = y - s.ay - by * u, qz = z - s.az - bz * u;
        const d = Math.sqrt(qx * qx + qy * qy + qz * qz) - (s.ra + (s.rb - s.ra) * u);
        if (d < best) { best = d; ga = s.a; gb = s.b; }
      }
      for (const c of chambers) {
        const dx = x - c.n.x, dy = (y - c.n.y) * CHAMBER_SQUASH, dz = z - c.n.z;
        const d = (Math.sqrt(dx * dx + dy * dy + dz * dz) - c.n.r) * 0.8;
        if (d < best) { best = d; ga = c.i; gb = c.i; }
      }
      let day = 0, dx = 0, dy = 0, dz = 0, mouth = 0;
      for (const o of openings) {
        const ox = o.px - x, oy = o.py - y, oz = o.pz - z;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        // geodesic daylight (bounced along the passages)
        let g = 1e9, tx = 0, ty = 0, tz = 0;
        if (ga >= 0) {
          const A = nodes[ga], B = nodes[gb];
          const da = o.geo[ga] + Math.hypot(A.x - x, A.y - y, A.z - z), db = o.geo[gb] + Math.hypot(B.x - x, B.y - y, B.z - z);
          const T = da <= db ? A : B;
          g = Math.min(da, db);
          tx = T.x - x; ty = T.y - y; tz = T.z - z;
        }
        g = Math.min(g, dist * 1.6);
        const lam = o.sky ? 18 : 15;
        let ind = o.I * 0.6 * Math.exp(-g / lam);
        // direct: the opening itself is in view
        let dir = 0;
        if (dist < 34) {
          let vis = 1;
          const steps = 9;
          for (let k = 1; k < steps && vis > 0; k++) {
            const t = 0.6 / dist + (k / steps) * (1 - 0.6 / dist);
            if (sdf(x + ox * t, y + oy * t, z + oz * t) > 0.25) vis = 0;
          }
          if (vis > 0) {
            const inv = 1 / (dist || 1);
            const facing = Math.max(0, (nx * ox + ny * oy + nz * oz) * inv);
            if (o.sky) {
              const hd = Math.hypot(ox, oz);
              const pool = THREE.MathUtils.smoothstep(o.r * 2.2 + (o.py - y) * 0.12, o.r * 0.6, hd);
              dir = o.I * 1.6 * (0.25 + 0.75 * Math.max(0, ny)) * pool + o.I * 0.6 * facing * Math.exp(-dist / 14);
            } else {
              const out = Math.max(0, (o.ox * ox + o.oz * oz) * inv + 0.2);
              dir = o.I * 1.3 * Math.exp(-dist / 9) * (0.3 + 0.7 * facing) * Math.min(1, out * 1.2);
            }
          }
        }
        if (dir > 0) {
          // light arrives from the opening (from above under a skylight)
          const w = dir;
          if (o.sky) { dx += ox * 0.2 * w / (dist || 1); dy += w; dz += oz * 0.2 * w / (dist || 1); }
          else { dx += (ox / (dist || 1)) * w; dy += (oy / (dist || 1)) * w; dz += (oz / (dist || 1)) * w; }
        }
        if (ind > 1e-4) {
          const l = Math.hypot(tx, ty, tz) || 1;
          dx += (tx / l) * ind * 0.7; dy += (ty / l + 0.3) * ind * 0.7; dz += (tz / l) * ind * 0.7;
        }
        ind *= 0.45 + 0.55 * ao;
        day += dir + ind;
        if (!o.sky) mouth = Math.max(mouth, Math.exp(-dist / 7));
      }
      let lr = 0.4, lg = 0.43, lb = 0.5; // faint cool ambient, enough to make out shapes and players
      for (const gl of glows) {
        const ex = gl.x - x, ey = gl.y - y, ez = gl.z - z;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d > gl.r * 3) continue;
        const f = Math.exp(-d / gl.r) * (0.4 + 0.6 * Math.max(0, (ex * nx + ey * ny + ez * nz) / (d || 1))) * 0.5;
        lr += gl.c.r * f; lg += gl.c.g * f; lb += gl.c.b * f;
      }
      const a2 = 0.25 + 0.75 * ao;
      bakeOut.lr = lr * a2; bakeOut.lg = lg * a2; bakeOut.lb = lb * a2;
      tmpV.set(dx, dy, dz);
      if (tmpV.lengthSq() < 1e-10) tmpV.set(0, 1, 0);
      tmpV.normalize();
      bakeOut.dx = tmpV.x; bakeOut.dy = tmpV.y; bakeOut.dz = tmpV.z;
      bakeOut.day = Math.min(2.2, day);
      bakeOut.mouth = Math.min(1, mouth * 1.3);
      return bakeOut;
    };

    // ---------------------------------------------------------- wall mesh, chunk by chunk
    const t0 = performance.now();
    const ox0 = Math.floor(box.min.x / VOX) * VOX, oz0 = Math.floor(box.min.z / VOX) * VOX, oy0 = Math.floor(box.min.y / VOX) * VOX;
    const NX = Math.ceil((box.max.x - ox0) / VOX) + 1, NZ = Math.ceil((box.max.z - oz0) / VOX) + 1;
    const NY = Math.ceil((box.max.y - oy0) / VOX) + 1;
    const near = (x: number, z: number) => removedAt(x, z, 1.6);
    // near dropped cells the field is the rock boundary (terrain surface ∪ cave), elsewhere just the cave
    const field = (x: number, y: number, z: number) => {
      const c = shellSdf(x, y, z);
      return near(x, z) ? Math.min(terrainDist(x, y, z), c) : c;
    };
    let nVerts = 0;
    const floorVerts: number[] = []; // for decor: floor points [x, y, z]
    const ceilVerts: number[] = [];
    for (let tk = 0; tk < NZ - 1; tk += TILE)
      for (let ti = 0; ti < NX - 1; ti += TILE) {
        const i0 = ti, i1 = Math.min(NX - 1, ti + TILE), k0 = tk, k1 = Math.min(NZ - 1, tk + TILE);
        // y range of the primitives touching this tile
        const tx0 = ox0 + (i0 - 2) * VOX, tx1 = ox0 + (i1 + 2) * VOX, tz0 = oz0 + (k0 - 2) * VOX, tz1 = oz0 + (k1 + 2) * VOX;
        let ylo = 1e9, yhi = -1e9;
        for (const p of prims) {
          if (p.x1 < tx0 || p.x0 > tx1 || p.z1 < tz0 || p.z0 > tz1) continue;
          ylo = Math.min(ylo, p.y0);
          yhi = Math.max(yhi, p.y1);
        }
        if (ylo > yhi) continue;
        const j0 = Math.max(0, Math.floor((ylo - oy0) / VOX)), j1 = Math.min(NY - 1, Math.ceil((yhi - oy0) / VOX));
        if (j1 - j0 < 2) continue;
        // voxel block [i0-2, i1+1] x [j0, j1] x [k0-2, k1+1]
        const bi0 = i0 - 2, bk0 = k0 - 2;
        const bx = i1 + 1 - bi0 + 1, by = j1 - j0 + 1, bz = k1 + 1 - bk0 + 1;
        const vals = new Float32Array(bx * by * bz);
        const V = (i: number, j: number, k: number) => (k * by + j) * bx + i;
        // coarse pass
        const cxN = Math.ceil((bx - 1) / CS) + 1, cyN = Math.ceil((by - 1) / CS) + 1, czN = Math.ceil((bz - 1) / CS) + 1;
        const coarse = new Float32Array(cxN * cyN * czN);
        for (let k = 0; k < czN; k++) for (let j = 0; j < cyN; j++) for (let i = 0; i < cxN; i++)
          coarse[(k * cyN + j) * cxN + i] = field(ox0 + (bi0 + i * CS) * VOX, oy0 + (j0 + j * CS) * VOX, oz0 + (bk0 + k * CS) * VOX);
        yield;
        for (let k = 0; k < bz; k++) {
          const z = oz0 + (bk0 + k) * VOX;
          const ck = Math.min(czN - 1, Math.round(k / CS));
          for (let i = 0; i < bx; i++) {
            const x = ox0 + (bi0 + i) * VOX;
            const ci = Math.min(cxN - 1, Math.round(i / CS));
            const must = near(x, z);
            for (let j = 0; j < by; j++) {
              const cv = coarse[(ck * cyN + Math.min(cyN - 1, Math.round(j / CS))) * cxN + ci];
              vals[V(i, j, k)] = !must && (cv > SAFE || cv < -SAFE) ? cv : field(x, oy0 + (j0 + j) * VOX, z);
            }
          }
          if ((k & 7) === 7) yield;
        }
        // surface nets: a vertex per sign-changing cell
        const cnx = bx - 1, cny = by - 1, cnz = bz - 1;
        const cellV = new Int32Array(cnx * cny * cnz).fill(-1);
        const C = (i: number, j: number, k: number) => (k * cny + j) * cnx + i;
        const pos: number[] = [];
        const cvx = new Float32Array(8);
        const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
        const cedges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
        // cells [1, cnx-1) in x/z (cell index 0 is only there for gradients)
        for (let k = 1; k < cnz - 1; k++) for (let j = 0; j < cny; j++) for (let i = 1; i < cnx - 1; i++) {
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            cvx[c] = vals[V(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
            if (cvx[c] < 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (const [a, b] of cedges) {
            const va = cvx[a], vb = cvx[b];
            if ((va < 0) === (vb < 0)) continue;
            const t = va / (va - vb);
            sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
            sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
            sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
            n++;
          }
          cellV[C(i, j, k)] = pos.length / 3;
          pos.push(ox0 + (bi0 + i + sx / n) * VOX, oy0 + (j0 + j + sy / n) * VOX, oz0 + (bk0 + k + sz / n) * VOX);
        }
        const idx: number[] = [];
        const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
          if (a < 0 || b < 0 || c < 0 || d < 0) return;
          if (flip) idx.push(a, d, c, a, c, b); else idx.push(a, b, c, a, c, d);
        };
        // edges owned by this tile: base voxel x in [i0, i1), z in [k0, k1)  ->  block i in [2, 2 + i1 - i0)
        const iA = 2, iB = 2 + (i1 - i0), kA = 2, kB = 2 + (k1 - k0);
        for (let k = kA; k < kB; k++) for (let j = 1; j < by - 1; j++) for (let i = iA; i < iB; i++) {
          const a = vals[V(i, j, k)];
          const b = vals[V(i + 1, j, k)];
          if ((a < 0) !== (b < 0)) quad(cellV[C(i, j - 1, k - 1)], cellV[C(i, j, k - 1)], cellV[C(i, j, k)], cellV[C(i, j - 1, k)], a < 0);
          const c = vals[V(i, j + 1, k)];
          if ((a < 0) !== (c < 0)) quad(cellV[C(i - 1, j, k - 1)], cellV[C(i - 1, j, k)], cellV[C(i, j, k)], cellV[C(i, j, k - 1)], a < 0);
          const d = vals[V(i, j, k + 1)];
          if ((a < 0) !== (d < 0)) quad(cellV[C(i - 1, j - 1, k)], cellV[C(i, j - 1, k)], cellV[C(i, j, k)], cellV[C(i - 1, j, k)], a < 0);
        }
        yield;
        if (idx.length === 0) continue;
        const nv = pos.length / 3;
        // normals and AO straight from the voxel field (consistent across tiles)
        const sampleV = (x: number, y: number, z: number) => {
          let fi = (x - ox0) / VOX - bi0, fj = (y - oy0) / VOX - j0, fk = (z - oz0) / VOX - bk0;
          fi = Math.max(0, Math.min(bx - 1.001, fi)); fj = Math.max(0, Math.min(by - 1.001, fj)); fk = Math.max(0, Math.min(bz - 1.001, fk));
          const i = Math.floor(fi), j = Math.floor(fj), k = Math.floor(fk);
          const u = fi - i, v = fj - j, w = fk - k;
          const c00 = vals[V(i, j, k)] * (1 - u) + vals[V(i + 1, j, k)] * u;
          const c10 = vals[V(i, j + 1, k)] * (1 - u) + vals[V(i + 1, j + 1, k)] * u;
          const c01 = vals[V(i, j, k + 1)] * (1 - u) + vals[V(i + 1, j, k + 1)] * u;
          const c11 = vals[V(i, j + 1, k + 1)] * (1 - u) + vals[V(i + 1, j + 1, k + 1)] * u;
          return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
        };
        const nrm = new Float32Array(nv * 3);
        const ao = new Float32Array(nv);
        const out = new Float32Array(nv);
        const e = VOX * 0.75;
        for (let q = 0; q < nv; q++) {
          const x = pos[q * 3], y = pos[q * 3 + 1], z = pos[q * 3 + 2];
          let gx = sampleV(x + e, y, z) - sampleV(x - e, y, z), gy = sampleV(x, y + e, z) - sampleV(x, y - e, z), gz = sampleV(x, y, z + e) - sampleV(x, y, z - e);
          const l = Math.hypot(gx, gy, gz) || 1;
          gx /= -l; gy /= -l; gz /= -l; // into the air
          nrm[q * 3] = gx; nrm[q * 3 + 1] = gy; nrm[q * 3 + 2] = gz;
          const o1 = Math.min(1, Math.max(0, -sampleV(x + gx * 1.2, y + gy * 1.2, z + gz * 1.2) / 1.2));
          const o2 = Math.min(1, Math.max(0, -sampleV(x + gx * 2.8, y + gy * 2.8, z + gz * 2.8) / 2.8));
          ao[q] = Math.pow(o1 * 0.45 + o2 * 0.55, 1.2);
          // terrain term is the active one in the min() near a mouth: that part is the terrain patch
          out[q] = near(x, z) && terrainDist(x, y, z) <= shellSdf(x, y, z) ? 1 : 0;
        }
        // classify: cave walls (kept while under the hill) vs terrain patch (kept only inside dropped cells)
        const kept: number[] = [];
        const patch: number[] = [];
        const tvA = new Float32Array(nv);
        for (let q = 0; q < nv; q++) tvA[q] = terrainDist(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]);
        const steep = (a: number, b: number, c: number) => {
          const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
          const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          return Math.abs(ny) < 0.55 * Math.sqrt(nx * nx + ny * ny + nz * nz);
        };
        for (let t = 0; t < idx.length; t += 3) {
          const a = idx[t], b = idx[t + 1], c = idx[t + 2];
          const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
          const nOut = out[a] + out[b] + out[c];
          const ta = tvA[a], tb = tvA[b], tc = tvA[c];
          if (!nOut && !near(cx, cz)) {
            // cave wall sticking out above intact terrain (a breach near an opening): a floating panel from outside
            if (Math.min(ta, tb, tc) < -0.3) continue;
            kept.push(a, b, c);
            continue;
          }
          const inHole = removedAt(cx, cz, 0.05);
          if (nOut >= 2 || (nOut === 1 && inHole)) {
            // slight overlap into intact cells is invisible (same material, same triangulated surface) and closes pinholes
            if (!(inHole || removedAt(cx, cz, 0.6))) continue;
            patch.push(a, b, c);
            continue;
          }
          if (ta < -0.6 && tb < -0.6 && tc < -0.6) continue; // cave wall poking out of the hill
          if (!inHole && Math.min(ta, tb, tc) < -0.05) continue; // in front of intact terrain
          const wall = VOX * 1.2 + 0.4;
          const cs = (q: number) => (Math.abs(shellSdf(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2])) > wall ? 1 : 0);
          if (cs(a) + cs(b) + cs(c) >= 2) continue; // seam where the field switches
          // the floor of the mouth, still out under the sky, continues the ground outside
          if (inHole && !steep(a, b, c) && nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1] > 2.1 && Math.max(Math.abs(ta), Math.abs(tb), Math.abs(tc)) < 1.6) {
            patch.push(a, b, c);
            continue;
          }
          kept.push(a, b, c);
        }
        yield;
        // bake light
        const light = new Float32Array(nv * 3), dayA = new Float32Array(nv * 4), misc = new Float32Array(nv * 2);
        for (let q = 0; q < nv; q++) {
          const x = pos[q * 3], y = pos[q * 3 + 1], z = pos[q * 3 + 2];
          const nx = nrm[q * 3], ny = nrm[q * 3 + 1], nz = nrm[q * 3 + 2];
          if (out[q]) {
            // outside rock around a mouth: daylight from above
            light[q * 3] = 0.05; light[q * 3 + 1] = 0.06; light[q * 3 + 2] = 0.075;
            dayA[q * 4] = 0; dayA[q * 4 + 1] = 1; dayA[q * 4 + 2] = 0; dayA[q * 4 + 3] = 0.5 * (0.5 + 0.5 * Math.max(0, ny));
            misc[q * 2] = 1; misc[q * 2 + 1] = 1;
            continue;
          }
          const b = bake(x, y, z, nx, ny, nz, ao[q], shellSdf);
          light[q * 3] = b.lr; light[q * 3 + 1] = b.lg; light[q * 3 + 2] = b.lb;
          dayA[q * 4] = b.dx; dayA[q * 4 + 1] = b.dy; dayA[q * 4 + 2] = b.dz; dayA[q * 4 + 3] = b.day;
          misc[q * 2] = ao[q]; misc[q * 2 + 1] = b.mouth;
          if ((q & 63) === 0) {
            if (ny > 0.8 && b.mouth < 0.3) floorVerts.push(x, y, z, ao[q]);
            else if (ny < -0.85 && b.mouth < 0.4) ceilVerts.push(x, y, z);
          }
          if ((q & 2047) === 2047) yield;
        }
        nVerts += nv;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
        g.setAttribute("aLight", new THREE.BufferAttribute(light, 3));
        g.setAttribute("aDay", new THREE.BufferAttribute(dayA, 4));
        g.setAttribute("aMisc", new THREE.BufferAttribute(misc, 2));
        g.setIndex(kept);
        g.computeBoundingBox();
        g.computeBoundingSphere();
        disposables.push(g);
        const mesh = new THREE.Mesh(g, rockMat);
        mesh.name = "cave-rock";
        mesh.renderOrder = 1; // after the terrain, so the hidden interior is depth-rejected
        mesh.castShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
        const cb = g.boundingBox!.clone();
        const nearOpening = openings.some((o) => cb.distanceToPoint(new THREE.Vector3(o.px, o.py, o.pz)) < 45);
        chunks.push({ mesh, box: cb, nearOpening, cave: ci });
        if (patch.length && terrainMaterial) {
          // cliff face around the mouth, drawn with the terrain's own material so it blends seamlessly
          // both windings: the terrain material is front-side only and steep patches have unreliable orientation
          const nPatch = patch.length;
          for (let t = 0; t < nPatch; t += 3) patch.push(patch[t], patch[t + 2], patch[t + 1]);
          const pg = new THREE.BufferGeometry();
          pg.setAttribute("position", g.getAttribute("position"));
          pg.setAttribute("normal", g.getAttribute("normal"));
          pg.setIndex(patch);
          pg.computeBoundingSphere();
          disposables.push(pg);
          const pm = new THREE.Mesh(pg, terrainMaterial);
          pm.name = "cave-mouth-terrain";
          pm.castShadow = true;
          pm.receiveShadow = true;
          pm.matrixAutoUpdate = false;
          group.add(pm);
        }
      }
    const t1 = performance.now();

    // ---------------------------------------------------------- detail: rocks, stalactites, rubble, glow
    const dPos: number[] = [], dNrm: number[] = [], dIdx: number[] = [];
    // small free-standing rocks (collision round cones)
    (cave.rocks ?? []).forEach((r, k) => {
      if (r.shell) return;
      const thin = Math.max(r.ra, r.rb) < 0.95 && Math.hypot(r.bx - r.ax, r.by - r.ay, r.bz - r.az) > 1;
      roundCone(r, thin ? 9 : 11, thin ? 0.07 : 0.08 * Math.max(r.ra, r.rb), (world.seed + k * 977) >>> 0, dPos, dNrm, dIdx);
    });
    // stalactites hanging from the ceiling (decor, kept above head height)
    const lavaCave = cave.style === "lava";
    const want = Math.min(ceilVerts.length / 3, lavaCave ? 40 : 110);
    for (let q = 0, made = 0; q < ceilVerts.length && made < want; q += 3) {
      if (rnd() > 0.75) continue;
      const x = ceilVerts[q] + (rnd() - 0.5) * 0.6, y = ceilVerts[q + 1], z = ceilVerts[q + 2] + (rnd() - 0.5) * 0.6;
      // clearance to the floor below
      let f = y - 0.5;
      while (f > y - 25 && fullSdf(x, f, z) < 0) f -= 0.4;
      const room = y - f;
      const len = Math.min(lavaCave ? 0.25 + rnd() * 0.5 : 0.5 + rnd() * rnd() * 2.6, room - 2.6);
      if (len < 0.2) continue;
      const rad = lavaCave ? 0.04 + rnd() * 0.05 : 0.08 + len * (0.08 + rnd() * 0.07);
      roundCone({ ax: x, ay: y + 0.3, az: z, bx: x + (rnd() - 0.5) * 0.1, by: y - len, bz: z + (rnd() - 0.5) * 0.1, ra: rad * 1.6, rb: rad * 0.25, shell: false }, 6, 0.01, made, dPos, dNrm, dIdx);
      made++;
    }
    // rubble along the foot of the walls
    const wantR = lavaCave ? 120 : 80;
    for (let q = 0, made = 0; q < floorVerts.length && made < wantR; q += 4) {
      if (floorVerts[q + 3] > 0.75 || rnd() > 0.7) continue;
      const n = 1 + Math.floor(rnd() * 4);
      for (let m = 0; m < n; m++) {
        const r = 0.1 + rnd() * rnd() * 0.32;
        lump(floorVerts[q] + (rnd() - 0.5) * 1.6, floorVerts[q + 1] - r * 0.35, floorVerts[q + 2] + (rnd() - 0.5) * 1.6, r, (made * 7919 + m) >>> 0, dPos, dNrm, dIdx);
        made++;
      }
    }
    // glow accents: a few dim clusters deep inside
    const mPos: number[] = [], mCol: number[] = [], mNrm: number[] = [], mEmit: number[] = [], mIdx: number[] = [];
    const glowPalette = [new THREE.Color(0x56d8c8), new THREE.Color(0x8ad86a), new THREE.Color(0xd8a050)];
    const wantG = 3 + Math.floor(rnd() * 3);
    for (let q = 0; q < floorVerts.length && glows.length < wantG; q += 4) {
      if (rnd() > 0.08) continue;
      const x = floorVerts[q], y = floorVerts[q + 1], z = floorVerts[q + 2];
      if (glows.some((gl) => Math.hypot(gl.x - x, gl.z - z) < 25)) continue;
      const c = glowPalette[Math.floor(rnd() * glowPalette.length)];
      glows.push({ x, y: y + 0.3, z, c, r: 2.2 });
      const count = 3 + Math.floor(rnd() * 5);
      for (let m = 0; m < count; m++) {
        const bx = x + (rnd() - 0.5) * 1.2, bz = z + (rnd() - 0.5) * 1.2, s = 0.35 + rnd() * 0.6;
        const stem = new THREE.CylinderGeometry(0.035 * s, 0.05 * s, 0.3 * s, 5, 1, true);
        const cap = new THREE.SphereGeometry(0.14 * s, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
        const put = (g: THREE.BufferGeometry, off: number, color: THREE.Color, emit: number, sy = 1) => {
          const p = g.getAttribute("position"), nn = g.getAttribute("normal");
          const b0 = mPos.length / 3;
          for (let i = 0; i < p.count; i++) {
            mPos.push(bx + p.getX(i), y + off + p.getY(i) * sy, bz + p.getZ(i));
            mNrm.push(nn.getX(i), nn.getY(i), nn.getZ(i));
            mCol.push(color.r, color.g, color.b);
            mEmit.push(emit);
          }
          const ix = g.index!;
          for (let i = 0; i < ix.count; i++) mIdx.push(b0 + ix.getX(i));
          g.dispose();
        };
        put(stem, 0.13 * s, new THREE.Color(0xc8d0cc), 0.1);
        put(cap, 0.27 * s, c, 1, 0.6);
      }
    }
    yield;
    if (dIdx.length) {
      const nv = dPos.length / 3;
      const light = new Float32Array(nv * 3), dayA = new Float32Array(nv * 4), misc = new Float32Array(nv * 2);
      for (let q = 0; q < nv; q++) {
        const x = dPos[q * 3], y = dPos[q * 3 + 1], z = dPos[q * 3 + 2];
        const nx = dNrm[q * 3], ny = dNrm[q * 3 + 1], nz = dNrm[q * 3 + 2];
        const o = Math.min(1, Math.max(0, -shellSdf(x + nx * 1.5, y + ny * 1.5, z + nz * 1.5) / 1.5));
        const ao = 0.35 + 0.65 * o;
        const b = bake(x, y, z, nx, ny, nz, ao, shellSdf);
        light[q * 3] = b.lr; light[q * 3 + 1] = b.lg; light[q * 3 + 2] = b.lb;
        dayA[q * 4] = b.dx; dayA[q * 4 + 1] = b.dy; dayA[q * 4 + 2] = b.dz; dayA[q * 4 + 3] = b.day;
        misc[q * 2] = ao; misc[q * 2 + 1] = b.mouth;
        if ((q & 2047) === 2047) yield;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(dPos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(dNrm, 3));
      g.setAttribute("aLight", new THREE.BufferAttribute(light, 3));
      g.setAttribute("aDay", new THREE.BufferAttribute(dayA, 4));
      g.setAttribute("aMisc", new THREE.BufferAttribute(misc, 2));
      g.setIndex(dIdx);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      disposables.push(g);
      const mesh = new THREE.Mesh(g, rockMat);
      mesh.name = "cave-detail";
      mesh.renderOrder = 1;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      chunks.push({ mesh, box: g.boundingBox!.clone(), nearOpening: true, cave: ci });
    }
    if (mIdx.length) {
      const mg = new THREE.BufferGeometry();
      mg.setAttribute("position", new THREE.Float32BufferAttribute(mPos, 3));
      mg.setAttribute("normal", new THREE.Float32BufferAttribute(mNrm, 3));
      mg.setAttribute("color", new THREE.Float32BufferAttribute(mCol, 3));
      mg.setAttribute("aEmit", new THREE.Float32BufferAttribute(mEmit, 1));
      mg.setIndex(mIdx);
      mg.computeBoundingBox();
      mg.computeBoundingSphere();
      disposables.push(mg);
      const mm = new THREE.Mesh(mg, glowMat);
      mm.name = "cave-glow";
      mm.renderOrder = 1;
      mm.matrixAutoUpdate = false;
      group.add(mm);
      chunks.push({ mesh: mm, box: mg.boundingBox!.clone(), nearOpening: false, cave: ci });
    }

    // light shafts: slanting in at each mouth, straight down under a skylight
    for (const o of openings) {
      let top = o.py, L = 13;
      if (o.sky) {
        top = heightAt(world, o.px, o.pz) + 1;
        let f = o.py;
        while (f > o.py - 30 && fullSdf(o.px, f, o.pz) < 0) f -= 0.5;
        L = Math.max(4, top - f);
      }
      const geo = o.sky ? new THREE.CylinderGeometry(o.r * 0.85, o.r * 1.6, L, 14, 1, true) : new THREE.CylinderGeometry(2.6, 1.5, L, 12, 1, true);
      // uv.y: 1 at the top (opening) -> 0 deep
      geo.translate(0, -L / 2, 0);
      const shaft = new THREE.Mesh(geo, shaftMat);
      if (o.sky) shaft.position.set(o.px, top, o.pz);
      else {
        const dir = new THREE.Vector3(-o.ox, 0, -o.oz).normalize().multiplyScalar(0.9).add(new THREE.Vector3(0, -0.55, 0)).normalize();
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
        shaft.position.set(o.px, o.py - 0.6, o.pz);
      }
      shaft.renderOrder = 6;
      shaft.updateMatrix();
      shaft.matrixAutoUpdate = false;
      shaft.name = "cave-shaft";
      disposables.push(geo);
      group.add(shaft);
    }
    timings.push([Math.round(t1 - t0), Math.round(performance.now() - t1), nVerts]);
  }

  const jobs = world.caves.map((c, i) => buildCave(c, i));
  /** CPU ms spent meshing (all caves). */
  let cpuMs = 0;
  /** Advance cave meshing; returns true when all caves are built. */
  function pump(budgetMs: number): boolean {
    const t = performance.now();
    while (jobs.length) {
      if (jobs[0].next().done) jobs.shift();
      if (performance.now() - t > budgetMs) break;
    }
    cpuMs += performance.now() - t;
    (group.userData as { cpuMs?: number }).cpuMs = Math.round(cpuMs);
    return jobs.length === 0;
  }

  let factor = 0;
  (group.userData as { timings?: number[][] }).timings = timings;
  const tmpP = new THREE.Vector3();
  return {
    group,
    /** Build every remaining cave now (blocking). */
    finish() { pump(Infinity); },
    /** Mesh for up to ms (loading screens). */
    step(ms: number) { pump(ms); },
    get pending() { return jobs.length > 0; },
    get left() { return jobs.length; },
    /** Returns 0..1: how deep inside a cave the camera is. */
    update(camera: THREE.Camera, dt: number) {
      if (jobs.length) pump(4);
      const p = camera.position;
      // interior chunks only matter from inside (or looking in through an opening)
      for (const c of chunks) {
        const box = caveBoxes[c.cave];
        const inside = box ? box.distanceToPoint(p) < 8 : true;
        const d = c.box.distanceToPoint(p);
        c.mesh.visible = d < 350 && (inside || c.nearOpening);
        c.mesh.castShadow = c.mesh.visible && d < 45 && c.mesh.name === "cave-rock";
        // deep inside, draw the cave first so the outdoor world behind its walls is depth-rejected
        c.mesh.renderOrder = factor > 0.5 ? -5 : 1;
      }
      let target = 0;
      if (caveBoxes.some((b) => b && b.containsPoint(p))) {
        const d = fullSdf(p.x, p.y, p.z);
        const below = heightAt(world, p.x, p.z) - p.y;
        if (d < 0.5) target = THREE.MathUtils.smoothstep(below, 1, 6);
        // a skylight overhead lets some sky in
        for (const ops of openingsAll) for (const o of ops) {
          tmpP.set(o.x, o.y, o.z);
          if (tmpP.distanceTo(p) < 12) target *= 0.8;
        }
      }
      factor += (target - factor) * Math.min(1, dt * 3);
      return factor;
    },
    dispose() { disposables.forEach((d) => d.dispose()); },
  };
}
