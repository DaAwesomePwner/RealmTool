import { el } from './dom.ts';

export interface TabDef { id: string; label: string; panel: HTMLElement }
interface Tab { tab: HTMLButtonElement; badge: HTMLElement; panel: HTMLElement }

/** ARIA tablist whose panels share the remaining window height; each panel scrolls on its own. */
export class Tabs {
  readonly element = el('div', undefined, 'tabs');
  private readonly list = el('div', undefined, 'tab-list');
  private readonly tabs = new Map<string, Tab>();
  active: string;
  onSelect: (id: string) => void = () => {};

  constructor(defs: TabDef[], initial?: string) {
    this.list.setAttribute('role', 'tablist');
    const panels = el('div', undefined, 'tab-panels');
    for (const { id, label, panel } of defs) {
      const tab = el('button', undefined, 'tab'); tab.type = 'button'; tab.id = `tab-${id}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `panel-${id}`);
      const badge = el('span', '', 'tab-badge'); badge.hidden = true;
      tab.append(el('span', label), badge);
      tab.addEventListener('click', () => this.select(id));
      tab.addEventListener('keydown', event => this.key(event, id));
      panel.id = `panel-${id}`; panel.classList.add('tab-panel');
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
      this.list.append(tab); panels.append(panel); this.tabs.set(id, { tab, badge, panel });
    }
    this.element.append(this.list, panels);
    this.active = initial && this.tabs.has(initial) ? initial : defs[0].id;
    this.render();
  }

  select(id: string, focus = false): void {
    if (!this.tabs.has(id)) return;
    this.active = id; this.render();
    if (focus) this.tabs.get(id)!.tab.focus();
    this.onSelect(id);
  }

  /** Shows a short marker on a tab; an empty string hides it. */
  badge(id: string, text: string, label = text): void {
    const badge = this.tabs.get(id)?.badge;
    if (!badge) return;
    badge.textContent = text; badge.hidden = !text;
    if (text) badge.setAttribute('aria-label', label); else badge.removeAttribute('aria-label');
  }

  private render(): void {
    for (const [id, { tab, panel }] of this.tabs) {
      const selected = id === this.active;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    }
  }

  private key(event: KeyboardEvent, id: string): void {
    const ids = [...this.tabs.keys()], index = ids.indexOf(id);
    const target = event.key === 'ArrowRight' ? ids[(index + 1) % ids.length]
      : event.key === 'ArrowLeft' ? ids[(index - 1 + ids.length) % ids.length]
      : event.key === 'Home' ? ids[0] : event.key === 'End' ? ids[ids.length - 1] : undefined;
    if (!target) return;
    event.preventDefault(); this.select(target, true);
  }
}
