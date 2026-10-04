import type { GameRenderer } from '../render/renderer';
import type { Command, CommandBus } from '../sim/commands';
import type { Match } from '../sim/sim';
import type { OrderKind } from '../sim/types';

export type InputMode =
  | { kind: 'normal' }
  | { kind: 'attackMove' }
  /** Supreme-HQ order being placed on the map (click = point; the UI may extend to drag = line). */
  | { kind: 'frontOrder'; frontId: number | null; order: OrderKind };

/** Shared state between the loop, input handling and HUD panels. */
export interface GameContext {
  readonly match: Match;
  readonly bus: CommandBus;
  readonly renderer: GameRenderer;
  readonly playerId: number;
  readonly spectator: boolean;
  speed: number;
  paused: boolean;
  mode: InputMode;
  hudHidden: boolean;
  issue(cmd: Command): void;
  toast(text: string, severity?: 'info' | 'warn' | 'alert'): void;
  openPanel: string | null;
}
