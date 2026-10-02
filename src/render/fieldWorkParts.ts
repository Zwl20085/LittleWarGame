import * as THREE from 'three';
import { GeoBuilder, trs } from './instancing';
import { TRENCH_X } from './trenchSweep';

/**
 * Instanced part geometries for linear field works (trenches, sandbag barricades). Local +x
 * runs along the work, +z toward the enemy, y up.
 */
const X = TRENCH_X;

const COL = {
  timber: new THREE.Color('#6a5842'),
  bag: new THREE.Color('#bba97e'),
  wire: new THREE.Color('#4b4740'),
  stake: new THREE.Color('#5a4c3a'),
  crate: new THREE.Color('#8a7350'),
  strap: new THREE.Color('#5d4c36'),
  pole: new THREE.Color('#4a4236'),
};
const BLACK = new THREE.Color(0, 0, 0);
const BOX = new THREE.BoxGeometry(1, 1, 1);

function bagGeo(): THREE.BufferGeometry {
  // Slightly pillowed sack: a box with the top face pinched in at the ends.
  const g = new THREE.BoxGeometry(1, 1, 1, 2, 1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    if (Math.abs(x) > 0.45) {
      p.setZ(i, p.getZ(i) * 0.82);
      if (y > 0) p.setY(i, y * 0.6);
    }
  }
  g.computeVertexNormals();
  const b = new GeoBuilder().add(g, new THREE.Matrix4(), COL.bag);
  g.dispose();
  return b.build();
}

function postGeo(): THREE.BufferGeometry {
  return new GeoBuilder().add(BOX, trs(0, X * 0.6, 0, 0, 0, 0, 0.28, X * 1.3, 0.28), COL.timber).build();
}

/** 5.2 m of concertina wire: tilted loops between two pickets. */
function wireGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const ring = new THREE.TorusGeometry(0.62, 0.035, 3, 12);
  for (let i = 0; i < 13; i++) {
    const x = -2.5 + i * 0.42;
    b.add(ring, trs(x, 0.62, 0, 0, Math.PI / 2 + (i % 2 ? 0.28 : -0.28), 0), COL.wire);
  }
  ring.dispose();
  for (const x of [-2.6, 2.6]) b.add(BOX, trs(x, 0.7, 0, 0, 0, (x > 0 ? -1 : 1) * 0.1, 0.1, 1.4, 0.1), COL.stake);
  return b.build();
}

function crateGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(BOX, trs(0, 0.5, 0, 0, 0, 0, 1.5, 1.0, 1.0), COL.crate);
  for (const x of [-0.45, 0.45]) b.add(BOX, trs(x, 0.5, 0, 0, 0, 0, 0.12, 1.04, 1.04), COL.strap);
  b.add(BOX, trs(0.2, 1.3, 0.1, 0, 0.5, 0, 1.0, 0.6, 0.7), COL.crate.clone().multiplyScalar(0.9));
  return b.build();
}

/** Pole and a small swallow-tail pennant; the cloth takes the faction colour (tint 1). */
function pennantGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 6), trs(0, 2.1, 0), COL.pole);
  b.add(BOX, trs(-0.75, 3.75, 0, 0, 0, 0, 1.5, 0.75, 0.05), BLACK, 1);
  return b.build();
}

export interface FieldWorkParts {
  readonly bag: THREE.BufferGeometry;
  readonly post: THREE.BufferGeometry;
  readonly wire: THREE.BufferGeometry;
  readonly crate: THREE.BufferGeometry;
  readonly pennant: THREE.BufferGeometry;
}

let parts: FieldWorkParts | null = null;

export function fieldWorkParts(): FieldWorkParts {
  parts ??= { bag: bagGeo(), post: postGeo(), wire: wireGeo(), crate: crateGeo(), pennant: pennantGeo() };
  return parts;
}
