// Blob character geometry + skeleton. Everything (body, face, fins, limbs and
// the marker) is baked into ONE skinned geometry → one draw call per blob.
// Model space: feet at origin, +Y up, +Z forward, +X = the blob's LEFT.
import * as THREE from "three";
import { MeshBuilder, mat, smoothstep } from "./builder";
import { addMarker } from "./marker";

export const B = {
  root: 0, hips: 1, chest: 2, head: 3,
  eyeL: 4, eyeR: 5, pupilL: 6, pupilR: 7, lidL: 8, lidR: 9,
  mouthO: 10, smile: 11, crest: 12, finL: 13, finR: 14, dorsal: 15, tail: 16,
  armL: 17, armR: 18, handL: 19, handR: 20, legL: 21, legR: 22, footL: 23, footR: 24,
  gun: 25,
} as const;
const BONE_COUNT = 26;

type V3 = [number, number, number];
/** Bind-pose model-space positions + parent of each bone. */
const BIND: { pos: V3; parent: number }[] = [];
const def = (i: number, pos: V3, parent: number) => (BIND[i] = { pos, parent });
def(B.root, [0, 0, 0], -1);
def(B.hips, [0, 0.55, 0], B.root);
def(B.chest, [0, 0.9, 0], B.hips);
def(B.head, [0, 1.12, 0], B.chest);
export const EYE_POS: V3 = [0.13, 1.44, 0.262];
def(B.eyeL, [EYE_POS[0], EYE_POS[1], EYE_POS[2]], B.head);
def(B.eyeR, [-EYE_POS[0], EYE_POS[1], EYE_POS[2]], B.head);
def(B.pupilL, [EYE_POS[0], EYE_POS[1], EYE_POS[2]], B.eyeL);
def(B.pupilR, [-EYE_POS[0], EYE_POS[1], EYE_POS[2]], B.eyeR);
def(B.lidL, [EYE_POS[0], EYE_POS[1], EYE_POS[2]], B.eyeL);
def(B.lidR, [-EYE_POS[0], EYE_POS[1], EYE_POS[2]], B.eyeR);
def(B.mouthO, [0, 1.275, 0.325], B.head);
def(B.smile, [0, 1.285, 0.328], B.head);
def(B.crest, [0, 1.68, -0.02], B.head);
def(B.finL, [0.31, 1.42, -0.1], B.head);
def(B.finR, [-0.31, 1.42, -0.1], B.head);
def(B.dorsal, [0, 0.98, -0.26], B.chest);
def(B.tail, [0, 0.45, -0.24], B.hips);
export const SHOULDER_L: V3 = [0.25, 1.0, 0.0];
export const HAND_REST_L: V3 = [0.37, 0.72, 0.07];
def(B.armL, SHOULDER_L, B.chest);
def(B.armR, [-SHOULDER_L[0], SHOULDER_L[1], SHOULDER_L[2]], B.chest);
def(B.handL, HAND_REST_L, B.chest);
def(B.handR, [-HAND_REST_L[0], HAND_REST_L[1], HAND_REST_L[2]], B.chest);
export const HIP_L: V3 = [0.13, 0.42, 0.0];
export const FOOT_REST_L: V3 = [0.15, 0.08, 0.02];
def(B.legL, HIP_L, B.hips);
def(B.legR, [-HIP_L[0], HIP_L[1], HIP_L[2]], B.hips);
def(B.footL, FOOT_REST_L, B.root);
def(B.footR, [-FOOT_REST_L[0], FOOT_REST_L[1], FOOT_REST_L[2]], B.root);
export const GUN_BIND: V3 = [-0.07, 0.9, 0.36];
def(B.gun, GUN_BIND, B.chest);

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
export const ARM_REST_LEN = v3(HAND_REST_L).sub(v3(SHOULDER_L)).length();
export const LEG_REST_LEN = v3(FOOT_REST_L).sub(v3(HIP_L)).length();

