import type { GameContext } from './context';
import { EconomyPanel } from './economy';
import { EngineeringPanel } from './engineering';
import { h } from './dom';
import { onLangChange, t } from './i18n';
import { MinimapPanel } from './minimap';
import { ProductionBar } from './production';
import { DIRECTIVE_TONE, FrontsPanel } from './fronts';
import { frontLabel } from './labels';
import { SelectionPanel } from './selection';
import { TopBar } from './topbar';
import { TownPanel } from './town';
import { ZonePanel } from './zonePanel';
import { UpgradesPanel } from './upgrades';

/** Assembles the layered war-room HUD over the canvas and refreshes it at ~5 Hz. */
export class Hud {
  readonly root: HTMLElement;
  readonly top: TopBar;
  readonly fronts: FrontsPanel;
  readonly production: ProductionBar;
  readonly selection: SelectionPanel;
  readonly minimap: MinimapPanel;
  readonly economy: EconomyPanel;
  readonly engineering: EngineeringPanel;
  /** 2.2 town panel (stock, queue, economic buildings) for the place clicked on the map. */
  readonly town: TownPanel;
  /** 3.0 economic-zone panel (level, output, level-up) for the zone clicked on the map. */
  readonly zone: ZonePanel;
  /** 3.0 unit upgrades (research at the capital). */
  readonly upgrades: UpgradesPanel;
  private readonly toasts: HTMLElement;
  private readonly modeHint: HTMLElement;
  private readonly help: HTMLElement;
  private readonly hiddenHint: HTMLElement;
  private readonly pausedBadge: HTMLElement;
  private readonly offLang: () => void;

  constructor(parent: HTMLElement, private readonly ctx: GameContext) {
    this.engineering = new EngineeringPanel(ctx);
    this.economy = new EconomyPanel(ctx, () => this.engineering.toggle());
    this.town = new TownPanel(ctx);
    this.zone = new ZonePanel(ctx);
    this.upgrades = new UpgradesPanel(ctx);
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
      this.top.el, this.fronts.el, this.selection.el, this.economy.el, this.engineering.el, this.town.el, this.zone.el, this.upgrades.el, this.upgrades.button, this.help,
      h('div', { class: 'bottom-row' }, this.production.el, this.minimap.el),
      this.toasts, this.modeHint, this.pausedBadge, this.production.tip, this.fronts.briefing);
    parent.append(this.root, this.hiddenHint);
    this.offLang = onLangChange(() => this.relabel());
    // Map stamps on the standing order lines: "<front> · <order>".
    ctx.renderer.orderLines.label = (fid, id) => {
      const s = ctx.match.world.factions[fid]?.fronts.find((x) => x.id === id);
      return s ? `${frontLabel(ctx.match.world, fid, id)} · ${t(`order.${s.order.kind}`)}` : '';
    };
    ctx.renderer.orderLines.zoneLabel = (_fid, z) => t('zone.mapLabel', { n: z.id + 1 });
    // Panel heights are followed by a ResizeObserver instead of reading offsetHeight in every
    // 5 Hz refresh (each read forced a full layout right after the panels' DOM writes).
    if (typeof ResizeObserver !== 'undefined') {
      this.sizeObserver = new ResizeObserver(() => this.syncStackHeights());
      this.sizeObserver.observe(this.minimap.el);
      this.sizeObserver.observe(this.production.el);
    }
    this.refresh();
  }

  private readonly sizeObserver: ResizeObserver | null = null;

  /** Keep the selection dossier clear of the minimap stack and the orders column clear of the production bar. */
  private syncStackHeights(): void {
    const miniH = `${Math.ceil(this.minimap.el.offsetHeight)}px`;
    if (this.root.style.getPropertyValue('--mini-h') !== miniH) this.root.style.setProperty('--mini-h', miniH);
    const botH = `${Math.ceil(this.production.el.offsetHeight)}px`;
    if (this.root.style.getPropertyValue('--bottom-h') !== botH) this.root.style.setProperty('--bottom-h', botH);
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
    this.engineering.relabel();
    this.town.relabel();
    this.zone.relabel();
    this.upgrades.relabel();
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
    this.engineering.refresh();
    this.town.refresh();
    this.zone.refresh();
    this.upgrades.refresh();
    // Without ResizeObserver, measure here (forces a synchronous layout after the DOM writes).
    if (!this.sizeObserver) this.syncStackHeights();
    const m = this.ctx.mode;
    const hint = m.kind === 'attackMove' ? t('cmd.pickAttack') : m.kind === 'engineer' ? this.engineering.modeHint() : m.kind === 'placeZone' ? t('zone.pick') : this.fronts.modeHint();
    if (this.modeHint.textContent !== hint) this.modeHint.textContent = hint;
    this.modeHint.style.display = hint ? '' : 'none';
    this.modeHint.className = `mode-hint ${m.kind === 'directive' ? `order k-${DIRECTIVE_TONE[m.directive]}` : ''}`;
  }

  dispose(): void {
    this.sizeObserver?.disconnect();
    this.offLang();
    this.fronts.dispose();
    this.economy.dispose();
    this.engineering.dispose();
    this.zone.dispose();
    this.upgrades.dispose();
    this.ctx.renderer.orderLines.label = null;
    this.ctx.renderer.orderLines.zoneLabel = null;
    this.root.remove();
    this.hiddenHint.remove();
  }
}
