/** Minimal CSV parser for the seed tables (no quoted commas are used in docs/data). */
export type CsvRow = Record<string, string> & { __line: string };

export function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV is empty');
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line, i) => {
    const cells = line.split(',');
    if (cells.length !== header.length) {
      throw new Error(`CSV line ${i + 2}: expected ${header.length} cells, got ${cells.length}`);
    }
    const row: Record<string, string> = { __line: String(i + 2) };
    header.forEach((h, idx) => (row[h] = cells[idx].trim()));
    return row as CsvRow;
  });
}

export function num(row: CsvRow, field: string): number {
  const raw = row[field];
  if (raw === undefined || raw === '') {
    throw new Error(`line ${row.__line}: field "${field}" is missing`);
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`line ${row.__line}: field "${field}" is not a number ("${raw}")`);
  return v;
}

export function bool(row: CsvRow, field: string): boolean {
  const raw = row[field];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`line ${row.__line}: field "${field}" must be true/false ("${raw}")`);
}
