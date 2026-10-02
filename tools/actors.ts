// Actor showcase: a sunny little beach stage with blobs in every mode,
// vehicles, pickups, a zipline and a paintball duel.
//
// Query params:
//   focus=blob&mode=run   close-up of a hero blob holding a mode
//   focus=lineup|water|jetski|speedboat|gyro|jetski-parked|speedboat-parked|gyro-parked|vespa|zipline|pickups|duel|stress
//   coats=2 wet=0.8 aim=0.3 fire=1   hero state
//   stress=20 [solo=1]    N blobs running in a ring (solo hides the rest)
//   cycle=1               lineup blobs cycle through modes
//   tags=0 shadows=0 pause=1 t=seconds (advance sim before ready)
//   cam=x,y,z,tx,ty,tz
// window.__debug: focus(what, mode?), camera(x,y,z,tx,ty,tz), hero(patch),
//   pause(bool), step(seconds), stress(n, solo?), tags(bool)
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  createBlob, createPaintFx, createJetski, createSpeedboat, createGyrocopter, createVespa, createZipline, createPickup, createNameTag,
  BLOB_COLORS, BLOB_MODES, SWIM_WATERLINE,
  type BlobActor, type BlobState, type BlobMode, type NameTag, type VehicleActor, type PickupActor,
} from "../client/src/render/actors";
import { PALETTE, makeToonMaterial } from "../client/src/render/style";
import { PickupKind } from "../shared/world/types";

const qs = new URLSearchParams(location.search);
const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = qs.get("shadows") !== "0";
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PALETTE.skyHorizon, 60, 160);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 400);
camera.position.set(0, 7, 20);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- stage
const world = new THREE.Group();
scene.add(world);
const hemi = new THREE.HemisphereLight(PALETTE.skyHorizon, PALETTE.sand, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(PALETTE.sun, 2.4);
sun.position.set(25, 40, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 120;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(300, 24, 12),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color(PALETTE.skyTop) }, hor: { value: new THREE.Color(PALETTE.skyHorizon) } },
    vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 top; uniform vec3 hor; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y, 0.0, 1.0); gl_FragColor = vec4(mix(hor, top, pow(h, 0.6)), 1.0); \n#include <colorspace_fragment>\n }",
  }),
);
scene.add(sky);

/** Beach terrain: a flat sandy shelf that drops into a lagoon toward -Z. */
function groundH(x: number, z: number): number {
  const t = THREE.MathUtils.smoothstep(z, -9, -3.5);
  let h = -2.6 + t * 2.9;
  // dive platform / dock is a separate mesh; small dunes
  h += 0.08 * Math.sin(x * 0.3) * Math.sin(z * 0.25) * t;
  return h;
}
{
  const g = new THREE.PlaneGeometry(160, 160, 120, 120);
  g.rotateX(-Math.PI / 2);
  const P = g.getAttribute("position");
  const cols: number[] = [];
  const sand = new THREE.Color(PALETTE.sand), wet = new THREE.Color(PALETTE.wetSand), deep = new THREE.Color(0xc9a978);
  const c = new THREE.Color();
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), z = P.getZ(i);
    const h = groundH(x, z);
    P.setY(i, h);
    if (h < -0.4) c.copy(deep);
    else c.copy(wet).lerp(sand, THREE.MathUtils.smoothstep(h, -0.05, 0.28));
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, makeToonMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  world.add(ground);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 76).rotateX(-Math.PI / 2).translate(0, 0, -41),
    makeToonMaterial({ color: PALETTE.shallows, transparent: true, opacity: 0.62 }),
  );
  water.renderOrder = 1;
  (water.material as THREE.Material).depthWrite = false;
  world.add(water);
  // foam line
  const foam = new THREE.Mesh(new THREE.PlaneGeometry(160, 0.5).rotateX(-Math.PI / 2).translate(0, 0.02, -3.75), makeToonMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
  world.add(foam);
}
const wood = makeToonMaterial({ color: PALETTE.wood });
const woodDark = makeToonMaterial({ color: PALETTE.woodDark });
function box(x: number, y: number, z: number, w: number, h: number, d: number, m = wood): THREE.Mesh {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  b.castShadow = true;
  b.receiveShadow = true;
  world.add(b);
  return b;
}
// dive dock
box(3, 1.55, -5.8, 1.6, 0.15, 3.2);
for (const dx of [-0.7, 0.7]) for (const dz of [-7.2, -4.4]) box(3 + dx, 0.3, dz, 0.15, 2.8, 0.15, woodDark);
// mantle block
const MANTLE = { x: 2.5, z: 3.6, h: 1.35 };
box(MANTLE.x, 0.3 + MANTLE.h / 2, MANTLE.z, 1.6, MANTLE.h, 1.0, makeToonMaterial({ color: PALETTE.stuccoWarm[1] }));
// zipline towers
const ZA = new THREE.Vector3(-17, 8.2, 10), ZB = new THREE.Vector3(-5, 3.2, 17);
box(ZA.x, 4.2, ZA.z, 0.4, 8.2, 0.4, woodDark);
box(ZA.x, 7.6, ZA.z - 0.6, 1.8, 0.15, 1.8);
box(ZB.x, 1.75, ZB.z, 0.35, 3.3, 0.35, woodDark);

// ---------------------------------------------------------------- fx
const fx = createPaintFx(scene, { ground: groundH });

