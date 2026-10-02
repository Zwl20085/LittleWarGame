import type { Rng } from './rng';

/** Fictional place names (no real geography). zh and en are generated as parallel pairs. */
const ZH_A = ['灰', '松', '白', '铁', '石', '鹰', '橡', '柳', '黑', '红', '青', '金', '银', '雪', '风', '霜', '桦', '枫', '狼', '鹿'];
const ZH_B = ['溪', '岭', '原', '堡', '谷', '桥', '山', '湾', '林', '岗', '庄', '坡', '泉', '川', '台'];
const EN_A = ['Grey', 'Pine', 'White', 'Iron', 'Stone', 'Hawk', 'Oak', 'Willow', 'Black', 'Red', 'Green', 'Gold', 'Silver', 'Snow', 'Wind', 'Frost', 'Birch', 'Maple', 'Wolf', 'Deer'];
const EN_B = ['brook', 'ridge', 'field', 'burg', 'dale', 'bridge', 'hill', 'bay', 'wood', 'crest', 'stead', 'slope', 'well', 'ford', 'mount'];

export interface PlaceName {
  readonly zh: string;
  readonly en: string;
}

export class NameGen {
  private readonly used = new Set<string>();
  constructor(private readonly rng: Rng) {}

  private base(): PlaceName {
    for (let tries = 0; tries < 50; tries++) {
      const a = Math.floor(this.rng.next() * ZH_A.length);
      const b = Math.floor(this.rng.next() * ZH_B.length);
      const key = `${a}-${b}`;
      if (this.used.has(key)) continue;
      this.used.add(key);
      return { zh: ZH_A[a] + ZH_B[b], en: EN_A[a] + EN_B[b] };
    }
    const n = this.used.size;
    return { zh: `第${n}地`, en: `Place ${n}` };
  }

  city(): PlaceName {
    const b = this.base();
    return { zh: `${b.zh}市`, en: b.en };
  }
  town(big: boolean): PlaceName {
    const b = this.base();
    return big ? { zh: `${b.zh}镇`, en: `${b.en}` } : { zh: `${b.zh}村`, en: `${b.en}` };
  }
  mountain(): PlaceName {
    const b = this.base();
    return { zh: `${b.zh}山脉`, en: `${b.en} Range` };
  }
  hill(): PlaceName {
    const b = this.base();
    return { zh: `${b.zh}高地`, en: `${b.en} Heights` };
  }
  river(): PlaceName {
    const b = this.base();
    return { zh: `${b.zh}河`, en: `${b.en} River` };
  }
  forest(): PlaceName {
    const b = this.base();
    return { zh: `${b.zh}林`, en: `${b.en} Forest` };
  }
  pass(): PlaceName {
    const b = this.base();
    return { zh: `${b.zh}隘口`, en: `${b.en} Pass` };
  }
}
