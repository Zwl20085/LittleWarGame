import type { GameContext } from './context';
import { EconomyPanel } from './economy';
import { h } from './dom';
import { onLangChange, t } from './i18n';
import { MinimapPanel } from './minimap';
import { ProductionBar } from './production';
import { FrontsPanel } from './fronts';
import { frontLabel } from './labels';
import { SelectionPanel } from './selection';
import { TopBar } from './topbar';

/** Assembles the layered war-room HUD over the canvas and refreshes it at ~5 Hz. */
export class Hud {
  readonly root: HTMLElement;
  readonly top: TopBar;
  readonly fronts: FrontsPanel;
  readonly production: ProductionBar;
  readonly selection: SelectionPanel;
  readonly minimap: MinimapPanel;
  readonly economy: EconomyPanel;
  private readonly toasts: HTMLElement;
  private readonly modeHint: HTMLElement;
  private readonly help: HTMLElement;
  private readonly hiddenHint: HTMLElement;
  private readonly pausedBadge: HTMLElement;
  private readonly offLang: () => void;

  constructor(parent: HTMLElement, private readonly ctx: GameContext) {
    this.economy = new EconomyPanel(ctx);
    this.help = h('div', { class: 'help panel paper-stack' });
    this.help.style.display = 'none';
    this.top = new TopBar(ctx, () => this.economy.toggle(), () => this.toggleHelp());
    this.fronts = new FrontsPanel(ctx);
    this.production = new ProductionBar(ctx);
    this.selection = new SelectionPanel(ctx);
    this.minimap = new MinimapPanel(ctx);
    this.toasts = h('div', { class: 'toasts' });
    this.modeHint = h('div', { class: 'mode-hint' });
    this.hiddenHint = h('div', { class: 'hidden-hint' }, t('hud.hideHint'));
    this.pausedBadge = h('div', { class: 'paused-badge' }, t('hud.paused'));
    this.root = h('div', { class: 'hud' },
      this.top.el, this.fronts.el, this.selection.el, this.economy.el, this.help,
      h('div', { class: 'bottom-row' }, this.production.el, this.minimap.el),
      this.toasts, this.modeHint, this.pausedBadge, this.production.tip, this.fronts.briefing);
    parent.append(this.root, this.hiddenHint);
    this.offLang = onLangChange(() => this.relabel());
    // Map stamps on the standing order lines: "<front> · <order>".
    ctx.renderer.orderLines.label = (fid, id) => {
      const s = ctx.match.world.factions[fid]?.fronts.find((x) => x.id === id);
      return s ? `${frontLabel(ctx.match.world, fid, id)} · ${t(`order.${s.order.kind}`)}` : '';
    };
    this.refresh();
  }

  private toggleHelp(): void {
    this.help.textContent = t('help.body');
    this.help.style.display = this.help.style.display === 'none' ? '' : 'none';
  }

  private relabel(): void {
    this.top.relabel();
    this.fronts.relabel();
    this.production.relabel();
    this.selection.relabel();
    this.minimap.relabel();
    this.economy.relabel();
    this.hiddenHint.textContent = t('hud.hideHint');
    this.pausedBadge.textContent = t('hud.paused');
    if (this.help.style.display !== 'none') this.help.textContent = t('help.body');
    this.refresh();
  }

  toast(text: string, severity: 'info' | 'warn' | 'alert' = 'info'): void {
    const el = h('div', { class: `toast ${severity}` }, text);
    this.toasts.append(el);
    setTimeout(() => el.classList.add('out'), 2200);
    setTimeout(() => el.remove(), 2600);
    while (this.toasts.childElementCount > 4) this.toasts.firstElementChild?.remove();
  }

  refresh(): void {
    this.root.style.display = this.ctx.hudHidden ? 'none' : '';
    this.hiddenHint.style.display = this.ctx.hudHidden ? '' : 'none';
    // The pause menu carries its own stamp; only show the HUD badge for a plain (Space) pause.
    this.pausedBadge.style.display = this.ctx.paused && !document.querySelector('.pause-menu, .pause') ? '' : 'none';
    this.top.refresh();
    this.fronts.refresh();
    this.production.refresh();
    this.selection.refresh();
    this.minimap.refresh();
    this.economy.refresh();
    // Keep the selection dossier clear of the minimap stack.
    const miniH = `${Math.ceil(this.minimap.el.offsetHeight)}px`;
    if (this.root.style.getPropertyValue('--mini-h') !== miniH) this.root.style.setProperty('--mini-h', miniH);
    // Keep the orders column clear of the production bar.
    const botH = `${Math.ceil(this.production.el.offsetHeight)}px`;
    if (this.root.style.getPropertyValue('--bottom-h') !== botH) this.root.style.setProperty('--bottom-h', botH);
    const m = this.ctx.mode;
    const hint = m.kind === 'attackMove' ? t('cmd.pickAttack') : this.fronts.modeHint();
    if (this.modeHint.textContent !== hint) this.modeHint.textContent = hint;
    this.modeHint.style.display = hint ? '' : 'none';
    this.modeHint.className = `mode-hint ${m.kind === 'frontOrder' ? `order k-${m.order}` : ''}`;
  }

  dispose(): void {
    this.offLang();
    this.ctx.renderer.orderLines.label = null;
    this.root.remove();
    this.hiddenHint.remove();
  }
}