// ---------------------------------------------------------------- helpers
const G = 9.81;
type DState = BlobState & { pos: THREE.Vector3; vel: THREE.Vector3 };
interface Demo {
  name: string;
  blob: BlobActor;
  st: DState;
  tag: NameTag;
  drive: (d: Demo, dt: number, t: number) => void;
  mem: Record<string, number>;
  /** optional; used by the cycle lineup */
  home?: THREE.Vector3;
  group: THREE.Group;
}
const demos: Demo[] = [];
let colorI = 0;
let showTags = qs.get("tags") !== "0";
function mkState(x: number, y: number, z: number, yaw = 0): DState {
  return {
    pos: new THREE.Vector3(x, y, z), yaw, aimPitch: 0, vel: new THREE.Vector3(), grounded: true, mode: "idle",
    firing: false, coats: [], wetness: 0, breath: 1,
  };
}
function addDemo(name: string, group: THREE.Group, st: DState, drive: Demo["drive"], color?: number): Demo {
  const c = color ?? BLOB_COLORS[colorI++ % BLOB_COLORS.length];
  const blob = createBlob({ color: c, fx });
  group.add(blob.object);
  const tag = createNameTag(name, c);
  scene.add(tag.sprite);
  const d: Demo = { name, blob, st, tag, drive, mem: {}, group, home: new THREE.Vector3(st.pos.x, st.pos.y, st.pos.z) };
  demos.push(d);
  return d;
}
const lineup = new THREE.Group();
world.add(lineup);
const fwd = (yaw: number, s: number, out: THREE.Vector3) => out.set(Math.sin(yaw) * s, 0, Math.cos(yaw) * s);

// ---------------------------------------------------------------- lineup (beach)
const LZ = 1.5;
const ground0 = groundH(0, LZ);
const occasionalFire = (d: Demo, t: number, every: number) => {
  d.st.firing = false;
  if (Math.floor(t / every) !== d.mem.fireSlot) {
    d.mem.fireSlot = Math.floor(t / every);
    d.blob.fire();
    const m = d.blob.getMuzzle(new THREE.Vector3(), new THREE.Vector3());
    const dir = new THREE.Vector3();
    d.blob.getMuzzle(m, dir);
    fx.muzzle(m, dir, d.blob.color);
  }
};
addDemo("idle", lineup, mkState(-11, ground0, LZ), (d, _dt, t) => {
  d.st.aimPitch = Math.sin(t * 0.4) * 0.25;
});
addDemo("run", lineup, mkState(-8.5, ground0, LZ), (d, _dt, t) => {
  d.st.mode = "run";
  fwd(d.st.yaw, 4.8, d.st.vel as THREE.Vector3);
  occasionalFire(d, t, 1.3);
});
addDemo("sprint", lineup, mkState(-6, ground0, LZ), (d) => {
  d.st.mode = "sprint";
  fwd(d.st.yaw, 8, d.st.vel as THREE.Vector3);
});
addDemo("jump", lineup, mkState(-3.5, ground0, LZ), (d, dt) => {
  const s = d.st, m = d.mem;
  m.vy ??= 0; m.wait ??= 0.5;
  if (s.grounded) {
    m.wait -= dt;
    s.mode = "idle";
    if (m.wait <= 0) { m.vy = 6.2; s.grounded = false; s.mode = "jump"; }
  } else {
    m.vy -= G * dt;
    s.pos.y += m.vy * dt;
    if (s.pos.y <= ground0) { s.pos.y = ground0; s.grounded = true; m.wait = 0.7; m.vy = 0; s.mode = "idle"; }
  }
  s.vel.y = m.vy;
});
addDemo("slide", lineup, mkState(-1, ground0, LZ), (d) => {
  d.st.mode = "slide";
  fwd(d.st.yaw, 6, d.st.vel as THREE.Vector3);
});
addDemo("mantle", lineup, mkState(MANTLE.x, ground0, MANTLE.z - 0.95), (d, dt) => {
  const s = d.st, m = d.mem;
  m.t = (m.t ?? 0) + dt;
  const cyc = m.t % 3.2;
  const top = ground0 + MANTLE.h;
  const edgeZ = MANTLE.z - 0.5;
  if (cyc < 0.8) { s.mode = "idle"; s.pos.set(MANTLE.x, ground0, edgeZ - 0.45); s.grips = null; s.vel.set(0, 0, 0); s.grounded = true; }
  else if (cyc < 1.35) {
    const p = (cyc - 0.8) / 0.55;
    s.mode = "mantle";
    s.grounded = false;
    const e = p * p * (3 - 2 * p);
    s.pos.set(MANTLE.x, ground0 + e * MANTLE.h, edgeZ - 0.45 + e * 0.75);
    s.vel.set(0, MANTLE.h / 0.55, 0.75 / 0.55);
    s.grips = { l: { x: MANTLE.x + 0.24, y: top + 0.05, z: edgeZ + 0.12 }, r: { x: MANTLE.x - 0.24, y: top + 0.05, z: edgeZ + 0.12 } };
  } else { s.mode = "idle"; s.grips = null; s.grounded = true; s.vel.set(0, 0, 0); s.pos.set(MANTLE.x, top, edgeZ + 0.3); }
});
addDemo("fall", lineup, mkState(5, ground0 + 7, LZ), (d, dt) => {
  const s = d.st, m = d.mem;
  m.vy ??= 0; m.wait ??= 0;
  if (s.grounded) {
    m.wait -= dt;
    s.mode = "idle";
    if (m.wait <= 0) { s.pos.y = ground0 + 8; s.grounded = false; m.vy = 0; s.mode = "fall"; }
  } else {
    m.vy -= G * dt;
    s.pos.y += m.vy * dt;
    s.mode = "fall";
    if (s.pos.y <= ground0) { s.pos.y = ground0; s.grounded = true; m.wait = 1.2; m.vy = 0; }
  }
  s.vel.y = m.vy;
});
const elimCycle = (d: Demo, dt: number) => {
  const s = d.st, m = d.mem;
  m.t = (m.t ?? 0) + dt;
  const c = m.t % 6;
  const hitAt = [1.2, 1.8, 2.4];
  const n = hitAt.filter((h) => c >= h).length;
  if (n > (s.coats as number[]).length && n <= 3) {
    const col = BLOB_COLORS[(Math.floor(m.t / 6) * 3 + n + 5) % BLOB_COLORS.length];
    (s.coats as number[]).push(col);
    const p = d.blob.object.position;
    fx.burst({ x: p.x, y: p.y + 1.0, z: p.z + 0.3 }, { x: 0, y: 0.3, z: 1 }, col, 0.8);
  }
  if (c < 0.1) { (s.coats as number[]).length = 0; s.mode = "spawn"; }
  else if (c < 0.9) s.mode = "spawn";
  else if (c < 2.5) s.mode = "idle";
  else s.mode = "eliminated";
};
addDemo("eliminated", lineup, mkState(7.5, ground0, LZ), elimCycle);
addDemo("wet", lineup, mkState(10, ground0, LZ), (d, _dt, t) => {
  d.st.wetness = Math.max(0, Math.min(1, 0.5 + Math.sin(t * 0.6) * 0.8));
  d.st.coats = [];
});

