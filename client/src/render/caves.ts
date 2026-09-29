// Caves: surface nets over each cave's bounding box using the collision cave
// SDF (shared/world/collide.ts `caveSdf`), so what you see is what you hit.
// Lighting is baked per vertex: cool dark ambient, AO from the SDF, daylight
// spilling in from entrances, and colored glow from bioluminescent mushrooms
// and pools. Light shafts at the mouths are additive cones.
import * as THREE from "three";
import { CELL, GRID_RES, WORLD_HALF, type Cave, type World } from "../../../shared/world/types";
import { ENV_PARS, NOISE_FNS } from "./glsl";
import { heightAt } from "./worldTextures";
import { caveSdf as collideCaveSdf } from "../../../shared/world/collide";

export type CaveSdf = (x: number, y: number, z: number) => number;

/** Fallback SDF: union of spheres + tapered capsules (negative inside air). */
export function tubeGraphSdf(caves: Cave[]): CaveSdf {
  return (x, y, z) => {
    let d = 1e9;
    for (const c of caves) {
      for (const n of c.nodes) d = Math.min(d, Math.hypot(x - n.x, y - n.y, z - n.z) - n.r);
      for (const [ia, ib] of c.edges) {
        const A = c.nodes[ia], B = c.nodes[ib];
        const bx = B.x - A.x, by = B.y - A.y, bz = B.z - A.z;
        const l2 = bx * bx + by * by + bz * bz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - A.x) * bx + (y - A.y) * by + (z - A.z) * bz) / l2)) : 0;
        d = Math.min(d, Math.hypot(x - A.x - bx * t, y - A.y - by * t, z - A.z - bz * t) - (A.r + (B.r - A.r) * t));
      }
    }
    return d;
  };
}

interface Glow { p: THREE.Vector3; c: THREE.Color; r: number }

function* surfaceNets(sdf: CaveSdf, coarseSdf: CaveSdf, min: THREE.Vector3, dims: [number, number, number], h: number, mustEval: (x: number, z: number) => boolean = () => false): Generator<void, { pos: number[]; idx: number[] }> {
  const [nx, ny, nz] = dims;
  const vals = new Float32Array(nx * ny * nz);
  const I = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  // coarse pass: skip exact evaluation for voxels far from any wall
  const CS = 4;
  const cx = Math.ceil((nx - 1) / CS) + 1, cy = Math.ceil((ny - 1) / CS) + 1, cz = Math.ceil((nz - 1) / CS) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    coarse[(k * cy + j) * cx + i] = coarseSdf(min.x + i * CS * h, min.y + j * CS * h, min.z + k * CS * h);
  }
  const safe = CS * h * 0.9 + 1.2; // half-diagonal of a coarse cell + wobble margin
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    if (j === 0) yield;
    for (let i = 0; i < nx; i++) {
    const ci = Math.round(i / CS), cj = Math.round(j / CS), ck = Math.round(k / CS);
    const cv0 = coarse[(Math.min(ck, cz - 1) * cy + Math.min(cj, cy - 1)) * cx + Math.min(ci, cx - 1)];
    const px = min.x + i * h, pz = min.z + k * h;
    vals[I(i, j, k)] = Math.abs(cv0) > safe && !mustEval(px, pz) ? cv0 : sdf(px, min.y + j * h, pz);
    }
  }
  const cellV = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const C = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      cv[c] = vals[I(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
      if (cv[c] < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
      sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
      sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
      n++;
    }
    cellV[C(i, j, k)] = pos.length / 3;
    pos.push(min.x + (i + sx / n) * h, min.y + (j + sy / n) * h, min.z + (k + sz / n) * h);
  }
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, d, c, a, c, b); else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = vals[I(i, j, k)], b = vals[I(i + 1, j, k)];
    if ((a < 0) !== (b < 0)) quad(cellV[C(i, j - 1, k - 1)], cellV[C(i, j, k - 1)], cellV[C(i, j, k)], cellV[C(i, j - 1, k)], a < 0);
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = vals[I(i, j, k)], b = vals[I(i, j + 1, k)];
    if ((a < 0) !== (b < 0)) quad(cellV[C(i - 1, j, k - 1)], cellV[C(i - 1, j, k)], cellV[C(i, j, k)], cellV[C(i, j, k - 1)], a < 0);
  }
  for (let k = 0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = vals[I(i, j, k)], b = vals[I(i, j, k + 1)];
    if ((a < 0) !== (b < 0)) quad(cellV[C(i - 1, j - 1, k)], cellV[C(i, j - 1, k)], cellV[C(i, j, k)], cellV[C(i - 1, j, k)], a < 0);
  }
  return { pos, idx };
}

