// Name tag sprite: a rounded cream pill with a color dot and the player name.
// Constant screen size (sizeAttenuation off). Position it at blob.getTagAnchor().
// HUDs that prefer DOM can skip this and project getTagAnchor() themselves.
import * as THREE from "three";

export interface NameTag {
  readonly sprite: THREE.Sprite;
  setName(name: string): void;
  setColor(color: THREE.ColorRepresentation): void;
  /** Place above the anchor; hides when `visible` false. */
  update(anchor: THREE.Vector3, visible?: boolean): void;
  dispose(): void;
}

export function createNameTag(name: string, color: THREE.ColorRepresentation, opts: { height?: number } = {}): NameTag {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10;
  sprite.center.set(0.5, 0);
  const H = opts.height ?? 0.034;
  let label = name;
  const col = new THREE.Color(color);

  function draw(): void {
    const dpr = 2;
    const font = `700 ${22 * dpr}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
    ctx.font = font;
    const tw = ctx.measureText(label).width;
    const h = 36 * dpr, pad = 12 * dpr, dot = 12 * dpr;
    const w = Math.ceil(tw + pad * 2 + dot + 8 * dpr);
    canvas.width = w;
    canvas.height = h + 8 * dpr;
    ctx.font = font;
    const r = h / 2;
    ctx.fillStyle = "rgba(255, 248, 235, 0.92)";
    ctx.strokeStyle = "#" + col.getHexString();
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.roundRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth, r);
    ctx.fill();
    ctx.stroke();
    // little pointer
    ctx.fillStyle = "#" + col.getHexString();
    ctx.beginPath();
    ctx.moveTo(w / 2 - 6 * dpr, h - 1);
    ctx.lineTo(w / 2 + 6 * dpr, h - 1);
    ctx.lineTo(w / 2, h + 7 * dpr);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pad + dot / 2, h / 2 + 1, dot / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#5a3a2a";
    ctx.textBaseline = "middle";
    ctx.fillText(label, pad + dot + 8 * dpr, h / 2 + 2);
    tex.needsUpdate = true;
    sprite.scale.set((H * canvas.width) / canvas.height, H, 1);
  }
  draw();
  return {
    sprite,
    setName(n) { label = n; draw(); },
    setColor(c) { col.set(c); draw(); },
    update(anchor, visible = true) {
      sprite.visible = visible;
      sprite.position.copy(anchor);
    },
    dispose() {
      sprite.removeFromParent();
      tex.dispose();
      mat.dispose();
    },
  };
}
