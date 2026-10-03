// Balance-lab overrides: `--set path=value` applied to the raw data text before it is parsed,
// so every experiment goes through the same loader/validation as the shipped game.
//
//   rules (default)   economy.cap_p=900            territory.income_m_per_min.town=20
//                     rules.morale.auto_retreat_hp_ratio=0.15   economy.allocation_default=[0.4,0.4,0.2]
//                     territory.income_p_per_min.**=0.6  (`*` = every key; here `.*` + `*=`)
//   units.csv         unit.infantry.cost_p=90      unit.*.build_seconds*=0.7   (`*` = every row)
//   weapons.csv       weapon.rifle.damage=40       weapon.*.damage*=1.2
//
// Operators: `=` sets, `*=` multiplies, `+=` adds (numbers only). Unknown paths are an error,
// so a typo can never silently produce a "no change" experiment.

export interface DataText {
  readonly units: string;
  readonly weapons: string;
  readonly rules: string;
}

export interface Override {
  readonly raw: string;
  readonly target: 'rules' | 'unit' | 'weapon';
  readonly path: readonly string[];
  readonly op: '=' | '*=' | '+=';
  readonly value: unknown;
}

// Non-greedy path so `a.b.**=0.5` reads as path `a.b.*`, operator `*=`.
const SET_RE = /^([A-Za-z0-9_.*-]+?)\s*(\*=|\+=|=)\s*(.+)$/;

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseOverride(raw: string): Override {
  const m = SET_RE.exec(raw.trim());
  if (!m) throw new Error(`--set "${raw}": expected path=value, path*=factor or path+=delta`);
  const segs = m[1].split('.');
  const op = m[2] as Override['op'];
  const value = parseValue(m[3].trim());
  if (op !== '=' && typeof value !== 'number') throw new Error(`--set "${raw}": ${op} needs a number`);
  if (segs[0] === 'unit' || segs[0] === 'weapon') {
    if (segs.length !== 3) throw new Error(`--set "${raw}": use ${segs[0]}.<id|*>.<column>`);
    return { raw, target: segs[0], path: segs.slice(1), op, value };
  }
  const path = segs[0] === 'rules' ? segs.slice(1) : segs;
  if (path.length === 0) throw new Error(`--set "${raw}": empty rules path`);
  return { raw, target: 'rules', path, op, value };
}

function combine(old: unknown, o: Override): unknown {
  if (o.op === '=') return typeof old === 'number' && typeof o.value === 'string' ? Number(o.value) : o.value;
  if (typeof old !== 'number') throw new Error(`--set "${o.raw}": current value is not a number`);
  const v = o.value as number;
  return o.op === '*=' ? old * v : old + v;
}

function setAt(node: Record<string, unknown>, path: readonly string[], o: Override, at: string): number {
  const [key, ...rest] = path;
  const keys = key === '*' ? Object.keys(node) : [key];
  let hits = 0;
  for (const k of keys) {
    if (!(k in node)) throw new Error(`--set "${o.raw}": no rules key "${at}${k}"`);
    if (rest.length === 0) {
      if (key === '*' && typeof node[k] !== 'number' && o.op !== '=') continue;
      node[k] = combine(node[k], o);
      hits++;
      continue;
    }
    const next = node[k];
    if (next === null || typeof next !== 'object') throw new Error(`--set "${o.raw}": no rules path "${at}${k}"`);
    hits += setAt(next as Record<string, unknown>, rest, o, `${at}${k}.`);
  }
  return hits;
}

/** Rules path; a `*` segment matches every key of that object (e.g. territory.income_m_per_min.*). */
function setRules(json: string, o: Override): string {
  const root = JSON.parse(json) as Record<string, unknown>;
  if (setAt(root, o.path, o, '') === 0) throw new Error(`--set "${o.raw}": matched nothing`);
  return JSON.stringify(root, null, 2);
}

function fmtCell(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

function setCsv(text: string, o: Override, table: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const header = lines[0].split(',').map((h) => h.trim());
  const [id, column] = o.path;
  const col = header.indexOf(column);
  if (col < 0) throw new Error(`--set "${o.raw}": ${table} has no column "${column}"`);
  let hits = 0;
  const out = lines.map((line, i) => {
    if (i === 0 || line.trim() === '') return line;
    const cells = line.split(',');
    if (id !== '*' && cells[0].trim() !== id) return line;
    const old = cells[col].trim();
    const oldVal: unknown = old === '' ? '' : Number.isFinite(Number(old)) ? Number(old) : old;
    // `*=` on a blank cell (e.g. no secondary weapon) leaves it blank.
    if (o.op !== '=' && oldVal === '') return line;
    cells[col] = fmtCell(combine(oldVal, o));
    hits++;
    return cells.join(',');
  });
  if (hits === 0) throw new Error(`--set "${o.raw}": ${table} has no row "${id}"`);
  return out.join('\n');
}

/** Apply overrides in order; returns new text (inputs are not modified). */
export function applyOverrides(data: DataText, overrides: readonly Override[]): DataText {
  let { units, weapons, rules } = data;
  for (const o of overrides) {
    if (o.target === 'rules') rules = setRules(rules, o);
    else if (o.target === 'unit') units = setCsv(units, o, 'units.csv');
    else weapons = setCsv(weapons, o, 'weapons.csv');
  }
  return { units, weapons, rules };
}
