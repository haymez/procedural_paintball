// Viewer-only ray test: heightfield march + three.js raycast against regular meshes.
import * as THREE from "three";
import type { World } from "../../../../shared/world/types";
import { heightAt } from "../worldTextures";

const rc = new THREE.Raycaster();
export function raycastWorld(world: World, scene: THREE.Object3D, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
  let tHit = Infinity;
  let normal = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  let prevT = 0;
  for (let t = 0.5; t < maxDist; t += 0.5) {
    p.copy(origin).addScaledVector(dir, t);
    if (p.y < heightAt(world, p.x, p.z)) {
      let lo = prevT, hi = t;
      for (let k = 0; k < 12; k++) {
        const m = (lo + hi) / 2;
        p.copy(origin).addScaledVector(dir, m);
        if (p.y < heightAt(world, p.x, p.z)) hi = m; else lo = m;
      }
      tHit = hi;
      const e = 0.5;
      normal = new THREE.Vector3(heightAt(world, p.x - e, p.z) - heightAt(world, p.x + e, p.z), 2 * e, heightAt(world, p.x, p.z - e) - heightAt(world, p.x, p.z + e)).normalize();
      break;
    }
    prevT = t;
  }
  rc.set(origin, dir);
  rc.far = Math.min(maxDist, tHit);
  const targets: THREE.Object3D[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o.name.startsWith("structures") || o.name.startsWith("cave"))) targets.push(o); });
  const hits = rc.intersectObjects(targets, false);
  if (hits.length && hits[0].distance < tHit) {
    const h = hits[0];
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { point: h.point.clone(), normal: n };
  }
  if (tHit === Infinity) return null;
  return { point: origin.clone().addScaledVector(dir, tHit), normal };
}