// ---------------------------------------------------------------- water
const WATER = new THREE.Group();
world.add(WATER);
// sky drop: glide in like a flying squirrel, splat, pop back up
addDemo("sky drop", lineup, mkState(12.5, ground0, LZ, -Math.PI / 2), (d, dt) => {
  const s = d.st, m = d.mem;
  m.t = ((m.t ?? 0) + dt) % 5.5;
  const t = m.t, T = 2.4, x0 = 12.5;
  if (t < T) {
    const k = 1 - t / T;
    s.mode = "glide";
    s.grounded = false;
    s.pos.set(x0 + k * 26, ground0 + k * 11, LZ);
    s.vel.set(-26 / T, -11 / T - (t < 0.3 ? 8 : 0), 0);
  } else {
    s.pos.set(x0, ground0, LZ);
    s.vel.set(0, 0, 0);
    s.grounded = true;
    s.mode = t < T + 0.42 ? "splat" : "idle";
    if (!m.landed) { m.landed = 1; fx.ring({ x: x0, y: ground0 + 0.05, z: LZ }, 0xf3e0bb, 2.6, 0.6); fx.dust({ x: x0, y: ground0 + 0.1, z: LZ }, 12); }
  }
  if (t < T) m.landed = 0;
});
addDemo("swim", WATER, mkState(-3, -SWIM_WATERLINE, -11, 0.6), (d, _dt, t) => {
  d.st.mode = "swim";
  d.st.wetness = 1;
  d.st.waterY = 0;
  fwd(d.st.yaw, 1.5 + Math.sin(t * 0.5), d.st.vel as THREE.Vector3);
});
addDemo("underwater", WATER, mkState(0, -1.7, -12, -0.8), (d, _dt, t) => {
  d.st.mode = "underwater";
  d.st.wetness = 1;
  d.st.breath = 0.5 + 0.5 * Math.sin(t * 0.3);
  fwd(d.st.yaw, 2.2, d.st.vel as THREE.Vector3);
  d.st.pos.y = -1.7 + Math.sin(t * 0.8) * 0.25;
  d.st.vel.y = Math.cos(t * 0.8) * 0.2;
});
const DOCK_TOP = 1.63;
addDemo("dive", WATER, mkState(3, DOCK_TOP, -4.6, Math.PI), (d, dt) => {
  const s = d.st, m = d.mem;
  m.t = (m.t ?? 0) + dt;
  const c = m.t % 5;
  if (c < 1) {
    s.mode = "idle"; s.grounded = true; s.pos.set(3, DOCK_TOP, -5.2); s.vel.set(0, 0, 0); s.wetness = Math.max(0, s.wetness - dt * 0.2);
    m.vy = 0;
  } else if (s.mode !== "underwater" && s.mode !== "swim" && s.pos.y > -0.6) {
    if (s.mode !== "dive") { m.vy = 3.2; s.grounded = false; }
    s.mode = "dive";
    m.vy -= G * dt;
    s.pos.y += m.vy * dt;
    s.pos.z -= 3.5 * dt;
    s.vel.set(0, m.vy, -3.5);
  } else if (c < 3.2) {
    s.mode = "underwater"; s.wetness = 1;
    s.pos.z -= 1.5 * dt;
    s.pos.y = Math.min(-1.2, s.pos.y + 0.5 * dt);
    s.vel.set(0, 0.3, -1.5);
  } else {
    s.mode = "swim"; s.waterY = 0;
    s.pos.y = -SWIM_WATERLINE;
    s.pos.z -= 1.0 * dt;
    s.vel.set(0, 0, -1.0);
  }
});

