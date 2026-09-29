// Every gameplay tuning number lives here. Units: meters, seconds, radians.
// The sim (server + client prediction) and the client (camera, HUD) both read
// these, so changing a value here changes the game everywhere.

// ---------------------------------------------------------------- timing
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
export const MATCH_SECONDS = 600;

// ---------------------------------------------------------------- body
/** Radius of the body spheres (horizontal collision). */
export const BODY_R = 0.36;
export const BODY_H = 1.7;
/** Body height while sliding / diving / swimming (the capsule top drops). */
export const BODY_H_LOW = 1.0;
/** Anything lower than this is stepped onto; the body capsule starts here. */
export const STEP_H = 0.5;
/** Grounded players stick to ground up to this far below their feet (stairs down, slopes). */
export const SNAP_DOWN = 0.55;
/** Eye (aim origin) height above the feet. */
export const EYE_H = 1.45;
export const EYE_H_LOW = 0.9;
/** Ground whose normal.y is below this is too steep to stand on (≈ 46°). */
export const WALK_NY = 0.69;
/** Max horizontal distance moved per collision substep. */
export const MAX_SUBSTEP = 0.24;

// ---------------------------------------------------------------- locomotion
export const RUN_SPEED = 5.7;
export const SPRINT_SPEED = 8.8;
export const AIM_SPEED = 3.5;
export const BACK_MULT = 0.82;
export const QUICKFEET_MULT = 1.18;
export const WADE_MULT = 0.62;
/** Ground acceleration toward the wished velocity (m/s²) — high = snappy. */
export const GROUND_ACCEL = 70;
export const GROUND_DECEL = 55;
/** Turning while running keeps speed (redirect fraction per second). */
export const GROUND_TURN = 18;
export const AIR_ACCEL = 22;
export const AIR_DRAG = 0.15;

export const GRAVITY = 25;
/** Gravity multiplier while falling (snappier arcs). */
export const FALL_MULT = 1.32;
export const MAX_FALL = 42;
export const JUMP_SPEED = 8.3;
/** Releasing jump early cuts the upward velocity (variable jump height). */
export const JUMP_CUT = 0.55;
export const COYOTE_TIME = 0.13;
export const JUMP_BUFFER = 0.15;
/** Horizontal boost for jumping out of a slide (keeps the speed fantasy alive). */
export const SLIDE_JUMP_KEEP = 1.0;

// slide (sprint + crouch, or landing a belly-flop)
export const SLIDE_MIN_SPEED = 4.5;
export const SLIDE_BOOST = 11;
export const SLIDE_FRICTION = 6.5;
/** Extra acceleration along the downhill direction while sliding (× slope). */
export const SLIDE_SLOPE_ACCEL = 26;
export const SLIDE_MAX = 17;
export const SLIDE_MIN_TIME = 0.35;
export const SLIDE_END_SPEED = 3.2;
export const SLIDE_STEER = 2.2;
export const SLIDE_COOLDOWN = 0.45;
/** Sliding down a too-steep slope you can't stand on. */
export const STEEP_SLIDE_ACCEL = 20;

// belly-flop dive (crouch in the air)
export const DIVE_BOOST = 5;
export const DIVE_HOP = 3.2;
export const DIVE_MAX_H = 13;

// mantle
export const MANTLE_MAX = 2.15;
export const MANTLE_MIN_GROUND = 0.9;
export const MANTLE_REACH = 0.55;
export const MANTLE_TIME = 0.34;

// landing
export const STUMBLE_VY = 18;
export const STUMBLE_TIME = 0.5;
export const STUMBLE_MULT = 0.4;

// ---------------------------------------------------------------- water
/** Floating: feet this far below the surface (matches the blob's SWIM_WATERLINE). */
export const SWIM_DEPTH = 1.0;
/** Deeper than this (feet below surface) and you start swimming. */
export const SWIM_ENTER = 1.12;
/** Floor this shallow (feet below surface) lets you stand up again. */
export const SWIM_EXIT = 0.95;
/** Wading slows you once the water is this deep. */
export const WADE_DEPTH = 0.4;
export const SWIM_SPEED = 3.4;
export const SWIM_SPRINT = 4.3;
export const SWIM_ACCEL = 10;
export const UNDERWATER_SPEED = 4.2;
export const UNDERWATER_ACCEL = 12;
export const BUOYANCY = 3.2;
/** Seconds of breath (Snorkel multiplies). */
export const BREATH_TIME = 8;
export const SNORKEL_MULT = 2;
export const BREATH_REFILL = 0.6; // fraction per second at the surface
export const GASP_TIME = 3;
/** Seconds fully submerged to wash off one coat (most recent first). */
export const WASH_TIME = 1.5;
/** Hitting the water faster than this plunges you underwater. */
export const PLUNGE_VY = 9;

