import type { GameRenderer } from '../render/renderer';
import type { Command, CommandBus } from '../sim/commands';
import type { Match } from '../sim/sim';
import type { DirectiveKind } from '../sim/types';

export type InputMode =
  | { kind: 'normal' }
  | { kind: 'attackMove' }
  /**
   * 2.2: a directive was just issued and its optional place is being picked on the map:
   * click = axis (main effort / threatened place), drag (fortify) = a fortified line.
   */
  | { kind: 'directive'; directive: DirectiveKind };

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
  /** 3.0 camera modes (ui/cameraControls.ts); absent in attract mode. */
  camera?: { followFront(frontId: number): void };
}