// ---------------------------------------------------------------- vehicles
const VEH = new THREE.Group();
world.add(VEH);
const jetski = createJetski({ fx });
const speedboat = createSpeedboat({ fx });
const gyro = createGyrocopter({ fx });
const gyroParked = createGyrocopter({ color: 0xf4a99a });
const jetskiParked = createJetski({ color: 0xf6b8c0 });
const speedboatParked = createSpeedboat({ color: 0xf6c7c0 });
const vespa = createVespa({ fx });
const vespaParked = createVespa({ color: 0xf6c7c0 });
VEH.add(jetski.object, speedboat.object, gyro.object, gyroParked.object, jetskiParked.object, speedboatParked.object, vespa.object, vespaParked.object);
interface Ride { v: VehicleActor; center: THREE.Vector3; r: number; w: number; t0: number; y: number; water: boolean; pitch?: number; air?: boolean }
const rides: Ride[] = [
  { v: jetski, center: new THREE.Vector3(-11, 0, -19), r: 7, w: 1.2, t0: 0, y: 0, water: true, pitch: 0.05 },
  { v: speedboat, center: new THREE.Vector3(11, 0, -21), r: 9, w: -0.8, t0: 1, y: 0, water: true, pitch: 0.08 },
  { v: vespa, center: new THREE.Vector3(1, groundH(0, 13), 13), r: 5.5, w: 0.75, t0: 0, y: groundH(0, 13), water: false },
  { v: gyro, center: new THREE.Vector3(0, 8, -6), r: 13, w: 0.9, t0: 2, y: 8, water: false, pitch: 0.06, air: true },
];
const rideState = (r: Ride, t: number) => {
  const a = r.t0 + t * r.w;
  const pos = new THREE.Vector3(r.center.x + Math.sin(a) * r.r, r.y, r.center.z + Math.cos(a) * r.r);
  const vx = Math.cos(a) * r.r * r.w, vz = -Math.sin(a) * r.r * r.w;
  return { pos, yaw: Math.atan2(vx, vz), speed: Math.abs(r.r * r.w), steer: Math.sign(r.w) * 0.6, vel: new THREE.Vector3(vx, 0, vz) };
};
function seatDemo(name: string, v: VehicleActor, seat: "driver" | "passenger" | "passenger2", mode: BlobMode) {
  return addDemo(name, VEH, mkState(0, 0, 0), (d, _dt, t) => {
    d.st.seat = v.seats[seat]!;
    d.st.mode = mode;
    if (seat === "driver") {
      d.st.grips = { l: v.gripL, r: v.gripR };
      d.st.standing = v.driverStanding;
    } else {
      d.st.aimYaw = (d.mem.baseYaw ?? 0) + Math.sin(t * 0.7) * 1.2;
      occasionalFire(d, t, 1.7);
    }
  });
}
const jetRider = seatDemo("jetski", jetski, "driver", "ride-vespa");
const boatDriver = seatDemo("speedboat", speedboat, "driver", "ride-vespa");
const boatPass = seatDemo("passenger", speedboat, "passenger", "passenger");
const boatPass2 = seatDemo("passenger", speedboat, "passenger2", "passenger");
const pilot = seatDemo("gyro", gyro, "driver", "ride-vespa");
const rider = seatDemo("ride-vespa", vespa, "driver", "ride-vespa");
vespaParked.object.position.set(14, groundH(14, 5), 5);
gyroParked.object.position.set(-13, groundH(-13, 4), 4);
jetskiParked.object.position.set(-24, 0, -8);
speedboatParked.object.position.set(24, 0, -9);

// ---------------------------------------------------------------- zipline
const zip = createZipline(ZA, ZB);
world.add(zip.object);
const zipper = addDemo("zipline", world as THREE.Group, mkState(ZA.x, ZA.y - 2, ZA.z), (d, dt) => {
  const m = d.mem;
  m.t = (m.t ?? 0) + dt;
  const c = m.t % 5;
  const ride = Math.min(1, c / 3.2);
  const tt = 0.03 + ride * 0.9;
  zip.update(dt, c < 3.2 ? tt : 0.03, c < 3.2);
  d.st.mode = c < 3.2 ? "zipline" : "fall";
  d.st.grips = { l: zip.gripL, r: zip.gripR };
  d.st.yaw = zip.yaw;
  if (c < 3.2) {
    d.st.pos.x = zip.riderPos.x; d.st.pos.y = zip.riderPos.y; d.st.pos.z = zip.riderPos.z;
    const sp = zip.length / 3.2 * 0.9;
    fwd(zip.yaw, sp, d.st.vel as THREE.Vector3);
    d.st.grounded = false;
  } else {
    // drop off and hide under the sand until the next ride
    d.st.pos.y = -20;
  }
});

// ---------------------------------------------------------------- pickups
const PICK = new THREE.Group();
world.add(PICK);
const pickups: PickupActor[] = [];
const kinds = [PickupKind.Ammo, PickupKind.BigHopper, PickupKind.RapidFire, PickupKind.LongBarrel, PickupKind.Scope, PickupKind.Vest, PickupKind.QuickFeet, PickupKind.Snorkel];
kinds.forEach((k, i) => {
  const p = createPickup(k);
  const x = -8.75 + i * 2.5, z = 7.5;
  p.object.position.set(x, groundH(x, z), z);
  PICK.add(p.object);
  pickups.push(p);
});
let pickT = 0;

