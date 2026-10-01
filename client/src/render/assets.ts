// Texture assets (CC0 images under public/tex/, see public/tex/CREDITS.md).
//
// Every load goes through trackAsset() so the world view can report
// `loading` until the images are on the GPU (loading screens and the
// screenshot tools wait for that). A failed load resolves to a fallback and
// never blocks.
import * as THREE from "three";

let pending = 0;

/** Count a load as pending until it settles. */
export function trackAsset<T>(p: Promise<T>): Promise<T> {
  pending++;
  return p.finally(() => { pending--; });
}

/** Asset loads still in flight. */
export function assetsPending(): number {
  return pending;
}

/** URL of a file under public/tex/ (respects Vite's base). */
export function texUrl(path: string): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base}tex/${path}`;
}

/** Decode an image to RGBA pixels at size x size (null on failure). */
export async function loadPixels(url: string, size: number): Promise<Uint8ClampedArray | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const bmp = await createImageBitmap(await res.blob(), { resizeWidth: size, resizeHeight: size, resizeQuality: "high", colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const cv = new OffscreenCanvas(size, size);
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(bmp, 0, 0);
    bmp.close();
    return cx.getImageData(0, 0, size, size).data;
  } catch (e) {
    console.warn("[assets] failed to load", url, e);
    return null;
  }
}

export interface TextureArray {
  texture: THREE.DataArrayTexture;
  /** Mean color of each layer (sRGB-encoded 0..1, as stored), filled in when loaded. */
  mean: THREE.Vector3[];
  ready: Promise<void>;
}

/**
 * Load same-sized images into one mipmapped, repeating DataArrayTexture.
 * Until they arrive (or for a layer that fails) the layer is a flat
 * `fallback` color, so shaders can use it immediately.
 */
export function loadTextureArray(urls: string[], size: number, opts: { srgb: boolean; fallback: number[][]; anisotropy?: number }): TextureArray {
  const L = urls.length;
  const mk = (data: Uint8Array, s: number) => {
    const t = new THREE.DataArrayTexture(data, s, s, L);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = opts.anisotropy ?? 8;
    t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const flat = new Uint8Array(4 * L);
  for (let l = 0; l < L; l++) {
    const f = opts.fallback[l] ?? [128, 128, 128, 255];
    flat.set([f[0], f[1], f[2], f[3] ?? 255], l * 4);
  }
  const placeholder = mk(flat, 1);
  const mean = urls.map((_, l) => {
    const f = opts.fallback[l] ?? [128, 128, 128];
    return new THREE.Vector3(f[0] / 255, f[1] / 255, f[2] / 255);
  });
  const out: TextureArray = { texture: placeholder, mean, ready: Promise.resolve() };
  out.ready = trackAsset(
    Promise.all(urls.map((u) => loadPixels(u, size))).then((layers) => {
      const data = new Uint8Array(size * size * 4 * L);
      const per = size * size * 4;
      layers.forEach((px, l) => {
        if (px) {
          data.set(px, l * per);
          let r = 0, g = 0, b = 0;
          for (let i = 0; i < per; i += 64) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
          const n = per / 64;
          mean[l].set(r / n / 255, g / n / 255, b / n / 255);
        } else {
          const f = flat.subarray(l * 4, l * 4 + 4);
          for (let i = 0; i < per; i += 4) data.set(f, l * per + i);
        }
      });
      const t = mk(data, size);
      out.texture.dispose();
      out.texture = t;
    }),
  );
  return out;
}

/** A plain repeating 2D texture (sRGB color or linear data). */
export function loadTexture(path: string, opts: { srgb: boolean; anisotropy?: number }): { texture: THREE.Texture; ready: Promise<void> } {
  const tex = new THREE.Texture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = opts.anisotropy ?? 8;
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const ready = trackAsset(
    new THREE.ImageBitmapLoader()
      .setOptions({ imageOrientation: "none", colorSpaceConversion: "none", premultiplyAlpha: "none" })
      .loadAsync(texUrl(path))
      .then((bmp) => { tex.image = bmp; tex.needsUpdate = true; })
      .catch((e) => console.warn("[assets] failed to load", path, e)),
  );
  return { texture: tex, ready };
}
