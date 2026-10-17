import { musicEvent, setDoctrineTheme } from '../audio';
import type { CommandEnvelope, CommandOutcome } from '../sim/commands';
import { isCommander } from '../sim/formulas';
import type { World } from '../sim/world';

/** Seconds without contact before the score is told it is quiet (docs/MUSIC.md `quiet`). */
const QUIET_S = 60;
/** The theme follows the player's strongest enemy; re-checked this often (s). */
const THEME_EVERY_S = 60;

/**
 * 3.0 music wiring (docs/MUSIC.md API, V30_SPEC §1/§13), main-thread only (reads the mirror world):
 * - the doctrine theme is the player's strongest enemy's doctrine (nearest enemy capital at the
 *   start; then the strongest living enemy army, re-checked every minute) — in spectate, the doctrine
 *   of the faction in the player slot;
 * - `offensiveLaunched` when the player's general-offensive directive is accepted;
 * - `capitalLost` when the player's capital falls (the faction is eliminated);
 * - `quiet` once after 60 s without the player's units firing or being hit.
 */
export class MusicCues {
  private themeAt = -Infinity;
  private theme: string | null = null;
  private lastContact = 0;
  private quietSent = false;
  private wasAlive = true;
  private checkAt = 0;

  constructor(private readonly playerId: number, private readonly spectator: boolean, private readonly enabled: boolean) {}

  /** Bus result hook: an accepted offensive directive of the player launches the offensive cue. */
  onCommand(env: CommandEnvelope, out: CommandOutcome): void {
    if (!this.enabled || this.spectator || env.actor !== this.playerId || !out.ok) return;
    if (env.cmd.type === 'setDirective' && env.cmd.kind === 'offensive') musicEvent('offensiveLaunched');
  }

  /** Once a frame (cheap: the scans run once a game second). */
  update(w: World): void {
    if (!this.enabled || w.time < this.checkAt) return;
    this.checkAt = w.time + 1;
    if (w.time >= this.themeAt) {
      this.themeAt = w.time + THEME_EVERY_S;
      const id = this.themeDoctrine(w);
      if (id !== this.theme) {
        this.theme = id;
        setDoctrineTheme(id);
      }
    }
    if (this.spectator) return;
    const me = w.factions[this.playerId];
    if (!me) return;
    if (this.wasAlive && !me.alive) musicEvent('capitalLost');
    this.wasAlive = me.alive;
    if (!me.alive) return;
    if (this.inContact(w)) {
      this.lastContact = w.time;
      this.quietSent = false;
    } else if (!this.quietSent && w.time - this.lastContact >= QUIET_S) {
      this.quietSent = true;
      musicEvent('quiet');
    }
  }

  dispose(): void {
    if (this.enabled) setDoctrineTheme(null);
  }

  private themeDoctrine(w: World): string | null {
    if (this.spectator) return w.factions[this.playerId]?.doctrine ?? null;
    const army = new Map<number, number>();
    for (const u of w.aliveUnits) {
      if (u.hp <= 0 || u.fixed || u.owner === this.playerId || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
      army.set(u.owner, (army.get(u.owner) ?? 0) + u.def.costP + u.def.costM);
    }
    const hq = w.hqPos(this.playerId);
    let best: number | null = null;
    let bestKey = -Infinity;
    for (const f of w.factions) {
      if (!f.alive || f.id === this.playerId || !w.isHostile(this.playerId, f.id)) continue;
      // Strongest army; at the start (equal armies) the nearest capital wins the tie.
      const key = (army.get(f.id) ?? 0) - Math.hypot(w.hqPos(f.id).x - hq.x, w.hqPos(f.id).z - hq.z) * 1e-3;
      if (key > bestKey) { bestKey = key; best = f.id; }
    }
    return best === null ? null : w.factions[best].doctrine;
  }

  private inContact(w: World): boolean {
    for (const u of w.aliveUnits) {
      if (u.owner !== this.playerId || u.hp <= 0) continue;
      if (w.time - u.lastFiredAt < 2 || w.time - u.lastDamagedAt < 2) return true;
    }
    return false;
  }
}