// --- body profile -------------------------------------------------------------
// (radius, height) — a bean body that pinches gently into a big round head.
const PROFILE: [number, number][] = [
  [0.0, 0.3], [0.15, 0.32], [0.25, 0.38], [0.3, 0.48], [0.315, 0.62], [0.3, 0.78],
  [0.272, 0.92], [0.25, 1.02], [0.255, 1.08], [0.3, 1.16], [0.35, 1.28], [0.366, 1.4],
  [0.352, 1.52], [0.305, 1.62], [0.205, 1.7], [0.09, 1.752], [0.0, 1.765],
];

/** Weld normals of vertices that share a position (fixes lathe/sphere seams). */
function weldNormals(g: THREE.BufferGeometry): void {
  const P = g.getAttribute("position");
  const N = g.getAttribute("normal");
  const map = new Map<string, number[]>();
  for (let i = 0; i < P.count; i++) {
    const k = `${Math.round(P.getX(i) * 1e4)},${Math.round(P.getY(i) * 1e4)},${Math.round(P.getZ(i) * 1e4)}`;
    const l = map.get(k);
    if (l) l.push(i);
    else map.set(k, [i]);
  }
  const n = new THREE.Vector3();
  for (const l of map.values()) {
    if (l.length < 2) continue;
    n.set(0, 0, 0);
    for (const i of l) n.x += N.getX(i), n.y += N.getY(i), n.z += N.getZ(i);
    n.normalize();
    for (const i of l) N.setXYZ(i, n.x, n.y, n.z);
  }
}

function bodyGeometry(): THREE.BufferGeometry {
  const curve = new THREE.SplineCurve(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)));
  const pts = curve.getPoints(18);
  pts[0].x = 0;
  pts[pts.length - 1].x = 0;
  const g = new THREE.LatheGeometry(pts, 16);
  const P = g.getAttribute("position");
  for (let i = 0; i < P.count; i++) {
    let x = P.getX(i);
    const y = P.getY(i);
    let z = P.getZ(i);
    const headness = smoothstep(1.05, 1.2, y);
    z *= 0.9 + 0.05 * headness;
    x *= 1.0 + 0.02 * headness;
    // belly pushes forward a touch, face flattens very slightly
    if (z > 0) z += 0.035 * smoothstep(0.35, 0.6, y) * (1 - smoothstep(0.85, 1.05, y)) * (z / 0.3);
    // bum pushes back a little
    if (z < 0) z -= 0.02 * smoothstep(0.35, 0.55, y) * (1 - smoothstep(0.6, 0.8, y)) * (-z / 0.3);
    P.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  weldNormals(g);
  return g;
}

/** Scalloped fin outline (u along, v up), `lobes` rounded peaks. */
function finShape(len: number, height: number, lobes: number, baseDrop = 0.05): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, -baseDrop);
  s.lineTo(0, height * 0.45);
  const step = len / lobes;
  for (let i = 0; i < lobes; i++) {
    const u0 = i * step;
    const h = height * (1 - 0.22 * Math.abs(i - (lobes - 1) * 0.3) / lobes);
    const dip = i === lobes - 1 ? 0 : h * 0.5;
    // soft rounded humps, leaning back a little
    s.bezierCurveTo(u0 + step * 0.05, h * 1.15, u0 + step * 0.75, h * 1.1, u0 + step, dip);
  }
  s.lineTo(len, -baseDrop);
  s.lineTo(0, -baseDrop);
  return s;
}

