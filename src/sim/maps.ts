import type { CityDef, HillDef, MapDef, ObjectiveDef, RiverDef } from './mapdef';
import type { V2 } from './vec';

const p = (x: number, z: number): V2 => ({ x, z });

/** 1v1 gray-box per GAME_DESIGN §5.1.1 (灰石市—松溪市), mirrored left/right. */
function mirrorX(v: V2, w: number): V2 {
  return { x: w - v.x, z: v.z };
}

function westCity1v1(): CityDef {
  return {
    name: { zh: '灰石市', en: 'Greystone' },
    hq: p(120, 400),
    exit: p(170, 400),
    truck: p(320, 400),
    vanguard: [p(450, 340), p(450, 400), p(450, 460)],
    recon: p(440, 300),
    strongpoints: [
      { pos: p(200, 350), facingDeg: 0 },
      { pos: p(200, 450), facingDeg: 0 },
    ],
    forwardDeg: 0,
  };
}

function mirrorCity(c: CityDef, w: number, name: { zh: string; en: string }): CityDef {
  return {
    name,
    hq: mirrorX(c.hq, w),
    exit: mirrorX(c.exit, w),
    truck: mirrorX(c.truck, w),
    vanguard: c.vanguard.map((v) => mirrorX(v, w)),
    recon: mirrorX(c.recon, w),
    strongpoints: c.strongpoints.map((s) => ({ pos: mirrorX(s.pos, w), facingDeg: 180 - s.facingDeg })),
    forwardDeg: 180 - c.forwardDeg,
  };
}

export function map1v1(): MapDef {
  const W = 1200;
  const west = westCity1v1();
  const objectives: ObjectiveDef[] = [
    { id: 'obj_north', type: 'observation', pos: p(600, 180), name: { zh: '北岭观察所', en: 'North Ridge OP' } },
    { id: 'obj_center', type: 'industry', pos: p(600, 400), name: { zh: '工业村', en: 'Mill Village' } },
    { id: 'obj_south', type: 'manpower', pos: p(600, 620), name: { zh: '南林集结点', en: 'South Wood Depot' } },
  ];
  return {
    id: 'greystone_pinecreek',
    name: { zh: '灰石市—松溪市', en: 'Greystone – Pinecreek' },
    width: W,
    depth: 800,
    seed: 1931,
    baseHeight: 10,
    noiseAmp: 12,
    hills: [
      { x: 600, z: 180, r: 120, h: 70, plateau: 45 },
      { x: 330, z: 170, r: 90, h: 34 },
      { x: 870, z: 170, r: 90, h: 34 },
      { x: 340, z: 660, r: 80, h: 26 },
      { x: 860, z: 660, r: 80, h: 26 },
      { x: 600, z: 760, r: 120, h: 20 },
      { x: 120, z: 120, r: 110, h: 30 },
      { x: 1080, z: 120, r: 110, h: 30 },
      { x: 120, z: 700, r: 100, h: 24 },
      { x: 1080, z: 700, r: 100, h: 24 },
    ],
    ridges: [{ a: p(470, 95), b: p(730, 95), width: 55, h: 66 }],
    roads: [
      [p(120, 400), p(300, 400), p(450, 392), p(600, 400), p(750, 408), p(900, 400), p(1080, 400)],
      [p(300, 400), p(430, 290), p(520, 270), p(680, 270), p(770, 290), p(900, 400)],
      [p(300, 400), p(440, 530), p(600, 600), p(760, 530), p(900, 400)],
      [p(600, 400), p(600, 300)],
    ],
    forests: [
      { x: 600, z: 650, r: 85 },
      { x: 520, z: 700, r: 55 },
      { x: 680, z: 700, r: 55 },
      { x: 520, z: 470, r: 35 },
      { x: 680, z: 330, r: 35 },
      { x: 380, z: 250, r: 45 },
      { x: 820, z: 250, r: 45 },
      { x: 400, z: 560, r: 40 },
      { x: 800, z: 560, r: 40 },
    ],
    towns: [
      { x: 600, z: 400, r: 55, buildings: 14 },
      { x: 120, z: 400, r: 60, buildings: 16 },
      { x: 1080, z: 400, r: 60, buildings: 16 },
    ],
    mud: [{ x: 600, z: 520, r: 30 }],
    rivers: twinRivers(W, 800),
    cities: [west, mirrorCity(west, W, { zh: '松溪市', en: 'Pinecreek' })],
    objectives,
  };
}

/** Rotate around map centre by k*90° (W -> N -> E -> S). */
function rot(v: V2, k: number, size: number): V2 {
  let r = v;
  for (let i = 0; i < k; i++) r = { x: size - r.z, z: r.x };
  return r;
}

