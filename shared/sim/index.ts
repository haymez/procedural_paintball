// Public entry for the match simulation.
export * from "./constants";
export * from "./types";
export { createEnv, waterAt, probeGround, zipPoint, NO_WATER_Y, BLOCKED, type SimEnv } from "./env";
export { stepPlayer, createPlayerState, copyPlayerState, bodyHeight, eyeHeight, canShootIn, hasUpgrade, aimDir } from "./player";
export { stepVehicle, seatWorld, SEATS, HULL, VEHICLE_NAMES, vehicleMaxSpeed, vehicleVerb, canBoard } from "./vehicle";
export { computeLaunch, traceArc, eyePos, muzzlePos, currentSpread, hopperCap, fireInterval, ballSpeed, type Launch, type ArcResult } from "./weapon";
export { MatchSim, segCapsule, upgradeName, type MatchOptions, type InteractTarget, type InteractKind } from "./match";
export { captureSnapshot, restorePlayer, type MatchSnapshot } from "./snapshot";
export { ActionLog, hotZones, HOT_W, type ActionRec, type HotZone } from "./hotzones";
export { dropSite, glideReach, type DropSite } from "./skydrop";
export { Dummy } from "./dummy";