/** Matrix whose local X runs along u and local Y along (v orthogonalized). */
function basis(o: V3, u: V3, v: V3): THREE.Matrix4 {
  const x = v3(u).normalize();
  const y = v3(v);
  y.addScaledVector(x, -y.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(o[0], o[1], o[2]);
}

function extrudeFin(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: depth * 0.4, bevelSize: depth * 0.35, bevelSegments: 1, curveSegments: 3,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

export interface BlobRig {
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  /** Rest-space points on the body surface, for placing paint splats. */
  splatPoints: THREE.Vector3[];
  /** Local rest quaternion of arm/leg bones (Y aligned to the limb). */
  restQuat: THREE.Quaternion[];
}

const SKIN_BODY: [number, number, number, number] = [1, 0, 0, 1];
const SKIN_CREST: [number, number, number, number] = [0, 1, 0, 0.3];
const FIXED: [number, number, number, number] = [0, 0, 0, 0];

export function buildBlobGeometry(color: THREE.ColorRepresentation): { geo: THREE.BufferGeometry; splatPoints: THREE.Vector3[] } {
  const b = new MeshBuilder({ skinned: true, parts: true });

  // --- body: blended hips → chest → head ------------------------------------
  const body = bodyGeometry();
  const splatPoints: THREE.Vector3[] = [];
  const bp = body.getAttribute("position");
  for (let i = 0; i < bp.count; i += 3) {
    const y = bp.getY(i);
    if (y > 0.42 && y < 1.62) splatPoints.push(new THREE.Vector3(bp.getX(i), y, bp.getZ(i)));
  }
  b.add(body, {
    color: 0xffffff,
    skin: (p, w) => {
      const y = p.y;
      if (y < 0.64) { w[0] = B.hips; w[1] = 1; w[2] = B.chest; w[3] = 0; }
      else if (y < 0.84) { const t = smoothstep(0.64, 0.84, y); w[0] = B.hips; w[1] = 1 - t; w[2] = B.chest; w[3] = t; }
      else if (y < 1.07) { w[0] = B.chest; w[1] = 1; w[2] = B.head; w[3] = 0; }
      else if (y < 1.2) { const t = smoothstep(1.07, 1.2, y); w[0] = B.chest; w[1] = 1 - t; w[2] = B.head; w[3] = t; }
      else { w[0] = B.head; w[1] = 1; w[2] = B.chest; w[3] = 0; }
    },
    part: (p, n) => {
      const belly = smoothstep(0.25, 0.75, n.z) * smoothstep(0.42, 0.55, p.y) * (1 - smoothstep(0.9, 1.05, p.y));
      const muzzle = smoothstep(0.6, 0.9, n.z) * smoothstep(1.2, 1.26, p.y) * (1 - smoothstep(1.34, 1.4, p.y)) * 0.6;
      return [1, 0, Math.max(belly, muzzle), 1];
    },
  });
  body.dispose();

  // --- eyes: sclera, iris, pupil, highlights, lids ----------------------------
  for (const side of [1, -1]) {
    const eye = side > 0 ? B.eyeL : B.eyeR;
    const pupil = side > 0 ? B.pupilL : B.pupilR;
    const lid = side > 0 ? B.lidL : B.lidR;
    const ex = EYE_POS[0] * side, ey = EYE_POS[1], ez = EYE_POS[2];
    const sclera = new THREE.SphereGeometry(0.105, 11, 7);
    b.add(sclera, { color: 0xfffcf4, bone: eye, part: FIXED, matrix: mat(ex, ey, ez, 0, 0, 0, 1, 1.06, 1) });
    sclera.dispose();
    const disc = new THREE.SphereGeometry(1, 9, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    // iris + pupil sit on the front of the eyeball; they rotate around the eye center
    b.add(disc, { color: 0x4b2c1f, bone: pupil, part: FIXED, matrix: mat(ex, ey, ez).multiply(mat(0, 0, 0.083, Math.PI / 2, 0, 0, 0.07, 0.03, 0.07)) });
    b.add(disc, { color: 0x140d0c, bone: pupil, part: FIXED, matrix: mat(ex, ey, ez).multiply(mat(0, 0, 0.095, Math.PI / 2, 0, 0, 0.046, 0.03, 0.046)) });
    disc.dispose();
    const hl = new THREE.SphereGeometry(1, 6, 4);
    b.add(hl, { color: 0xffffff, bone: pupil, part: FIXED, matrix: mat(ex + 0.024 * side, ey + 0.028, ez + 0.118, 0, 0, 0, 0.022, 0.022, 0.012) });
    b.add(hl, { color: 0xffffff, bone: pupil, part: FIXED, matrix: mat(ex - 0.022 * side, ey - 0.024, ez + 0.116, 0, 0, 0, 0.011, 0.011, 0.007) });
    hl.dispose();
    const lidG = new THREE.SphereGeometry(0.113, 11, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    b.add(lidG, { color: 0xffffff, bone: lid, part: [1, 0, 0, 0], matrix: mat(ex, ey, ez, 0, 0, 0, 1, 1.06, 1) });
    lidG.dispose();
  }

  // --- mouth: a smile arc + an "O" that pops open for surprise / effort -------
  const smile = new THREE.TorusGeometry(0.048, 0.012, 4, 10, Math.PI * 0.75);
  b.add(smile, { color: 0x4a1f1c, bone: B.smile, part: FIXED, matrix: mat(0, 1.305, 0.33, 0.29, 0, -Math.PI / 2 - Math.PI * 0.375) });
  smile.dispose();
  const oMouth = new THREE.SphereGeometry(0.05, 8, 5);
  b.add(oMouth, { color: 0x6e2226, bone: B.mouthO, part: FIXED, matrix: mat(0, 1.275, 0.318, 0.29, 0, 0, 1, 1, 0.45) });
  oMouth.dispose();
  const tongue = new THREE.SphereGeometry(0.028, 6, 4);
  b.add(tongue, { color: 0xe86a74, bone: B.mouthO, part: FIXED, matrix: mat(0, 1.256, 0.33, 0.29, 0, 0, 1, 0.6, 0.5) });
  tongue.dispose();

  // --- Luca crest, cheek frills, dorsal fin, (hidden) tail --------------------
  const crest = extrudeFin(finShape(0.5, 0.22, 3), 0.06);
  // shape u runs front→back along -Z, fin sits on the head top, tilted to follow the skull
  b.add(crest, { bone: B.crest, part: SKIN_CREST, matrix: basis([0, 1.7, 0.16], [0, -0.35, -1], [0, 1, -0.3]) });
  crest.dispose();
  for (const side of [1, -1]) {
    const fin = extrudeFin(finShape(0.24, 0.16, 3, 0.04), 0.026);
    b.add(fin, {
      bone: side > 0 ? B.finL : B.finR, part: SKIN_CREST,
      matrix: basis([0.27 * side, 1.46, -0.06], [side, 0.45, -0.3], [-0.25 * side, 1, -0.25]),
    });
    fin.dispose();
  }
  const dorsal = extrudeFin(finShape(0.4, 0.13, 3), 0.05);
  b.add(dorsal, { bone: B.dorsal, part: SKIN_CREST, matrix: basis([0, 1.1, -0.2], [0, -1, -0.12], [0, 0.1, -1]) });
  dorsal.dispose();
  const tailG = new THREE.ConeGeometry(0.11, 0.42, 8, 2);
  const tailDir = new THREE.Vector3(0, -0.35, -1).normalize();
  b.add(tailG, {
    bone: B.tail, part: SKIN_BODY,
    matrix: new THREE.Matrix4().compose(new THREE.Vector3(0, 0.42, -0.26).addScaledVector(tailDir, 0.2), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tailDir), new THREE.Vector3(1, 1, 1)),
  });
  tailG.dispose();
  const tailFin = extrudeFin(finShape(0.2, 0.12, 3, 0.02), 0.025);
  b.add(tailFin, { bone: B.tail, part: SKIN_CREST, matrix: basis([0, 0.33, -0.5], [0, -0.35, -1], [0, 1, 0]) });
  tailFin.dispose();

  // --- arms (noodle tubes) + mitten hands -------------------------------------
  for (const side of [1, -1]) {
    const sh = new THREE.Vector3(SHOULDER_L[0] * side, SHOULDER_L[1], SHOULDER_L[2]);
    const hd = new THREE.Vector3(HAND_REST_L[0] * side, HAND_REST_L[1], HAND_REST_L[2]);
    const dir = hd.clone().sub(sh);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const arm = new THREE.CylinderGeometry(0.068, 0.072, len, 8, 3, true);
    const m = new THREE.Matrix4().compose(sh.clone().addScaledVector(dir, 0.5), q, new THREE.Vector3(1, 1, 1));
    b.add(arm, { bone: side > 0 ? B.armL : B.armR, part: SKIN_BODY, matrix: m });
    arm.dispose();
    const hand = new THREE.SphereGeometry(0.088, 8, 6);
    b.add(hand, { bone: side > 0 ? B.handL : B.handR, part: SKIN_BODY, matrix: mat(hd.x, hd.y, hd.z, 0, 0, 0, 1, 0.9, 1.05) });
    hand.dispose();
    const thumb = new THREE.SphereGeometry(0.036, 6, 4);
    b.add(thumb, { bone: side > 0 ? B.handL : B.handR, part: SKIN_BODY, matrix: mat(hd.x - 0.05 * side, hd.y + 0.03, hd.z + 0.06) });
    thumb.dispose();
  }

  // --- legs + round feet -----------------------------------------------------
  for (const side of [1, -1]) {
    const hp = new THREE.Vector3(HIP_L[0] * side, HIP_L[1], HIP_L[2]);
    const ft = new THREE.Vector3(FOOT_REST_L[0] * side, FOOT_REST_L[1], FOOT_REST_L[2]);
    const dir = ft.clone().sub(hp);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const leg = new THREE.CylinderGeometry(0.09, 0.08, len, 8, 2, true);
    const m = new THREE.Matrix4().compose(hp.clone().addScaledVector(dir, 0.5), q, new THREE.Vector3(1, 1, 1));
    b.add(leg, { bone: side > 0 ? B.legL : B.legR, part: SKIN_BODY, matrix: m });
    leg.dispose();
    const foot = new THREE.SphereGeometry(0.1, 9, 5);
    b.add(foot, {
      bone: side > 0 ? B.footL : B.footR,
      part: [1, 0, 0.35, 1],
      matrix: mat(ft.x + 0.01 * side, ft.y - 0.015, ft.z + 0.05, 0, 0.12 * side, 0, 0.95, 0.62, 1.35),
    });
    foot.dispose();
  }

  // --- the marker, rigid on the gun bone --------------------------------------
  addMarker(b, color, { bone: B.gun, part: FIXED }, mat(GUN_BIND[0], GUN_BIND[1], GUN_BIND[2]));

  return { geo: b.build(), splatPoints };
}

export function buildRig(geo: THREE.BufferGeometry, material: THREE.Material): BlobRig {
  const bones: THREE.Bone[] = [];
  const restQuat: THREE.Quaternion[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const bone = new THREE.Bone();
    bone.name = Object.keys(B).find((k) => (B as Record<string, number>)[k] === i) ?? `b${i}`;
    bones.push(bone);
  }
  for (let i = 0; i < BONE_COUNT; i++) {
    const { pos, parent } = BIND[i];
    const bone = bones[i];
    if (parent >= 0) {
      const pp = BIND[parent].pos;
      bone.position.set(pos[0] - pp[0], pos[1] - pp[1], pos[2] - pp[2]);
      bones[parent].add(bone);
    } else bone.position.set(pos[0], pos[1], pos[2]);
    restQuat.push(new THREE.Quaternion());
  }
  // limb bones: local +Y runs down the limb so stretching is a simple scale.y
  const limb = (i: number, from: V3, to: V3) => {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v3(to).sub(v3(from)).normalize());
    bones[i].quaternion.copy(q);
    restQuat[i].copy(q);
  };
  const mirror = (a: V3): V3 => [-a[0], a[1], a[2]];
  limb(B.armL, SHOULDER_L, HAND_REST_L);
  limb(B.armR, mirror(SHOULDER_L), mirror(HAND_REST_L));
  limb(B.legL, HIP_L, FOOT_REST_L);
  limb(B.legR, mirror(HIP_L), mirror(FOOT_REST_L));
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.add(bones[B.root]);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.9);
  return { mesh, bones, splatPoints: [], restQuat };
}
