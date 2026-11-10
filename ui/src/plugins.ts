import type { PluginSnapshot } from '../../src/plugins/snapshot.ts';
import type { ApiClient } from './api.ts';
import { el, message } from './dom.ts';
import { renderStatus } from './pluginStatus.ts';
import { SettingsView } from './settings.ts';

interface Card {
  element: HTMLElement; item: HTMLElement; link: HTMLButtonElement; state: HTMLElement;
  /** The list switch and the detail switch; both always go through `setEnabled`. */
  toggles: HTMLInputElement[]; error: HTMLElement; listError: HTMLElement; failure: HTMLElement;
  status: HTMLElement; settings: SettingsView; signature: string; pending: boolean;
}

/** Real switch styling for an enable checkbox. */
function enableSwitch(name: string, className: string): HTMLInputElement {
  const toggle = el('input', undefined, `switch ${className}`); toggle.type = 'checkbox';
  toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `Enable ${name}`);
  return toggle;
}

/** Plugin list beside the selected plugin's card; unselected cards stay mounted but hidden. */
export class PluginCards {
  readonly element = el('section', undefined, 'plugins');
  private readonly nav = el('nav', undefined, 'plugin-nav');
  private readonly detail = el('div', undefined, 'plugin-detail');
  private readonly cards = new Map<string, Card>();
  private selected?: string;
  private readonly api: Pick<ApiClient, 'get' | 'post'>;
  private readonly changed: () => void;
  private snapshots: PluginSnapshot[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(api: Pick<ApiClient, 'get' | 'post'>, changed: () => void) {
    this.api = api; this.changed = changed;
    this.element.setAttribute('aria-label', 'Plugins');
    this.nav.setAttribute('aria-label', 'Plugin list');
    this.element.append(this.nav, this.detail);
  }

  update(snapshots: PluginSnapshot[]): void {
    this.snapshots = snapshots;
    this.detail.querySelector('.empty')?.remove();
    for (const [id, card] of this.cards) {
      if (!snapshots.some(p => p.id === id)) this.remove(id, card);
    }
    if (!snapshots.length) this.detail.append(el('p', 'Start the proxy to view and edit plugin settings', 'empty'));
    this.nav.hidden = !snapshots.length;
    for (const plugin of snapshots) {
      const signature = JSON.stringify(plugin.settings.map(({ value: _value, ...def }) => def));
      let card = this.cards.get(plugin.id);
      if (card && card.signature !== signature) { this.remove(plugin.id, card); card = undefined; }
      if (!card) {
        card = this.create(plugin, signature);
        this.cards.set(plugin.id, card);
      }
      // Re-appending keeps both lists in snapshot order; existing nodes simply move.
      this.nav.append(card.item); this.detail.append(card.element);
      const state = plugin.failed ? 'failed' : plugin.enabled ? 'on' : 'off';
      card.item.dataset.state = card.link.dataset.state = state;
      card.state.textContent = plugin.failed ? 'Failed' : '';
      card.failure.textContent = plugin.failed ?? ''; card.failure.hidden = !plugin.failed;
      this.sync(plugin.id, card);
      card.settings.update(plugin, snapshots);
      renderStatus(card.status, plugin.data);
    }
    // An empty update (proxy stopped, profile switch) keeps the choice for when plugins return.
    if (snapshots.length) this.select(this.selected !== undefined && this.cards.has(this.selected) ? this.selected : snapshots[0].id);
  }

  select(id: string): void {
    this.selected = id;
    for (const [cardId, card] of this.cards) {
      const selected = cardId === id;
      card.element.hidden = !selected;
      if (selected) card.link.setAttribute('aria-current', 'true'); else card.link.removeAttribute('aria-current');
    }
  }

  private remove(id: string, card: Card): void {
    card.settings.dispose(); card.element.remove(); card.item.remove(); this.cards.delete(id);
  }

  data(pluginId: string, type: string, data: unknown): void {
    const plugin = this.snapshots.find(p => p.id === pluginId);
    if (!plugin) return;
    const key = pluginId === 'chat-filter' && type === 'chatFilterStatus' ? 'status' : type;
    plugin.data = { ...plugin.data, [key]: data };
    const card = this.cards.get(pluginId);
    if (card) renderStatus(card.status, plugin.data);
  }

  /** Both switches show the last known server value and stay disabled while a change is in flight or the plugin failed. */
  private sync(id: string, card: Card): void {
    const plugin = this.snapshots.find(p => p.id === id);
    for (const toggle of card.toggles) {
      if (!card.pending) toggle.checked = plugin?.enabled ?? false;
      toggle.disabled = card.pending || !!plugin?.failed;
    }
  }

  private async setEnabled(id: string, card: Card, enabled: boolean): Promise<void> {
    if (card.pending) return;
    card.pending = true;
    for (const toggle of card.toggles) toggle.checked = enabled;
    this.sync(id, card);
    card.error.textContent = card.listError.textContent = '';
    try {
      await this.track(async () => {
        await this.api.post(`/api/plugins/${encodeURIComponent(id)}/enabled`, { enabled });
        this.update(await this.api.get<PluginSnapshot[]>('/api/plugins'));
      });
      this.changed();
    } catch (failure) {
      const current = this.cards.get(id) ?? card;
      current.error.textContent = current.listError.textContent = message(failure);
    } finally { card.pending = false; this.sync(id, card); }
  }

  private create(plugin: PluginSnapshot, signature: string): Card {
    const element = el('article', undefined, 'plugin-card');
    const header = el('header', undefined, 'card-heading');
    const label = el('label', 'Enabled', 'toggle'); const toggle = enableSwitch(plugin.name, 'plugin-toggle'); label.append(toggle);
    header.append(el('h2', plugin.name), el('span', plugin.category, 'tag'), label);
    const failure = el('p', '', 'error'); failure.setAttribute('role', 'alert');
    // The list row announces enable failures (it is always visible); this copy explains them in the detail pane.
    const error = el('p', '', 'error');
    const settings = new SettingsView(plugin, this.snapshots, (key, value) => this.track(async () => {
      await this.api.post(`/api/plugins/${encodeURIComponent(plugin.id)}/settings/${encodeURIComponent(key)}`, { value });
      const snapshots = await this.api.get<PluginSnapshot[]>('/api/plugins');
      this.update(snapshots);
      const current = snapshots.find(p => p.id === plugin.id);
      if (!current) throw new Error('Proxy is stopped');
      return current.settings;
    }));
    const status = el('div', undefined, 'plugin-status');
    element.append(header, failure, error, settings.element, status);
    // Select button and switch are siblings: neither interactive element is nested in the other.
    const item = el('div', undefined, 'plugin-item');
    const link = el('button', undefined, 'plugin-link'); link.type = 'button';
    const state = el('span', '', 'plugin-state');
    link.append(el('span', plugin.name, 'plugin-link-name'), state);
    link.addEventListener('click', () => this.select(plugin.id));
    const listToggle = enableSwitch(plugin.name, 'plugin-list-toggle');
    const listError = el('p', '', 'error plugin-item-error'); listError.setAttribute('role', 'alert');
    item.append(link, listToggle, listError);
    const card: Card = { element, item, link, state, toggles: [listToggle, toggle], error, listError, failure, settings, status, signature, pending: false };
    for (const control of card.toggles) control.addEventListener('change', () => void this.setEnabled(plugin.id, card, control.checked));
    return card;
  }

  cancelDrafts(): void { for (const card of this.cards.values()) card.settings.cancelDrafts(); }
  async beforeProfileSwitch(): Promise<void> {
    this.element.inert = true;
    this.cancelDrafts();
    await Promise.allSettled([...this.pending]);
  }
  private async track<T>(action: () => Promise<T>): Promise<T> {
    const task = action(); this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }
  dispose(): void { for (const card of this.cards.values()) card.settings.dispose(); }
}
