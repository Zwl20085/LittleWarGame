import * as THREE from 'three';

/** Procedural canvas textures for particles and ground decals (no external assets). */

function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function canvasTex(size: number, paint: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft additive glow (flashes, flames, sparks). */
export function radialTexture(): THREE.Texture {
  return canvasTex(64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,235,200,0.7)');
    grd.addColorStop(1, 'rgba(255,200,150,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  });
}

/** Lumpy smoke puff: overlapping soft blobs, masked to a soft round silhouette. */
export function smokeTexture(): THREE.Texture {
  return canvasTex(128, (g) => {
    const rnd = seeded(7);
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 22;
      const x = 64 + Math.cos(a) * d;
      const y = 64 + Math.sin(a) * d;
      const r = 18 + rnd() * 26;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const v = 225 + Math.round(rnd() * 30);
      grd.addColorStop(0, `rgba(${v},${v},${v},0.5)`);
      grd.addColorStop(0.6, `rgba(${v},${v},${v},0.22)`);
      grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    }
    // Keep the silhouette inside the quad (no hard square edges).
    g.globalCompositeOperation = 'destination-in';
    const mask = g.createRadialGradient(64, 64, 30, 64, 64, 63);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = mask;
    g.fillRect(0, 0, 128, 128);
  });
}

/** Shell crater: scorched pit, lighter thrown-out earth with spatter streaks and clods. */
export function craterTexture(): THREE.Texture {
  return canvasTex(128, (g) => {
    const rnd = seeded(91);
    const ejecta = g.createRadialGradient(64, 64, 18, 64, 64, 62);
    ejecta.addColorStop(0, 'rgba(92,76,54,0.55)');
    ejecta.addColorStop(0.5, 'rgba(104,88,62,0.32)');
    ejecta.addColorStop(1, 'rgba(110,94,66,0)');
    g.fillStyle = ejecta;
    g.fillRect(0, 0, 128, 128);
    for (let k = 0; k < 26; k++) {
      const a = rnd() * Math.PI * 2;
      const r0 = 20 + rnd() * 10;
      const r1 = 36 + rnd() * 24;
      g.strokeStyle = `rgba(70,56,40,${0.18 + rnd() * 0.2})`;
      g.lineWidth = 1.5 + rnd() * 3;
      g.beginPath();
      g.moveTo(64 + Math.cos(a) * r0, 64 + Math.sin(a) * r0);
      g.lineTo(64 + Math.cos(a) * r1, 64 + Math.sin(a) * r1);
      g.stroke();
    }
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2;
      const d = 22 + rnd() * 34;
      g.fillStyle = `rgba(${Math.round(60 + rnd() * 30)},${Math.round(48 + rnd() * 24)},${Math.round(34 + rnd() * 16)},${0.35 + rnd() * 0.35})`;
      g.beginPath();
      g.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 0.8 + rnd() * 2, 0, Math.PI * 2);
      g.fill();
    }
    const pit = g.createRadialGradient(62, 62, 0, 64, 64, 26);
    pit.addColorStop(0, 'rgba(28,22,16,0.92)');
    pit.addColorStop(0.65, 'rgba(44,35,25,0.85)');
    pit.addColorStop(0.85, 'rgba(70,58,42,0.6)');
    pit.addColorStop(1, 'rgba(70,58,42,0)');
    g.fillStyle = pit;
    g.beginPath();
    g.arc(64, 64, 26, 0, Math.PI * 2);
    g.fill();
  });
}

/** Shockwave ring: a thin bright band just inside the rim, fading inward (additive decal). */
export function shockTexture(): THREE.Texture {
  return canvasTex(128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 63);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.05)');
    grd.addColorStop(0.82, 'rgba(255,255,255,0.55)');
    grd.addColorStop(0.92, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  });
}
