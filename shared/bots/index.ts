// Bot world-knowledge layer: navigation graph, pathfinding and tactical
// queries. Pure TS; safe to run inside the Durable Object.
//
//   const bw = buildBotWorld(world, cw);             // ~200 ms once per match
//   findPath(bw.nav, from, to, opts)                 // -> waypoints tagged walk / wade / swim / dive /
//                                                    //    jump-down / mantle / zipline / cave / vehicle
//   new PathPlanner(bw.nav).request(...) / update(budget)   // many bots, bounded work per tick
//   nearestNode / randomReachablePoint / findNearest / nearestWater
//   lineOfSight / findCover(bw.nav, bw.cover, ...) / ballisticAim / trajectoryClear
//   bw.pois.{pickups, perches, ziplineTops} · new DangerMap()
//
// Conventions: positions are feet positions (a swimmer's feet float
// SWIM_DEPTH below the surface); costs are estimated seconds; everything is
// deterministic (ties break on node index, budgets count node expansions).
import { buildCollision, type CollisionWorld } from "../world/collide";
import type { World } from "../world/types";
import { buildNav, nowMs, type NavBuildOptions, type NavGraph } from "./nav";
import { buildCover, buildPois, type CoverSet, type Pois } from "./tactics";

export * from "./constants";
export * from "./nav";
export * from "./path";
export * from "./tactics";

export interface BotWorld {
  nav: NavGraph;
  cover: CoverSet;
  pois: Pois;
  /** Build timings (ms). */
  ms: { nav: number; cover: number; pois: number; total: number };
}

/** Builds everything the bot brain needs for one world. */
export function buildBotWorld(world: World, cw: CollisionWorld = buildCollision(world), opts: NavBuildOptions = {}): BotWorld {
  const now = nowMs;
  const t0 = now();
  const nav = buildNav(world, cw, opts);
  const t1 = now();
  const cover = buildCover(nav);
  const t2 = now();
  const pois = buildPois(nav);
  const t3 = now();
  return { nav, cover, pois, ms: { nav: t1 - t0, cover: t2 - t1, pois: t3 - t2, total: t3 - t0 } };
}