export function map4ffa(): MapDef {
  const S = 1600;
  const names = [
    { zh: '灰石市', en: 'Greystone' },
    { zh: '铁桥镇', en: 'Ironbridge' },
    { zh: '松溪市', en: 'Pinecreek' },
    { zh: '白杨堡', en: 'Aspenburg' },
  ];
  const base: CityDef = {
    name: names[0],
    hq: p(130, 800),
    exit: p(185, 800),
    truck: p(330, 800),
    vanguard: [p(470, 740), p(470, 800), p(470, 860)],
    recon: p(455, 700),
    strongpoints: [
      { pos: p(215, 745), facingDeg: 0 },
      { pos: p(215, 855), facingDeg: 0 },
    ],
    forwardDeg: 0,
  };
  const cities: CityDef[] = [0, 1, 2, 3].map((k) => ({
    name: names[k],
    hq: rot(base.hq, k, S),
    exit: rot(base.exit, k, S),
    truck: rot(base.truck, k, S),
    vanguard: base.vanguard.map((v) => rot(v, k, S)),
    recon: rot(base.recon, k, S),
    strongpoints: base.strongpoints.map((s) => ({ pos: rot(s.pos, k, S), facingDeg: s.facingDeg + 90 * k })),
    forwardDeg: base.forwardDeg + 90 * k,
  }));
  const objectives: ObjectiveDef[] = [
    { id: 'obj_center', type: 'observation', pos: p(800, 800), name: { zh: '中央高地', en: 'Central Heights' } },
    { id: 'obj_nw', type: 'manpower', pos: p(490, 490), name: { zh: '西北征兵站', en: 'NW Depot' } },
    { id: 'obj_ne', type: 'industry', pos: p(1110, 490), name: { zh: '东北工厂', en: 'NE Works' } },
    { id: 'obj_se', type: 'manpower', pos: p(1110, 1110), name: { zh: '东南征兵站', en: 'SE Depot' } },
    { id: 'obj_sw', type: 'industry', pos: p(490, 1110), name: { zh: '西南工厂', en: 'SW Works' } },
  ];
  const spoke = [p(130, 800), p(330, 800), p(560, 800), p(700, 800)];
  const toNw = [p(330, 800), p(390, 650), p(490, 490)];
  const toSw = [p(330, 800), p(390, 950), p(490, 1110)];
  const roads: V2[][] = [];
  for (let k = 0; k < 4; k++) {
    roads.push(spoke.map((v) => rot(v, k, S)));
    roads.push(toNw.map((v) => rot(v, k, S)));
    roads.push(toSw.map((v) => rot(v, k, S)));
  }
  roads.push([p(490, 490), p(800, 430), p(1110, 490), p(1170, 800), p(1110, 1110), p(800, 1170), p(490, 1110), p(430, 800), p(490, 490)]);

  const ridgeBase = { a: p(250, 560), b: p(560, 250), width: 55, h: 62 };
  const hillsBase = [
    { x: 300, z: 300, r: 110, h: 42 },
    { x: 640, z: 620, r: 70, h: 26 },
    { x: 120, z: 1100, r: 120, h: 34 },
  ];
  const hills: HillDef[] = [{ x: 800, z: 800, r: 170, h: 60, plateau: 42 }];
  const forests: { x: number; z: number; r: number }[] = [];
  const towns: { x: number; z: number; r: number; buildings: number }[] = [];
  for (let k = 0; k < 4; k++) {
    for (const h of hillsBase) {
      const c = rot(p(h.x, h.z), k, S);
      hills.push({ x: c.x, z: c.z, r: h.r, h: h.h });
    }
    const city = rot(base.hq, k, S);
    towns.push({ x: city.x, z: city.z, r: 60, buildings: 16 });
    for (const f of [p(600, 690), p(380, 960), p(380, 640), p(690, 400)]) {
      const c = rot(f, k, S);
      forests.push({ x: c.x, z: c.z, r: 45 });
    }
  }
  // Manpower depots sit in woods, industry works are villages.
  forests.push({ x: 490, z: 490, r: 80 }, { x: 1110, z: 1110, r: 80 });
  towns.push({ x: 1110, z: 490, r: 55, buildings: 13 }, { x: 490, z: 1110, r: 55, buildings: 13 });
  return {
    id: 'four_cities',
    name: { zh: '四城混战', en: 'Four Cities' },
    width: S,
    depth: S,
    seed: 1944,
    baseHeight: 10,
    noiseAmp: 13,
    hills,
    ridges: [0, 1, 2, 3].map((k) => ({ a: rot(ridgeBase.a, k, S), b: rot(ridgeBase.b, k, S), width: ridgeBase.width, h: ridgeBase.h })),
    roads,
    forests,
    towns,
    mud: [0, 1, 2, 3].map((k) => {
      const c = rot(p(650, 850), k, S);
      return { x: c.x, z: c.z, r: 22 };
    }),
    rivers: [ringRiver(S)],
    cities,
    objectives,
  };
}

/** Two mirrored meandering rivers between the cities and the centre (1v1). */
function twinRivers(w: number, depth: number): RiverDef[] {
  const west: V2[] = [];
  for (let z = -10; z <= depth + 10; z += 20) west.push(p(522 + 16 * Math.sin(z / 85), z));
  const east = west.map((v) => mirrorX(v, w));
  return [
    { points: west, width: 22, fords: [p(522 + 16 * Math.sin(150 / 85), 150), p(522 + 16 * Math.sin(720 / 85), 720)] },
    { points: east, width: 22, fords: [mirrorX(p(522 + 16 * Math.sin(150 / 85), 150), w), mirrorX(p(522 + 16 * Math.sin(720 / 85), 720), w)] },
  ];
}

/** A moat-like river ring around the central heights with diagonal fords (4-FFA). */
function ringRiver(size: number): RiverDef {
  const c = size / 2;
  const pts: V2[] = [];
  for (let k = 0; k <= 96; k++) {
    const a = (k / 96) * Math.PI * 2;
    const r = 275 + 18 * Math.sin(a * 6);
    pts.push(p(c + Math.cos(a) * r, c + Math.sin(a) * r));
  }
  const fords = [1, 3, 5, 7].map((k) => {
    const a = (k * Math.PI) / 4;
    const r = 275 + 18 * Math.sin(a * 6);
    return p(c + Math.cos(a) * r, c + Math.sin(a) * r);
  });
  return { points: pts, width: 24, fords };
}

export const MAPS = { greystone_pinecreek: map1v1, four_cities: map4ffa } as const;
export type MapId = keyof typeof MAPS;