// ---------------------------------------------------------------- paintball duel
const DUEL = new THREE.Group();
world.add(DUEL);
const DZ = 22;
const duelA = addDemo("duel A", DUEL, mkState(-5, groundH(-5, DZ), DZ, Math.PI / 2), () => {}, BLOB_COLORS[0]);
const duelB = addDemo("duel B", DUEL, mkState(5, groundH(5, DZ), DZ, -Math.PI / 2), () => {}, BLOB_COLORS[1]);
interface Shot { id: number; p: THREE.Vector3; v: THREE.Vector3; target: Demo; color: number }
const shots: Shot[] = [];
let shotId = 1;
let duelT = 0;
function shoot(from: Demo, to: Demo, color: number, spread = 0.6): void {
  from.blob.fire();
  const m = new THREE.Vector3(), dir = new THREE.Vector3();
  from.blob.getMuzzle(m, dir);
  fx.muzzle(m, dir, from.blob.color);
  const tgt = to.blob.object.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, 1.0 + (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread));
  const T = m.distanceTo(tgt) / 16;
  const v = tgt.clone().sub(m).divideScalar(T);
  v.y += 0.5 * G * T;
  const s: Shot = { id: shotId++, p: m.clone(), v, target: to, color };
  shots.push(s);
  fx.spawnBall(s.id, s.p, s.v, color);
}
function duelDrive(d: Demo, other: Demo, dt: number): void {
  const s = d.st, m = d.mem;
  const c = s.coats as number[];
  if (c.length >= 3 && s.mode !== "eliminated") { s.mode = "eliminated"; m.dead = 0; }
  if (s.mode === "eliminated") {
    m.dead += dt;
    if (m.dead > 3.3) { c.length = 0; s.mode = "spawn"; m.spawn = 0; }
  } else if (s.mode === "spawn") {
    m.spawn += dt;
    if (m.spawn > 1.2) s.mode = "idle";
  }
  const dx = other.blob.object.position.x - s.pos.x, dz = other.blob.object.position.z - s.pos.z;
  s.yaw = Math.atan2(dx, dz);
  s.aimPitch = 0.18;
}
const shotPositions = new Map<number, THREE.Vector3>();

// ---------------------------------------------------------------- hero (pose close-ups)
const HERO = new THREE.Group();
world.add(HERO);
const HERO_LAND = new THREE.Vector3(0, groundH(0, 30), 30);
const HERO_SEA = new THREE.Vector3(-26, 0, -12);
const hero = addDemo("hero", HERO, mkState(HERO_LAND.x, HERO_LAND.y, HERO_LAND.z), (d, dt) => {
  const s = d.st, m = d.mem;
  const mode = heroMode;
  const base = mode === "swim" || mode === "underwater" ? HERO_SEA : HERO_LAND;
  s.pos.set(base.x, base.y, base.z);
  s.vel.set(0, 0, 0);
  s.grounded = true;
  s.waterY = undefined;
  s.mode = mode;
  s.firing = heroPatch.fire === 1;
  s.aimPitch = heroPatch.aim ?? 0;
  s.coats = heroPatch.coats !== undefined ? BLOB_COLORS.slice(4, 4 + heroPatch.coats) : s.coats;
  s.wetness = heroPatch.wet ?? (mode === "swim" || mode === "underwater" ? 1 : 0);
  s.breath = heroPatch.breath ?? 1;
  switch (mode) {
    case "run": fwd(0, 4.8, s.vel as THREE.Vector3); break;
    case "sprint": fwd(0, 8, s.vel as THREE.Vector3); break;
    case "slide": fwd(0, 6, s.vel as THREE.Vector3); break;
    case "jump": s.grounded = false; s.pos.y += 0.9; s.vel.y = 3; break;
    case "fall": s.grounded = false; s.pos.y += 1.2; s.vel.y = -9; break;
    case "dive": s.grounded = false; s.pos.y += 0.6; s.vel.set(0, -1, 5); break;
    case "swim": s.waterY = 0; s.pos.y = -SWIM_WATERLINE; fwd(0, 1.5, s.vel as THREE.Vector3); break;
    case "underwater": s.pos.y = -1.6; fwd(0, 2, s.vel as THREE.Vector3); break;
    case "mantle": s.grounded = false; s.pos.y += 0.5; break;
    case "ride-vespa": case "row": case "passenger": s.pos.y += 0.45; break;
    case "zipline": s.grounded = false; s.pos.y += 0.4; break;
    case "glide": s.grounded = false; s.pos.y += 2.2; s.vel.set(0, -13 * (heroPatch.sink ?? 1), 30 * (heroPatch.speed ?? 1)); break;
  }
  void m; void dt;
});
let heroMode: BlobMode = "idle";
const heroPatch: { coats?: number; wet?: number; aim?: number; fire?: number; breath?: number; sink?: number; speed?: number } = {};
if (qs.has("sink")) heroPatch.sink = num("sink", 1);
if (qs.has("speed")) heroPatch.speed = num("speed", 1);
if (qs.has("coats")) heroPatch.coats = num("coats", 0);
if (qs.has("wet")) heroPatch.wet = num("wet", 0);
if (qs.has("aim")) heroPatch.aim = num("aim", 0);
if (qs.has("fire")) heroPatch.fire = num("fire", 0);
if (qs.has("breath")) heroPatch.breath = num("breath", 1);
// a little crate so the seated hero poses have something to sit on
const heroSeat = box(HERO_LAND.x, HERO_LAND.y + 0.22, HERO_LAND.z - 0.05, 0.7, 0.44, 0.6);
heroSeat.visible = false;