// ---------------------------------------------------------------- marker
export const BALL_SPEED = 46;
export const LONGBARREL_MULT = 1.3;
export const BALL_GRAVITY = 9;
export const BALL_RADIUS = 0.07;
export const BALL_LIFE = 2.4;
/** The launch is lifted so balls land exactly on the crosshair up to this distance (a "zero"). */
export const ZERO_DIST = 24;
export const ZERO_DIST_LONG = 34;
export const AIM_RANGE = 160;
export const FIRE_INTERVAL = 0.15;
export const RAPID_INTERVAL = 0.085;
export const HOPPER = 20;
export const BIG_HOPPER = 34;
export const RESERVE_START = 60;
export const RESERVE_MAX = 140;
export const AMMO_CACHE = 45;
export const RELOAD_TIME = 1.35;
export const SPREAD_HIP = 0.024;
export const SPREAD_AIM = 0.004;
export const SPREAD_MOVE = 0.014;
export const SPREAD_AIR = 0.03;
/** Radius of the player hit capsule (generous: it's a party game). */
export const HIT_R = 0.52;
export const HIT_KNOCKBACK = 1.6;

// camera-facing numbers the client uses
export const AIM_ZOOM = 1.45;
export const SCOPE_ZOOM = 3.4;

// ---------------------------------------------------------------- paint = health
export const MAX_COATS = 3;
/** Paint wears off on its own: after this long without a new hit… */
export const PAINT_WEAR_DELAY = 5;
/** …one coat (most recent first) flakes off every this many seconds until clean. Water (WASH_TIME) is faster. */
export const PAINT_WEAR_TIME = 4;
export const SPAWN_SHIELD = 2;
/** Seconds as a puddle before dropping back in from the sky. */
export const RESPAWN_DELAY = 3;
/** How long the splat animation runs before the drop map opens. */
export const ELIM_ANIM = 1.1;

// ---------------------------------------------------------------- pickups
export const PICKUP_R = 1.5;
export const AMMO_RESPAWN = 20;
export const UPGRADE_RESPAWN = 45;
export const DROP_LIFETIME = 35;

// ---------------------------------------------------------------- vehicles
export const INTERACT_R = 2.8;
// boats (jetski + speedboat): arcade water physics in sim/vehicle.ts
export const JETSKI_SPEED = 24;
export const JETSKI_ACCEL = 13;
export const JETSKI_TURN = 2.5;
export const SPEEDBOAT_SPEED = 20;
export const SPEEDBOAT_ACCEL = 7.5;
export const SPEEDBOAT_TURN = 1.45;
/** Reverse speed as a fraction of top speed. */
export const BOAT_REVERSE = 0.22;
/** Coasting: speed lost per second (fraction of speed + constant m/s²). */
export const BOAT_DRAG = 0.45;
export const BOAT_DRAG_C = 1.2;
/** Hull bottom below the water line: shallower water lifts the hull onto the bottom (beaching). */
export const BOAT_DRAFT = 0.35;
/** Sliding up a beach: friction (m/s²) + more the higher the hull is out of the water. */
export const BOAT_BEACH_FRICTION = 9;
export const BOAT_BEACH_LIFT_FRICTION = 22;
/** Ground climbs steeper than this (rise / run) under the bow are a wall, not a beach. */
export const BOAT_BEACH_SLOPE = 0.38;
/** Head-on hits (cos of travel vs obstacle normal above this) bounce back at REBOUND of the speed. */
export const BOAT_HEADON = 0.85;
export const BOAT_REBOUND = 0.35;
/** Jetski hop (Jump) and swell kick-up speeds. */
export const JETSKI_HOP = 6.5;
export const JETSKI_HOP_MIN_SPEED = 5;
/** Swell crests are this far apart; crossing one faster than SWELL_SPEED lifts a jetski off the water. */
export const SWELL_SPACING = 18;
export const SWELL_SPEED = 17;

