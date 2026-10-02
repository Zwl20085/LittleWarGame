import unitsCsv from '../../docs/data/units.csv?raw';
import weaponsCsv from '../../docs/data/weapons.csv?raw';
import rulesJson from '../../docs/data/rules.json?raw';
import { buildGameData } from './loader';
import type { GameData } from './types';

/** docs/data is the machine-readable source of truth; loaded and validated at startup. */
export function loadGameData(): GameData {
  return buildGameData(unitsCsv, weaponsCsv, rulesJson);
}
