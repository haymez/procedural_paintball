// Stylized cumulus: a handful of puffy clusters of soft blobs far away, lit
// with a warm top / lavender-blue underside and a bright rim when backlit.
// The sky gradient itself is drawn analytically in the composite pass.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ENV_PARS } from "./glsl";

export interface Clouds {
  mesh: THREE.Mesh;
  update(camera: THREE.Camera, time: number): void;
  dispose(): void;
}

export function createClouds(seed: number, env: Record<string, THREE.IUniform>, count = 11): Clouds {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const parts: THREE.BufferGeometry[] = [];
  const blob = new THREE.IcosahedronGeometry(1, 3);
  for (let c = 0; c < count; c++) {
    const ang = rnd() * Math.PI * 2;
    const dist = 1700 + rnd() * 1700;
    const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
    const baseY = 260 + rnd() * 380 + dist * 0.04;
    const size = 70 + rnd() * 110;
    const nb = 5 + Math.floor(rnd() * 7);
    const along = new THREE.Vector2(Math.cos(ang + Math.PI / 2), Math.sin(ang + Math.PI / 2));
    for (let b = 0; b < nb; b++) {
      const t = (b / (nb - 1) - 0.5) * 2;
      const r = size * (0.45 + 0.55 * (1 - Math.abs(t)) * (0.7 + rnd() * 0.5));
      const g = blob.clone();
      const off = t * size * 1.5 + (rnd() - 0.5) * size * 0.4;
      const px = cx + along.x * off + (rnd() - 0.5) * size * 0.5;
      const pz = cz + along.y * off + (rnd() - 0.5) * size * 0.5;
      const py = baseY + r * (0.35 + rnd() * 0.35);
      const pos = g.getAttribute("position") as THREE.BufferAttribute;
      const nor = g.getAttribute("normal") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const wob = 1 + 0.06 * Math.sin(x * 5 + b) * Math.sin(z * 4 + c);
        let wy = py + y * r * 0.85 * wob;
        let ny = nor.getY(i);
        if (wy < baseY) { wy = baseY + (wy - baseY) * 0.08; ny = -1; } // flat base
        pos.setXYZ(i, px + x * r * wob, wy, pz + z * r * 1.0 * wob);
        nor.setY(i, ny);
      }
      nor.needsUpdate = true;
      // store cluster base height in uv.x for the underside gradient
      const uv = g.getAttribute("uv") as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, baseY, size);
      parts.push(g);
    }
  }
  const geo = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  blob.dispose();
  geo.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW; varying vec2 vBase;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vBase = uv;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${ENV_PARS}
      varying vec3 vN; varying vec3 vW; varying vec2 vBase;
      void main() {
        vec3 n = normalize(vN);
        vec3 v = normalize(cameraPosition - vW);
        float sunF = dot(n, uSunDir) * 0.5 + 0.5;
        float up = n.y * 0.5 + 0.5;
        float h = clamp((vW.y - vBase.x) / (vBase.y * 1.4), 0.0, 1.0);
        vec3 shade = mix(vec3(0.62, 0.68, 0.86), vec3(0.86, 0.86, 0.95), h);
        vec3 lit = vec3(1.08, 1.04, 0.98) * (0.85 + 0.35 * uSunColor);
        float k = smoothstep(0.35, 0.8, sunF * 0.55 + up * 0.35 + h * 0.3);
        vec3 col = mix(shade, lit, k);
        col = mix(col, uSkyHorizon, 0.12);
        float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        float back = pow(max(dot(-v, uSunDir), 0.0), 3.0);
        col += uSunGlow * rim * (0.25 + back * 0.9);
        gl_FragColor = vec4(col * 1.05, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "clouds";
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return {
    mesh,
    update(camera, time) {
      // follow the camera horizontally (infinitely far), drift slowly
      mesh.position.set(camera.position.x, 0, camera.position.z);
      mesh.rotation.y = time * 0.0015;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