// ---------------------------------------------------------------- stress
const STRESS = new THREE.Group();
world.add(STRESS);
const stressBlobs: { b: BlobActor; st: DState; a: number; r: number; w: number; fireT: number }[] = [];
const STRESS_C = new THREE.Vector3(0, 0, 44);
function stress(n: number, solo = false): void {
  for (const s of stressBlobs) s.b.dispose();
  stressBlobs.length = 0;
  for (let i = 0; i < n; i++) {
    const b = createBlob({ color: BLOB_COLORS[i % BLOB_COLORS.length], fx });
    STRESS.add(b.object);
    const st = mkState(0, 0, 0);
    st.mode = i % 3 === 0 ? "sprint" : "run";
    st.coats = BLOB_COLORS.slice(i % 5, i % 5 + (i % 3));
    st.wetness = i % 4 === 0 ? 0.9 : 0;
    stressBlobs.push({ b, st, a: (i / n) * Math.PI * 2, r: 5 + (i % 4) * 1.6, w: (i % 2 ? 1 : -1) * (0.55 + (i % 3) * 0.15), fireT: Math.random() });
  }
  for (const g of [lineup, WATER, VEH, PICK, DUEL, HERO]) g.visible = !solo;
  zip.object.visible = !solo;
  for (const d of demos) d.tag.sprite.visible = !solo && showTags;
  if (solo) showTags = false;
  setFocus("stress");
}

// ---------------------------------------------------------------- cycle lineup
const CYCLE_MODES: BlobMode[] = ["idle", "run", "sprint", "jump", "slide", "dive", "mantle", "fall", "spawn"];
const cycleOn = qs.get("cycle") === "1";

// ---------------------------------------------------------------- camera focus
let follow: { obj: () => THREE.Vector3; off: THREE.Vector3; look: THREE.Vector3 } | null = null;
function camTo(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
  follow = null;
  camera.position.set(x, y, z);
  controls.target.set(tx, ty, tz);
  controls.update();
}
function setFocus(what: string, mode?: string): void {
  const lz = LZ;
  switch (what) {
    case "blob": {
      heroMode = (BLOB_MODES as string[]).includes(mode ?? "") ? (mode as BlobMode) : "idle";
      heroSeat.visible = heroMode === "passenger" || heroMode === "row" || heroMode === "ride-vespa";
      const sea = heroMode === "swim" || heroMode === "underwater";
      const b = sea ? HERO_SEA : HERO_LAND;
      const side = heroMode === "dive" || heroMode === "slide" || heroMode === "sprint" || heroMode === "underwater" || heroMode === "swim" ? 1 : 0.55;
      const dist = heroMode === "eliminated" ? 3 : 3.6;
      const air = heroMode === "jump" || heroMode === "fall" ? 0.9 : heroMode === "dive" ? 0.5 : 0;
      const h = (heroMode === "underwater" ? 1.6 : heroMode === "eliminated" ? 1.4 : 1.35) + air;
      const ty = (heroMode === "underwater" ? -1.2 : heroMode === "eliminated" ? 0.2 : heroMode === "swim" ? 0.1 : 1.0) + air;
      camTo(b.x + Math.sin(side) * dist, b.y + h, b.z + Math.cos(side) * dist, b.x, b.y + ty, b.z);
      if (sea) { hero.group.visible = true; }
      break;
    }
    case "lineup": camTo(0, 5.5, lz + 15, 0, 1, lz); break;
    case "water": camTo(-1, 3.5, -2, 0, -0.8, -11); break;
    case "jetski": follow = { obj: () => jetski.object.position, off: new THREE.Vector3(3.5, 2.2, 3.5), look: new THREE.Vector3(0, 0.6, 0) }; break;
    case "speedboat": follow = { obj: () => speedboat.object.position, off: new THREE.Vector3(6, 3.5, 6), look: new THREE.Vector3(0, 0.8, 0) }; break;
    case "gyro": follow = { obj: () => gyro.object.position, off: new THREE.Vector3(5, 2.5, 5), look: new THREE.Vector3(0, 1.2, 0) }; break;
    case "jetski-parked": camTo(-24 + 2.6, 1.6, -8 + 2.4, -24, 0.35, -8); break;
    case "speedboat-parked": camTo(24 - 5.5, 3.2, -9 + 5, 24, 0.4, -9); break;
    case "gyro-parked": camTo(-13 + 4.5, groundH(-13, 4) + 2.6, 4 + 4.5, -13, groundH(-13, 4) + 1.1, 4); break;
    case "vespa": follow = { obj: () => vespa.object.position, off: new THREE.Vector3(3, 1.8, 3), look: new THREE.Vector3(0, 0.8, 0) }; break;
    case "vespa-parked": camTo(14 + 2.2, groundH(14, 5) + 1.2, 5 + 2.2, 14, groundH(14, 5) + 0.5, 5); break;
    case "zipline": follow = { obj: () => zipper.blob.object.position, off: new THREE.Vector3(2.6, 0.6, -4.2), look: new THREE.Vector3(0, 1.6, 0) }; break;
    case "zipline-wide": camTo(-2, 6, 4, -11, 4.5, 13.5); break;
    case "pickups": camTo(0, 3.2, 14, 0, 1, 7.5); break;
    case "duel": camTo(0, 4, DZ + 9, 0, 1, DZ); break;
    case "stress": camTo(STRESS_C.x, 10, STRESS_C.z + 16, STRESS_C.x, 0.8, STRESS_C.z); break;
    default: camTo(3, 7, 19, 0, 0.5, -1);
  }
  if (what === "blob") showTags = false;
  if (follow) updateFollow();
}
function updateFollow(): void {
  if (!follow) return;
  const p = follow.obj();
  const tgt = p.clone().add(follow.look);
  camera.position.copy(tgt).add(follow.off);
  controls.target.copy(tgt);
}