export function createCaves(world: World, env: Record<string, THREE.IUniform>, sdfIn?: CaveSdf, terrainMaterial?: THREE.Material) {
  const group = new THREE.Group();
  group.name = "caves";
  // collision-exact SDF from the shared collision module (negative inside the air)
  const sdf = sdfIn ?? ((x: number, y: number, z: number) => collideCaveSdf(world, x, y, z));
  const disposables: { dispose(): void }[] = [];

  const rockMat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 aLight; attribute vec3 color; attribute float aDay; attribute float aOut;
      varying vec3 vLight; varying vec3 vCol; varying vec3 vW; varying vec3 vN; varying float vDay; varying float vOut;
      void main() {
        vLight = aLight; vCol = color; vDay = aDay; vN = normal; vOut = aOut;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${ENV_PARS}
      ${NOISE_FNS}
      varying vec3 vLight; varying vec3 vCol; varying vec3 vW; varying vec3 vN; varying float vDay; varying float vOut;
      void main() {
        vec3 n = normalize(vN);
        vec3 an = abs(n);
        // triplanar-ish rock grain
        float g = noiseT(vW.xz * 0.21).r * an.y + noiseT(vW.xy * 0.21).r * an.z + noiseT(vW.zy * 0.21).r * an.x;
        float strata = sin(vW.y * 2.1 + g * 3.0) * 0.5 + 0.5;
        vec3 c = vCol * (0.8 + 0.35 * g) * (0.9 + 0.12 * strata);
        // glistening wet floor
        float wet = smoothstep(0.6, 0.95, n.y);
        c *= 1.0 - wet * 0.2;
        // near a mouth the rock turns into sunlit limestone so openings read as part of the cliff
        float dayK = clamp(vDay, 0.0, 1.0);
        vec3 lime = mix(vec3(0.69, 0.58, 0.41), vec3(0.57, 0.42, 0.28), strata) * (0.85 + 0.2 * g);
        vec3 alb = mix(c, lime, dayK * 0.85);
        vec3 lit = alb * vLight * (1.0 - dayK * 0.5);
        lit += alb * vDay * (uSunColor * 1.1 * smoothstep(-0.1, 0.5, dot(n, uSunDir)) + vec3(0.5, 0.58, 0.7) * (0.55 + 0.45 * n.y));
        // sparkle of minerals in glow light
        float sp = step(0.93, noiseT(vW.xz * 1.7 + vW.y).b) * 0.6;
        lit += vLight * sp * 0.3;
        if (vOut > 0.5) {
          // patch of cliff face around a mouth: match the terrain's sunlit limestone
          float bands = sin(vW.y * 0.85 + g * 4.0) * 0.5 + 0.5;
          vec3 alb = mix(vec3(0.69, 0.58, 0.41), vec3(0.57, 0.4, 0.26), smoothstep(0.3, 0.8, bands)) * (0.9 + 0.16 * g);
          float nl = dot(n, uSunDir);
          float ramp = smoothstep(-0.12, 0.45, nl);
          lit = alb * (vec3(0.55, 0.62, 0.72) * (0.6 + 0.4 * n.y) + uSunColor * 0.95 * ramp);
        }
        gl_FragColor = vec4(lit, 1.0);
      }`,
  });
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
        float pulse = 0.8 + 0.2 * sin(uTime * 1.3 + vW.x * 2.0 + vW.z);
        vec3 c = vC * mix(0.25 + 0.2 * max(normalize(vN).y, 0.0), 3.2 * pulse, vE);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  disposables.push(glowMat);

  const poolMat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    transparent: true,
    depthWrite: false,
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${ENV_PARS}
      ${NOISE_FNS}
      varying vec2 vUv; varying vec3 vW;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float edge = smoothstep(1.0, 0.8, r);
        float rip = noiseT(vW.xz * 0.08 + uTime * 0.01).r * 0.6 + noiseT(vW.xz * 0.17 - uTime * 0.013).r * 0.4;
        vec3 c = mix(vec3(0.05, 0.55, 0.6), vec3(0.3, 1.9, 1.7), smoothstep(0.35, 0.75, rip) * (1.0 - r * 0.6));
        c *= 0.85 + 0.15 * sin(uTime * 0.9 - r * 5.0);
        gl_FragColor = vec4(c, edge * 0.9);
      }`,
  });
  disposables.push(poolMat);

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
        float along = smoothstep(0.0, 0.15, vUv.y) * (1.0 - vUv.y);
        float dust = 0.7 + 0.3 * noiseT(vW.xz * 0.2 + vec2(0.0, uTime * 0.01) + vW.y * 0.05).r;
        float a = facing * along * dust * 0.16;
        gl_FragColor = vec4(uSunColor * vec3(1.0, 0.95, 0.8) * a, 1.0);
      }`,
  });
  disposables.push(shaftMat);

  const rockBase = [new THREE.Color(0x6f7482), new THREE.Color(0x7b7a86), new THREE.Color(0x646b7c)];
  const glowPalette = [new THREE.Color(0x5ff5e0), new THREE.Color(0xffb45a), new THREE.Color(0xb57bff), new THREE.Color(0x9dff8a), new THREE.Color(0xff7ad0), new THREE.Color(0xffb45a)];
  let rs = (world.seed * 31 + 7) >>> 0;
  const rnd = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296);

  const caveBoxes: THREE.Box3[] = [];
  /** Cave rock only matters to the shadow map near the camera (inside, or at a mouth). */
  const shadowCasters: { mesh: THREE.Mesh; box: THREE.Box3 }[] = [];
  const timings: number[][] = [];
  // terrain cells the terrain mesh drops (any corner is a hole) — the mouth patch must fill these
  const removed = (ix: number, iz: number) => {
    if (ix < 0 || iz < 0 || ix >= GRID_RES - 1 || iz >= GRID_RES - 1) return false;
    const i = iz * GRID_RES + ix, H = world.holes;
    return H[i] === 1 || H[i + 1] === 1 || H[i + GRID_RES] === 1 || H[i + GRID_RES + 1] === 1;
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
    if ((ix + iz) & 1) {
      // diagonal b-c
      return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
    }
    // diagonal a-d
    return fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (c - a) * fz + (d - c) * fx;
  };

  function* buildCave(cave: Cave): Generator<void, void> {
    if (cave.nodes.length === 0) return;
    const box = new THREE.Box3();
    for (const n of cave.nodes) {
      box.expandByPoint(new THREE.Vector3(n.x - n.r - 3, n.y - n.r - 3, n.z - n.r - 3));
      box.expandByPoint(new THREE.Vector3(n.x + n.r + 3, n.y + n.r + 3, n.z + n.r + 3));
    }
    // include the dropped terrain cells around each mouth (their full height on cliffs)
    for (const en of cave.entrances) {
      const c0x = cellOf(en.x - 18), c1x = cellOf(en.x + 18), c0z = cellOf(en.z - 18), c1z = cellOf(en.z + 18);
      for (let iz = c0z; iz <= c1z; iz++) for (let ix = c0x; ix <= c1x; ix++) {
        if (!removed(ix, iz)) continue;
        for (const [ox, oz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const gi = (iz + oz) * GRID_RES + ix + ox;
          box.expandByPoint(new THREE.Vector3(-WORLD_HALF + (ix + ox) * CELL, world.height[gi] + 1.5, -WORLD_HALF + (iz + oz) * CELL));
          box.expandByPoint(new THREE.Vector3(-WORLD_HALF + (ix + ox) * CELL, world.height[gi] - 1.5, -WORLD_HALF + (iz + oz) * CELL));
        }
      }
    }
    caveBoxes.push(box);
    const size = box.getSize(new THREE.Vector3());
    const h = Math.max(0.75, Math.cbrt((size.x * size.y * size.z) / 2_500_000));
    const dims: [number, number, number] = [Math.ceil(size.x / h) + 1, Math.ceil(size.y / h) + 1, Math.ceil(size.z / h) + 1];
    // near dropped cells the field is the rock boundary (terrain surface ∪ cave), elsewhere just the cave
    const near = (x: number, z: number) => removedAt(x, z, 1.6);
    // approx. Euclidean distance to the terrain surface (vertical distance / slope factor)
    const terrainDist = (x: number, y: number, z: number) => {
      const hx = heightAt(world, x + 0.5, z) - heightAt(world, x - 0.5, z);
      const hz = heightAt(world, x, z + 0.5) - heightAt(world, x, z - 0.5);
      return (triHeight(x, z) - y) / Math.sqrt(1 + hx * hx + hz * hz);
    };
    const field: CaveSdf = (x, y, z) => {
      const c = sdf(x, y, z);
      return near(x, z) ? Math.min(terrainDist(x, y, z), c) : c;
    };
    const t0 = performance.now();
    const { pos, idx } = yield* surfaceNets(field, tubeGraphSdf([cave]), box.min, dims, h, near);
    const t1 = performance.now();
    if (idx.length === 0) return;

    // classify: cave walls (kept while under the hill) vs terrain patch (kept only inside dropped cells)
    const nv = pos.length / 3;
    const out = new Float32Array(nv);
    const cv = new Float32Array(nv), tv = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      cv[i] = sdf(x, y, z);
      tv[i] = terrainDist(x, y, z);
      out[i] = near(x, z) && tv[i] <= cv[i] ? 1 : 0; // terrain term is the active one in the min()
    }
    const kept: number[] = [];
    const patch: number[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
      const nOut = out[a] + out[b] + out[c];
      const terrainPart = nOut >= 2;
      const inHole = removedAt(cx, cz, 0.05);
      if (terrainPart) {
        // slight overlap into intact cells is invisible (same material, same triangulated surface) and closes pinholes
        if (inHole || removedAt(cx, cz, 0.6)) patch.push(a, b, c);
        continue;
      } else if (nOut === 1 && inHole) {
        patch.push(a, b, c); // junction between patch and cave wall
        continue;
      } else {
        if (tv[a] < -0.6 && tv[b] < -0.6 && tv[c] < -0.6) continue; // cave wall poking out of the hill
        if (!inHole && Math.min(tv[a], tv[b], tv[c]) < -0.05) continue; // in front of intact terrain
        const wall = h * 1.2 + 0.4;
        if ((Math.abs(cv[a]) > wall ? 1 : 0) + (Math.abs(cv[b]) > wall ? 1 : 0) + (Math.abs(cv[c]) > wall ? 1 : 0) >= 2) continue; // seam where the field switches
      }
      kept.push(a, b, c);
    }

    // glow sources: mushroom clusters on floor-ish vertices away from the mouths, and a pool in the biggest chamber
    const glows: Glow[] = [];
    const nrm = new Float32Array(nv * 3);
    const e = 0.4;
    for (let i = 0; i < nv; i++) {
      if ((i & 4095) === 0) yield;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const F = out[i] ? field : sdf;
      let gx = F(x + e, y, z) - F(x - e, y, z), gy = F(x, y + e, z) - F(x, y - e, z), gz = F(x, y, z + e) - F(x, y, z - e);
      const l = Math.hypot(gx, gy, gz) || 1;
      gx /= -l; gy /= -l; gz /= -l; // into the air
      nrm[i * 3] = gx; nrm[i * 3 + 1] = gy; nrm[i * 3 + 2] = gz;
    }
    const nearEntrance = (x: number, y: number, z: number) => {
      let d = 1e9;
      for (const en of cave.entrances) d = Math.min(d, Math.hypot(x - en.x, y - en.y, z - en.z));
      return d;
    };
    const mushrooms = new THREE.Group();
    const mPos: number[] = [], mCol: number[] = [], mNrm: number[] = [], mEmit: number[] = [], mIdx: number[] = [];
    const addShroom = (base: THREE.Vector3, s: number, c: THREE.Color) => {
      const stem = new THREE.CylinderGeometry(0.05 * s, 0.07 * s, 0.35 * s, 5, 1, true);
      const cap = new THREE.SphereGeometry(0.2 * s, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2);
      const put = (g: THREE.BufferGeometry, off: number, color: THREE.Color, emit: number, sy = 1) => {
        const p = g.getAttribute("position"), n = g.getAttribute("normal");
        const b0 = mPos.length / 3;
        for (let i = 0; i < p.count; i++) {
          mPos.push(base.x + p.getX(i), base.y + off + p.getY(i) * sy, base.z + p.getZ(i));
          mNrm.push(n.getX(i), n.getY(i), n.getZ(i));
          mCol.push(color.r, color.g, color.b);
          mEmit.push(emit);
        }
        const ix = g.index!;
        for (let i = 0; i < ix.count; i++) mIdx.push(b0 + ix.getX(i));
        g.dispose();
      };
      put(stem, 0.17 * s, new THREE.Color(0xd8e0e0), 0.15);
      put(cap, 0.33 * s, c, 1, 0.6);
    };
    for (let i = 0; i < nv && glows.length < 22; i += 1 + Math.floor(rnd() * 23)) {
      if (nrm[i * 3 + 1] < 0.75 || out[i]) continue;
      const p = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (nearEntrance(p.x, p.y, p.z) < 10) continue;
      if (glows.some((g) => g.p.distanceTo(p) < 7)) continue;
      const c = glowPalette[Math.floor(rnd() * glowPalette.length)];
      glows.push({ p: p.clone().add(new THREE.Vector3(0, 0.3, 0)), c, r: 4.5 });
      const count = 4 + Math.floor(rnd() * 6);
      for (let m = 0; m < count; m++) {
        const off = new THREE.Vector3((rnd() - 0.5) * 1.4, -0.05, (rnd() - 0.5) * 1.4);
        addShroom(p.clone().add(off), 0.6 + rnd() * 1.1, c);
      }
    }
    // stalactites hanging from the ceiling
    const rockC = new THREE.Color(0x767a86);
    let stal = 0;
    for (let i = 0; i < nv && stal < 60; i += 1 + Math.floor(rnd() * 17)) {
      if (nrm[i * 3 + 1] > -0.85 || out[i]) continue;
      const p = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (nearEntrance(p.x, p.y, p.z) < 6) continue;
      const len = 0.6 + rnd() * 1.8, rad = 0.12 + rnd() * 0.25;
      const g = new THREE.ConeGeometry(rad, len, 6).rotateX(Math.PI).translate(0, -len / 2 + 0.2, 0);
      const pa = g.getAttribute("position"), na = g.getAttribute("normal");
      const b0 = mPos.length / 3;
      for (let k = 0; k < pa.count; k++) {
        mPos.push(p.x + pa.getX(k), p.y + pa.getY(k), p.z + pa.getZ(k));
        mNrm.push(na.getX(k), na.getY(k), na.getZ(k));
        mCol.push(rockC.r, rockC.g, rockC.b);
        mEmit.push(0);
      }
      for (let k = 0; k < g.index!.count; k++) mIdx.push(b0 + g.index!.getX(k));
      g.dispose();
      stal++;
    }
    // pool in the largest node
    let big = cave.nodes[0];
    for (const n of cave.nodes) if (n.r > big.r) big = n;
    {
      // find floor under the node center
      let fy = big.y;
      while (fy > big.y - big.r - 2 && sdf(big.x, fy, big.z) < 0) fy -= 0.2;
      const pr = Math.min(3.2, big.r * 0.45);
      const g = new THREE.CircleGeometry(pr, 24).rotateX(-Math.PI / 2).translate(big.x, fy + 0.25, big.z);
      disposables.push(g);
      const pool = new THREE.Mesh(g, poolMat);
      pool.name = "cave-pool";
      pool.renderOrder = 5;
      group.add(pool);
      glows.push({ p: new THREE.Vector3(big.x, fy + 0.5, big.z), c: new THREE.Color(0x3fc8c0), r: 5 });
    }

    // bake lighting
    const light = new Float32Array(nv * 3), colors = new Float32Array(nv * 3), day = new Float32Array(nv);
    const tmp = new THREE.Color();
    for (let i = 0; i < nv; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      // AO: how open is the space in front of the wall
      const o1 = Math.min(1, Math.max(0, -sdf(x + nx * 1.2, y + ny * 1.2, z + nz * 1.2) / 1.2));
      const o2 = Math.min(1, Math.max(0, -sdf(x + nx * 3, y + ny * 3, z + nz * 3) / 3));
      const ao = 0.2 + 0.8 * Math.pow(o1 * 0.5 + o2 * 0.5, 1.4);
      let lr = 0.05, lg = 0.065, lb = 0.09; // cool ambient
      for (const gl of glows) {
        const dx = gl.p.x - x, dy = gl.p.y - y, dz = gl.p.z - z;
        const d = Math.hypot(dx, dy, dz);
        if (d > gl.r * 3) continue;
        const f = Math.exp(-d / gl.r) * (0.45 + 0.55 * Math.max(0, (dx * nx + dy * ny + dz * nz) / (d || 1))) * 1.6;
        lr += gl.c.r * f; lg += gl.c.g * f; lb += gl.c.b * f;
      }
      const dE = nearEntrance(x, y, z);
      const depth = heightAt(world, x, z) - y;
      const dl = Math.exp(-dE / 9) * 1.2 + (depth < 3 ? (3 - Math.max(0, depth)) / 3 : 0) * 0.7;
      day[i] = Math.min(1.2, dl);
      light[i * 3] = lr * ao; light[i * 3 + 1] = lg * ao; light[i * 3 + 2] = lb * ao;
      tmp.copy(rockBase[Math.floor((Math.sin(x * 0.3) * Math.sin(z * 0.27) * 0.5 + 0.5) * 2.99)]);
      // mossy green near the light of the mouth, darker wet floors
      if (dE < 12) tmp.lerp(new THREE.Color(0x6f8a4a), (1 - dE / 12) * 0.6 * Math.max(0, ny));
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    timings.push([Math.round(t1 - t0), Math.round(performance.now() - t1), nv]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.setAttribute("aLight", new THREE.BufferAttribute(light, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aDay", new THREE.BufferAttribute(day, 1));
    g.setAttribute("aOut", new THREE.BufferAttribute(out, 1));
    g.setIndex(kept);
    g.computeBoundingSphere();
    disposables.push(g);
    // both windings: the terrain material is front-side only and steep patches have unreliable orientation
    const nPatch = patch.length;
    for (let t = 0; t < nPatch; t += 3) patch.push(patch[t], patch[t + 2], patch[t + 1]);
    if (patch.length && terrainMaterial) {
      // cliff face around the mouth, drawn with the terrain's own material so it blends seamlessly
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
      group.add(pm);
    }
    const mesh = new THREE.Mesh(g, rockMat);
    mesh.name = "cave-rock";
    mesh.castShadow = true; // caves shadow the interior from the sun when near
    group.add(mesh);
    g.computeBoundingBox();
    shadowCasters.push({ mesh, box: g.boundingBox!.clone() });

    if (mIdx.length) {
      const mg = new THREE.BufferGeometry();
      mg.setAttribute("position", new THREE.Float32BufferAttribute(mPos, 3));
      mg.setAttribute("normal", new THREE.Float32BufferAttribute(mNrm, 3));
      mg.setAttribute("color", new THREE.Float32BufferAttribute(mCol, 3));
      mg.setAttribute("aEmit", new THREE.Float32BufferAttribute(mEmit, 1));
      mg.setIndex(mIdx);
      mg.computeBoundingSphere();
      disposables.push(mg);
      const mm = new THREE.Mesh(mg, glowMat);
      mm.name = "cave-mushrooms";
      mushrooms.add(mm);
      group.add(mushrooms);
    }

    // light shafts slanting in from each mouth
    for (const en of cave.entrances) {
      const L = 14;
      const geo = new THREE.CylinderGeometry(2.8, 1.6, L, 12, 1, true);
      // uv.y: 1 at the top (mouth) -> 0 deep
      geo.translate(0, -L / 2, 0);
      const dir = new THREE.Vector3(-en.dx, 0, -en.dz).normalize().multiplyScalar(0.9).add(new THREE.Vector3(0, -0.55, 0)).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      const shaft = new THREE.Mesh(geo, shaftMat);
      shaft.quaternion.copy(q);
      shaft.position.set(en.x + en.dx * 1.5, en.y + 1.0, en.z + en.dz * 1.5);
      shaft.renderOrder = 6;
      shaft.name = "cave-shaft";
      disposables.push(geo);
      group.add(shaft);
    }
    }
  const jobs = world.caves.map((c) => buildCave(c));
  /** Advance cave meshing; returns true when all caves are built. */
  function pump(budgetMs: number): boolean {
    const t = performance.now();
    while (jobs.length) {
      if (jobs[0].next().done) jobs.shift();
      if (performance.now() - t > budgetMs) break;
    }
    return jobs.length === 0;
  }

  let factor = 0;
  (group.userData as { timings?: number[][] }).timings = timings;
  return {
    group,
    /** Returns 0..1: how deep inside a cave the camera is. */
    /** Build every remaining cave now (blocking). */
    finish() { pump(Infinity); },
    /** Mesh for up to ms (loading screens). */
    step(ms: number) { pump(ms); },
    get pending() { return jobs.length > 0; },
    get left() { return jobs.length; },
    update(camera: THREE.Camera, dt: number) {
      if (jobs.length) pump(4);
      const p = camera.position;
      for (const c of shadowCasters) c.mesh.castShadow = c.box.distanceToPoint(p) < 45;
      let target = 0;
      if (caveBoxes.some((b) => b.containsPoint(p))) {
        const d = sdf(p.x, p.y, p.z);
        const below = heightAt(world, p.x, p.z) - p.y;
        if (d < 0.5) target = THREE.MathUtils.smoothstep(below, 1, 6);
      }
      factor += (target - factor) * Math.min(1, dt * 3);
      return factor;
    },
    dispose() { disposables.forEach((d) => d.dispose()); },
  };
}
