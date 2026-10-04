import type { World } from '../sim/world';
import { lang, t, unitShortName, weaponName } from './i18n';

export function factionLabel(world: World, f: number): string {
  const fac = world.factions[f];
  if (!fac) return '?';
  const city = world.map.cities[fac.cityIdx].name[lang()];
  return t('faction', { roman: fac.roman, city }) + (fac.isPlayer ? t('you') : '');
}

export function objectiveLabel(world: World, id: string): string {
  const o = world.objectives.find((x) => x.id === id);
  return o ? o.name[lang()] : id;
}

/** Translate a log/reason param bag into display strings. */
export function localizeParams(world: World, params: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = { ...params };
  if (typeof params.unit === 'string') out.unit = unitShortName(params.unit);
  if (typeof params.weapon === 'string') out.weapon = weaponName(params.weapon);
  if (typeof params.point === 'string') out.point = objectiveLabel(world, params.point);
  if (typeof params.into === 'string') out.into = objectiveLabel(world, params.into);
  if (typeof params.city === 'number') out.city = factionLabel(world, params.city);
  if (typeof params.f === 'number') out.f = factionLabel(world, params.f);
  if (typeof params.reason === 'string') out.reason = t(`reason.${params.reason}`);
  if (typeof params.feature === 'number') {
    const feat = (world.map.features ?? [])[params.feature];
    out.feature = feat ? feat.name[lang()] : t('feat.here');
  }
  if (typeof params.kind === 'string') out.kind = t(`feat.${params.kind}`);
  return out;
}

/** Display name of a front: the settlement it is named after, else "Front N". */
export function frontLabel(world: World, faction: number, frontId: number): string {
  const s = world.factions[faction]?.fronts.find((x) => x.id === frontId);
  if (!s) return t('front.none');
  return s.name ? t('front.named', { place: objectiveLabel(world, s.name) }) : t('front.numbered', { n: s.id + 1 });
}