// ---------------------------------------------------------------- loop
let paused = qs.get("pause") === "1";
let simT = 0;
const tmp = new THREE.Vector3();
function tick(dt: number): void {
  simT += dt;
  const t = simT;
  // vehicles first (seats + grips), then blobs
  for (const r of rides) {
    const s = rideState(r, t);
    r.v.update(dt, { pos: s.pos, yaw: s.yaw, speed: s.speed, steer: s.steer, occupied: true, throttle: 0.8, pitch: r.pitch, airborne: r.air });
  }
  vespaParked.update(dt, { pos: vespaParked.object.position.clone(), yaw: -0.6, speed: 0, occupied: false });
  gyroParked.update(dt, { pos: gyroParked.object.position.clone(), yaw: 0.7, speed: 0, occupied: false });
  jetskiParked.update(dt, { pos: jetskiParked.object.position.clone(), yaw: 1.9, speed: 0, occupied: false });
  speedboatParked.update(dt, { pos: speedboatParked.object.position.clone(), yaw: -2.2, speed: 0, occupied: false });
  const boatVel = (r: Ride) => rideState(r, t).vel;
  jetRider.st.vel = boatVel(rides[0]);
  boatDriver.st.vel = boatVel(rides[1]); boatPass.st.vel = boatVel(rides[1]); boatPass2.st.vel = boatVel(rides[1]);
  rider.st.vel = boatVel(rides[2]);
  pilot.st.vel = boatVel(rides[3]);
  boatPass.mem.baseYaw = speedboat.object.rotation.y;
  boatPass2.mem.baseYaw = speedboat.object.rotation.y;

  // duel
  duelT += dt;
  duelDrive(duelA, duelB, dt);
  duelDrive(duelB, duelA, dt);
  if (duelT > 0.45) {
    duelT = 0;
    const aTurn = Math.random() < 0.5;
    const [f, to] = aTurn ? [duelA, duelB] : [duelB, duelA];
    if (f.st.mode !== "eliminated" && to.st.mode !== "eliminated" && to.st.mode !== "spawn") shoot(f, to, f.blob.color.getHex(), 1.3);
  }
  shotPositions.clear();
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.v.y -= G * dt;
    s.p.addScaledVector(s.v, dt);
    const tp = s.target.blob.object.position;
    tmp.set(tp.x, tp.y + 0.95, tp.z);
    const hitBlob = s.p.distanceTo(tmp) < 0.55 && s.target.st.mode !== "eliminated";
    const gh = groundH(s.p.x, s.p.z);
    if (hitBlob || s.p.y < gh || s.p.y < -0.05) {
      fx.removeBall(s.id);
      shots.splice(i, 1);
      if (hitBlob) {
        const n = s.v.clone().normalize().negate();
        fx.burst(s.p, n, s.color, 0.8);
        (s.target.st.coats as number[]).push(s.color);
      } else if (s.p.y < -0.05 && gh < -0.05) fx.splashWater({ x: s.p.x, y: 0, z: s.p.z }, 0.35);
      else fx.burst({ x: s.p.x, y: gh, z: s.p.z }, { x: 0, y: 1, z: 0 }, s.color, 0.8);
    } else shotPositions.set(s.id, s.p);
  }

  // stress ring
  for (const s of stressBlobs) {
    s.a += s.w * dt * (s.st.mode === "sprint" ? 1.5 : 1) * (4.5 / s.r);
    const x = STRESS_C.x + Math.sin(s.a) * s.r, z = STRESS_C.z + Math.cos(s.a) * s.r;
    const vx = Math.cos(s.a) * s.w, vz = -Math.sin(s.a) * s.w;
    s.st.pos.x = x; s.st.pos.z = z; s.st.pos.y = groundH(x, z);
    s.st.yaw = Math.atan2(vx, vz);
    fwd(s.st.yaw, s.st.mode === "sprint" ? 8 : 4.8, s.st.vel as THREE.Vector3);
    s.fireT -= dt;
    s.st.firing = false;
    if (s.fireT <= 0 && s.st.mode === "run") {
      s.fireT = 0.6 + Math.random();
      s.b.fire();
      s.b.getMuzzle(tmp);
      const v = new THREE.Vector3(Math.sin(s.st.yaw) * 16, 3, Math.cos(s.st.yaw) * 16);
      fx.spawnBall(shotId, tmp, v, s.b.color);
      const id = shotId++;
      setTimeout(() => fx.removeBall(id), 700);
    }
    s.b.update(dt, s.st);
  }

  // cycle lineup
  if (cycleOn) {
    const k = Math.floor(t / 3);
    demos.slice(0, 8).forEach((d, i) => {
      const m = CYCLE_MODES[(k + i) % CYCLE_MODES.length];
      if (d.mem.cycleK !== k) {
        d.mem.cycleK = k;
        d.st.pos.set(d.home!.x, d.home!.y, d.home!.z);
        d.st.vel.set(0, 0, 0);
        d.st.grounded = !["jump", "fall", "dive", "mantle"].includes(m);
      }
      d.st.mode = m;
      if (m === "run" || m === "sprint" || m === "slide") fwd(0, m === "sprint" ? 8 : 5, d.st.vel as THREE.Vector3);
      if (m === "jump" || m === "dive") d.st.pos.y = d.home!.y + 0.8;
    });
  }

  for (const d of demos) {
    if (!(cycleOn && demos.indexOf(d) < 8)) d.drive(d, dt, t);
    d.blob.update(dt, d.st);
    d.blob.getTagAnchor(tmp);
    d.tag.update(tmp, showTags && d.group.visible && d !== hero && d.blob.object.position.y > -15);
  }
  // pickups: one of them keeps getting collected
  pickT += dt;
  if (pickT > 4) {
    pickT = 0;
    const p = pickups[Math.floor(t / 4) % pickups.length];
    p.collect(fx);
    setTimeout(() => p.respawn(), 1400);
  }
  for (const p of pickups) p.update(dt, camera.position);
  fx.updateBalls(dt, shotPositions);
}