// gyrocopter: arcade autogyro flight
export const GYRO_SPEED = 25;
/** Airspeed held with the throttle neutral (W speeds up, S slows toward a gentle sink). */
export const GYRO_CRUISE = 16;
export const GYRO_ACCEL = 6.5;
/** Forward airspeed where the rotor carries the craft; below it, it sinks (auto-rotation). */
export const GYRO_MIN_SPEED = 9;
/** Ground run: lifts off by itself above this speed. */
export const GYRO_TAKEOFF_SPEED = 12.5;
export const GYRO_CLIMB = 7;
/** Hands off the climb this close (m) above the ground: the gyro keeps climbing out anyway. */
export const GYRO_CLIMB_OUT = 12;
export const GYRO_DIVE = 10;
/** Slowest possible descent with no airspeed (auto-rotation, not a stone). */
export const GYRO_SINK = 3.2;
/** Max height above sea level. */
export const GYRO_CEILING = 140;
export const GYRO_TURN = 1.25;
export const GYRO_GROUND_TURN = 1.6;
/** Touch-downs faster than this bounce. */
export const GYRO_BOUNCE_V = 5.5;
export const VESPA_SPEED = 15.5;
export const VESPA_REVERSE = 4;
export const VESPA_ACCEL = 8.5;
export const VESPA_BRAKE = 18;
export const VESPA_DRAG = 1.2;
export const VESPA_TURN = 2.3;
/** Max climbable slope (rise / run) for the Vespa. */
export const VESPA_MAX_SLOPE = 0.72;
/** The Vespa refuses water deeper than this. */
export const VESPA_MAX_WADE = 0.5;
export const VESPA_BOUNCE = 0.32;
/** Ledges / kinks up to this high (above the scooter's ground) are driven over whatever the slope. */
export const VESPA_STEP = 0.4;
/** Body clearance kept from trunks, rocks and walls (front probe radius). */
export const VESPA_BODY_R = 0.32;
/**
 * Hitting something: cos of the angle between travel and the obstacle's
 * normal. Above this it's head-on and the scooter bounces back; below it
 * slides along the obstacle and keeps most of its speed.
 */
export const VESPA_HEADON = 0.93;
/** Head-on hits bounce back at this fraction of the speed. */
export const VESPA_REBOUND = 0.3;
/** ...and swing the nose this far (rad) off the obstacle so the next try glances past it. */
export const VESPA_HEADON_NUDGE = 0.45;
/** Glancing hits keep 1 - SCRAPE·cos² of the speed (a 30° graze keeps ~88%). */
export const VESPA_SCRAPE = 0.5;
/** How fast the nose swings round to follow the obstacle it's sliding along (rad/s). */
export const VESPA_DEFLECT_TURN = 6;
export const VEHICLE_ABANDON = 90;

// ---------------------------------------------------------------- ziplines
export const ZIP_GRAB_R = 2.6;
export const ZIP_START_SPEED = 4;
export const ZIP_ACCEL = 14;
export const ZIP_MAX_SPEED = 19;
/** Feet hang this far below the cable (handle drop + ZIP_HANG in the renderer). */
export const ZIP_FEET = 2.27;
export const ZIP_SAG = 0.03;

// ---------------------------------------------------------------- sky drop
// Every (re)spawn is a drop from high over the island: the blob spreads out
// like a flying squirrel and glides down wherever the player steers, then
// splats onto the ground (no damage) and pops back up.
/** Drop altitude: this far above the island's highest ground, kept within [DROP_MIN_Y, DROP_MAX_Y]. */
export const DROP_CLEARANCE = 55;
export const DROP_MIN_Y = 170;
export const DROP_MAX_Y = 215;
/** Drops start over the island's middle, scattered within this radius (m). */
export const DROP_SCATTER = 45;
/** Glide target velocities: horizontal speed along the view and sink rate (m/s). Neutral = no W/S. */
export const GLIDE_SPEED = 30;
export const GLIDE_SINK = 13;
/** W: nose down, faster and steeper. */
export const GLIDE_DIVE_SPEED = 40;
export const GLIDE_DIVE_SINK = 27;
/** S: flare, slow and flat (the longest reach: every corner of the island). */
export const GLIDE_FLARE_SPEED = 20;
export const GLIDE_FLARE_SINK = 5.2;
/** Shift: tuck the flaps in and plummet (get down right here, now). */
export const GLIDE_TUCK_SPEED = 8;
export const GLIDE_TUCK_SINK = 46;
/** A/D: sideways slip (m/s). */
export const GLIDE_STRAFE = 11;
/** How hard the glider chases its target velocity (m/s²): high = easy to land where you want. */
export const GLIDE_ACCEL = 30;
export const GLIDE_VACCEL = 26;
/** Pancaked on landing for this long, then pop back up. */
export const SPLAT_TIME = 0.42;
/** Spawn shield: the whole drop, plus this long after touching down. */
export const DROP_LAND_SHIELD = 1.5;
/** "Hot zones": hits and eliminations in the last HOT_WINDOW s, clustered within HOT_RADIUS m. */
export const HOT_WINDOW = 20;
export const HOT_RADIUS = 40;
