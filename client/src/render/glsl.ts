// Shared GLSL snippets for the world renderer. Every custom shader that needs
// the sky, noise or the stylized lighting pulls from here so the whole island
// reads as one piece.

/** Uniform declarations for the shared environment (see env.ts). */
export const ENV_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;        // unit, world space, towards the sun
uniform vec3 uSunColor;      // linear, includes intensity for the disc/glow
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uHazeColor;     // horizon haze / fog tint
uniform vec3 uSunGlow;       // warm glow color around the sun
uniform vec2 uWind;          // xz unit wind direction
uniform sampler2D uNoise;    // 256^2 tiling: r fbm, g cells, b fine, a low fbm
`;

export const NOISE_FNS = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec4 noiseT(vec2 uv) { return texture2D(uNoise, uv); }
`;

/**
 * Analytic sky: gradient + sun disc + glow + horizon haze. Used by the sky
 * (composite pass), fog color and water reflections so they always agree.
 */
export const SKY_FN = /* glsl */ `
vec3 skyColor(vec3 dir, float withSun) {
  float y = dir.y;
  float up = max(y, 0.0);
  // zenith gradient: quick falloff from the horizon band
  float t = 1.0 - pow(1.0 - up, 3.2);
  vec3 col = mix(uSkyHorizon, uSkyZenith, t);
  // thin bright haze band hugging the horizon
  float band = exp(-abs(y) * 14.0);
  col = mix(col, uHazeColor, band * 0.75);
  // warm glow toward the sun (broad + tight)
  float mu = max(dot(dir, uSunDir), 0.0);
  col += uSunGlow * (pow(mu, 6.0) * 0.35 + pow(mu, 64.0) * 0.6) * (0.4 + 0.6 * band + 0.3 * up);
  // below the horizon: sea haze, slightly darker and bluer
  if (y < 0.0) {
    col = mix(uHazeColor, uHazeColor * vec3(0.82, 0.9, 1.0), clamp(-y * 6.0, 0.0, 1.0));
  }
  if (withSun > 0.5) {
    float d = 1.0 - mu;
    float disc = smoothstep(0.00045, 0.00025, d);
    col += uSunColor * disc * 14.0;
    col += uSunColor * exp(-d * 900.0) * 0.8;
  }
  return col;
}
`;

/**
 * Fair-weather cumulus on a flat layer at uCloud.w meters: fbm coverage with
 * domain warp, lit by a two-tap look toward the sun, silver lining when
 * backlit, fading into the horizon haze. Returns premultiplied rgb + alpha.
 * Needs SKY_FN and NOISE_FNS.
 */
export const CLOUD_DENSITY_FN = /* glsl */ `
uniform vec4 uCloud; // x coverage 0..1, yz noise offset, w layer altitude (m)
float cloudDensity(vec2 p) {
  vec2 q = p * 0.000105 + uCloud.yz + uWind * uTime * 0.00006;
  vec2 w = vec2(noiseT(q * 0.5).a, noiseT(q * 0.5 + 0.43).a) - 0.5;
  q += w * 0.18;
  float n = noiseT(q).r * 0.6 + noiseT(q * 2.31 + 0.21).r * 0.26 + noiseT(q * 5.7 + 0.67).r * 0.14;
  float cov = mix(0.66, 0.44, uCloud.x);
  return smoothstep(cov, cov + 0.09, n) * (0.55 + 0.45 * smoothstep(cov + 0.05, cov + 0.25, n));
}
// fraction of direct sun reaching world point w through the cloud layer
float cloudShadow(vec3 w) {
  if (uCloud.x <= 0.0) return 1.0;
  vec2 p = w.xz + uSunDir.xz / max(uSunDir.y, 0.2) * (uCloud.w - w.y);
  return 1.0 - cloudDensity(p) * 0.55;
}
`;
export const CLOUD_FN = /* glsl */ `
${CLOUD_DENSITY_FN}
vec4 cloudLayer(vec3 ro, vec3 rd) {
  if (rd.y < 0.015 || uCloud.x <= 0.0) return vec4(0.0);
  float t = (uCloud.w - ro.y) / rd.y;
  vec2 p = ro.xz + rd.xz * t;
  float d = cloudDensity(p);
  if (d < 0.004) return vec4(0.0);
  vec2 sd = normalize(uSunDir.xz + vec2(1e-4)) * 380.0 / max(uSunDir.y + 0.25, 0.3);
  float d1 = cloudDensity(p + sd * 0.5), d2 = cloudDensity(p + sd);
  float shade = clamp(1.0 - (d1 * 0.5 + d2 * 0.5) * 0.7, 0.0, 1.0);
  vec3 dark = mix(uSkyHorizon * 0.8, vec3(0.52, 0.56, 0.66), 0.55);
  vec3 lit = vec3(1.02, 1.0, 0.97) * (0.8 + 0.3 * uSunColor);
  // thick cores read as grey undersides from below
  vec3 col = mix(dark, lit, (0.3 + 0.7 * shade) * (1.0 - d * 0.35 * rd.y));
  float mu = max(dot(rd, uSunDir), 0.0);
  col += uSunGlow * (pow(mu, 10.0) * 1.4 * (1.0 - d) + pow(mu, 3.0) * 0.2);
  // thin edges let the sky through; far clouds dissolve into haze
  float far = smoothstep(0.015, 0.22, rd.y);
  col = mix(skyColor(rd, 0.0), col, 0.35 + 0.65 * far);
  float a = clamp(d * 1.15, 0.0, 1.0) * mix(0.25, 1.0, far) * smoothstep(0.015, 0.06, rd.y);
  return vec4(col * a, a);
}
`;

