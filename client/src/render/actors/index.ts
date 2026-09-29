// Public entry for characters, vehicles, pickups and paint FX.
export { createBlob, BLOB_COLORS, BLOB_MODES, SWIM_WATERLINE, ZIP_HANG, crestFor } from "./blob";
export type { BlobActor, BlobState, BlobMode, BlobOptions, BlobFx } from "./blob";
export { createPaintFx, makeGlossyToon } from "./paintFx";
export type { PaintFx, PaintFxOptions, Vec3Like } from "./paintFx";
export { createMarkerMesh, MARKER_MUZZLE, MuzzlePuff } from "./marker";
export { createJetski, createSpeedboat, createVespa, createGyrocopter, createVehicle, VESPA_COLORS, JETSKI_COLORS, GYRO_COLORS } from "./vehicles";
export type { VehicleActor, VehicleState } from "./vehicles";
export { createZipline, ZIP_HANDLE_DROP } from "./zipline";
export type { ZiplineActor } from "./zipline";
export { createPickup, createDroppedMarker, PICKUP_COLORS } from "./pickups";
export type { PickupActor } from "./pickups";
export { createNameTag } from "./nameTag";
export type { NameTag } from "./nameTag";