// ---------------------------------------------------------------- stats + debug
const stats = { fps: 0, frameMs: 0, tickMs: 0, calls: 0, triangles: 0, blobs: 0, fx: fx.stats };
(window as unknown as { __stats: typeof stats }).__stats = stats;
let frames = 0, acc = 0, last = performance.now();
const hud = document.getElementById("hud")!;
function renderHud(): void {
  hud.innerHTML = `<b>Isola actors</b> · <span id="st"></span><br>` +
    ["lineup", "water", "jetski", "speedboat", "gyro", "gyro-parked", "vespa", "zipline", "pickups", "duel"].map((w) => `<button data-f="${w}">${w}</button>`).join("") +
    "<br>" + BLOB_MODES.map((m) => `<button data-m="${m}">${m}</button>`).join("") +
    `<br><button data-s="20">stress 20</button><button data-t>tags</button>`;
}
function renderStats(): void {
  const el = document.getElementById("st");
  if (el) el.textContent = `${stats.fps.toFixed(0)} fps · ${stats.calls} calls · ${(stats.triangles / 1000).toFixed(0)}k tris · tick ${stats.tickMs.toFixed(2)} ms`;
}
hud.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.f) setFocus(b.dataset.f);
  if (b.dataset.m) setFocus("blob", b.dataset.m);
  if (b.dataset.s) stress(Number(b.dataset.s));
  if (b.dataset.t !== undefined) showTags = !showTags;
});
if (qs.get("hud") === "0") hud.classList.add("hidden");

const debug = {
  focus: (what: string, mode?: string) => setFocus(what, mode),
  camera: camTo,
  hero: (p: typeof heroPatch) => Object.assign(heroPatch, p),
  pause: (p = true) => { paused = p; },
  step: (sec: number) => { for (let i = 0; i < Math.round(sec * 60); i++) tick(1 / 60); },
  stress,
  tags: (on = true) => { showTags = on; },
  demos: () => demos.map((d) => `${d.name}:${d.st.mode}`),
  tris: () => {
    const out: Record<string, number> = {};
    const count = (o: THREE.Object3D) => {
      let n = 0;
      o.traverse((m) => { const g = (m as THREE.Mesh).geometry; if (g && (m as THREE.Mesh).isMesh) n += (g.index ? g.index.count : g.getAttribute("position").count) / 3; });
      return n;
    };
    out.blobMesh = count(demos[0].blob.mesh) - 0;
    out.jetski = count(jetski.object); out.speedboat = count(speedboat.object); out.gyro = count(gyro.object); out.vespa = count(vespa.object);
    out.pickup = count(pickups[1].object); out.ammo = count(pickups[0].object); out.zip = count(zip.object);
    return out;
  },
};
(window as unknown as { __debug: typeof debug }).__debug = debug;

// initial setup from query
if (qs.has("stress")) stress(num("stress", 20), qs.get("solo") === "1");
else if (qs.has("focus")) setFocus(qs.get("focus")!, qs.get("mode") ?? undefined);
else setFocus("overview");
if (qs.has("cam")) {
  const c = qs.get("cam")!.split(",").map(Number);
  camTo(c[0], c[1], c[2], c[3], c[4], c[5]);
}
const warm = num("t", 2);
for (let i = 0; i < Math.round(warm * 60); i++) tick(1 / 60);
renderHud();

let readyFrames = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t0 = performance.now();
  if (!paused) tick(dt);
  stats.tickMs = stats.tickMs * 0.9 + (performance.now() - t0) * 0.1;
  updateFollow();
  controls.update();
  renderer.render(scene, camera);
  stats.calls = renderer.info.render.calls;
  stats.triangles = renderer.info.render.triangles;
  stats.blobs = demos.length + stressBlobs.length;
  stats.fx = fx.stats;
  frames++;
  acc += dt;
  if (acc > 0.5) {
    stats.fps = frames / acc;
    stats.frameMs = (acc / frames) * 1000;
    frames = 0;
    acc = 0;
    renderStats();
  }
  if (++readyFrames === 4) (window as unknown as { __ready: boolean }).__ready = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