/** Height-fog optical depth integrated along a ray (exponential falloff). */
export const FOG_FN = /* glsl */ `
uniform vec4 uFog; // x density at sea level, y height falloff, z min height, w start distance
float fogOpticalDepth(vec3 ro, vec3 rd, float dist) {
  float a = uFog.x, b = uFog.y;
  float h0 = max(ro.y - uFog.z, 0.0);
  float d = max(dist - uFog.w, 0.0);
  float k = rd.y * b;
  float base = a * exp(-b * h0);
  float od = abs(k) > 1e-4 ? base * (1.0 - exp(-k * d)) / k : base * d;
  return max(od, 0.0);
}
`;

/** Stylized lighting ramp used by patched toon materials (replaces the toon RE). */
export const STYLE_LIGHT_PARS = /* glsl */ `
varying vec3 vViewPosition;
struct ToonMaterial { vec3 diffuseColor; };
float gSpec = 0.0;      // specular strength for this fragment (paint, wet, glazing)
float gShine = 40.0;
float gWrap = 1.0;      // 1 = default soft terminator, 0 = harder
vec3 gTransl = vec3(0.0); // translucency color (leaves glowing when backlit)
void RE_Direct_Toon(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight) {
  float nl = dot(geometryNormal, directLight.direction);
  float lit = texture2D(gradientMap, vec2(nl * 0.5 + 0.5, 0.0)).r;
  reflectedLight.directDiffuse += lit * directLight.color * BRDF_Lambert(material.diffuseColor);
  // leaves: light bleeding through when backlit
  float back = max(dot(-geometryViewDir, directLight.direction), 0.0);
  reflectedLight.directDiffuse += gTransl * directLight.color * pow(back, 4.0) * 0.25 * max(-nl + 0.3, 0.0);
  if (gSpec > 0.0) {
    vec3 h = normalize(directLight.direction + geometryViewDir);
    // normalized Blinn-Phong (no toon threshold): broad and soft on wet sand, tight on glossy paint
    float s = pow(max(dot(geometryNormal, h), 0.0), gShine) * (gShine + 8.0) / 25.0;
    reflectedLight.directSpecular += directLight.color * s * gSpec * 0.25 * smoothstep(0.0, 0.2, nl);
  }
}
void RE_IndirectDiffuse_Toon(const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
}
#define RE_Direct RE_Direct_Toon
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
`;

/** Compact 2D rotation + wind helpers for instanced foliage. */
export const WIND_FN = /* glsl */ `
vec3 windOffset(vec3 worldBase, float sway, float flutter, float phase, float h) {
  float t = uTime;
  float gust = 0.55 + 0.45 * sin(t * 0.35 + dot(worldBase.xz, uWind) * 0.02);
  float s = sin(t * 1.3 + phase) * 0.6 + sin(t * 2.1 + phase * 1.7) * 0.25;
  vec3 dir = vec3(uWind.x, 0.0, uWind.y);
  vec3 off = dir * (sway * sway) * (0.35 * gust + 0.25 * s) * h;
  float f = sin(t * 7.0 + phase * 3.0 + worldBase.y) * flutter * 0.06 * (0.6 + gust);
  off += vec3(f, f * 0.6, -f * 0.5);
  return off;
}
`;
