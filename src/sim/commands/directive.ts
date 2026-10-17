import { DIRECTIVE_KINDS, DIRECTIVE_LINE_MIN_M, setDirective } from '../directive';
import { insisted } from '../compliance';
import { applyDirectiveNow } from '../theatre';
import type { Command, CommandOutcome } from '../commands';
import type { Match } from '../sim';
import type { Faction } from '../types';
import { dist, type V2 } from '../vec';
import { OK, fail, finiteV2 } from './shared';

export function applySetDirective(match: Match, f: Faction, c: Extract<Command, { type: 'setDirective' }>): CommandOutcome {
  const w = match.world;
  if (!DIRECTIVE_KINDS.includes(c.kind)) return fail('BAD_VALUE');
  if (c.force !== undefined && typeof c.force !== 'boolean') return fail('BAD_VALUE');
  if ((c.axis !== undefined && !finiteV2(c.axis)) || (c.line !== undefined && (!finiteV2(c.line?.a) || !finiteV2(c.line?.b)))) return fail('BAD_VALUE');
  if (c.line && c.kind !== 'fortify') return fail('LINE_ONLY_FORTIFY');
  const pts = [c.axis, c.line?.a, c.line?.b].filter((p): p is V2 => !!p);
  if (pts.some((p) => !w.terrain.inBounds(p.x, p.z))) return fail('OUT_OF_BOUNDS');
  // Infantry must be able to stand there (a point in a lake or on a cliff is no objective).
  const nav = w.nav(false, 35);
  const axis = c.axis ? nav.nearestPassable(c.axis, 80) : null;
  const la = c.line ? nav.nearestPassable(c.line.a, 30) : null;
  const lb = c.line ? nav.nearestPassable(c.line.b, 30) : null;
  if ((c.axis && !axis) || (c.line && (!la || !lb))) return fail('UNREACHABLE');
  if (la && lb && dist(la, lb) < DIRECTIVE_LINE_MIN_M) return fail('LINE_SHORT');
  const line = la && lb ? { a: { ...la }, b: { ...lb } } : null;
  const forced = insisted(w, f, { kind: c.kind, axis, line }, c.force);
  setDirective(w, f, c.kind, axis ? { ...axis } : null, line, true, forced);
  applyDirectiveNow(w, f);
  return OK;
}

export function applyCancelZone(f: Faction, c: Extract<Command, { type: 'cancelZone' }>): CommandOutcome {
  const z = f.zones.find((x) => x.id === c.zoneId && !x.cancelled);
  if (!z) return fail('NO_ORDER');
  z.cancelled = true;
  return OK;
}
