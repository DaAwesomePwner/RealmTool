import type { PluginSnapshot } from '../../src/plugins/snapshot.ts';
import type { ApiClient } from './api.ts';
import { el, message, textValue } from './dom.ts';
import { SettingsView } from './settings.ts';

interface Card {
  element: HTMLElement; link: HTMLButtonElement; state: HTMLElement; toggle: HTMLInputElement; error: HTMLElement; failure: HTMLElement;
  status: HTMLElement; settings: SettingsView; signature: string;
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
      this.nav.append(card.link); this.detail.append(card.element);
      card.toggle.checked = plugin.enabled; card.toggle.disabled = !!plugin.failed;
      card.state.textContent = plugin.failed ? 'Failed' : plugin.enabled ? 'On' : 'Off';
      card.link.dataset.state = plugin.failed ? 'failed' : plugin.enabled ? 'on' : 'off';
      card.failure.textContent = plugin.failed ?? ''; card.failure.hidden = !plugin.failed;
      card.settings.update(plugin, snapshots);
      this.renderStatus(card.status, plugin.data);
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
    card.settings.dispose(); card.element.remove(); card.link.remove(); this.cards.delete(id);
  }

  data(pluginId: string, type: string, data: unknown): void {
    const plugin = this.snapshots.find(p => p.id === pluginId);
    if (!plugin) return;
    const key = pluginId === 'chat-filter' && type === 'chatFilterStatus' ? 'status' : type;
    plugin.data = { ...plugin.data, [key]: data };
    const card = this.cards.get(pluginId);
    if (card) this.renderStatus(card.status, plugin.data);
  }

  private create(plugin: PluginSnapshot, signature: string): Card {
    const element = el('article', undefined, 'plugin-card');
    const header = el('header', undefined, 'card-heading');
    const name = el('div'); name.append(el('h2', plugin.name), el('p', plugin.category, 'muted'));
    const label = el('label', 'Enabled', 'toggle'); const toggle = el('input'); toggle.type = 'checkbox';
    toggle.setAttribute('aria-label', `Enable ${plugin.name}`); label.append(toggle); header.append(name, label);
    const failure = el('p', '', 'error'); failure.setAttribute('role', 'alert');
    const error = el('p', '', 'error'); error.setAttribute('role', 'alert');
    toggle.addEventListener('change', async () => {
      toggle.disabled = true; error.textContent = '';
      try {
        await this.track(async () => {
          await this.api.post(`/api/plugins/${encodeURIComponent(plugin.id)}/enabled`, { enabled: toggle.checked });
          this.update(await this.api.get<PluginSnapshot[]>('/api/plugins'));
        });
        this.changed();
      } catch (failure) {
        error.textContent = message(failure);
        toggle.checked = this.snapshots.find(p => p.id === plugin.id)?.enabled ?? false;
      } finally { toggle.disabled = !!this.snapshots.find(p => p.id === plugin.id)?.failed; }
    });
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
    const link = el('button', undefined, 'plugin-link'); link.type = 'button';
    const state = el('span', '', 'plugin-state');
    link.append(el('span', plugin.name, 'plugin-link-name'), state);
    link.addEventListener('click', () => this.select(plugin.id));
    return { element, link, state, toggle, error, failure, settings, status, signature };
  }

  private renderStatus(target: HTMLElement, data: Record<string, unknown>): void {
    target.replaceChildren();
    let recent: unknown;
    if (data.status !== undefined) {
      target.append(el('h3', 'Status'));
      if (data.status && typeof data.status === 'object' && !Array.isArray(data.status)) {
        const list = el('dl');
        for (const [key, value] of Object.entries(data.status)) {
          if (key === 'recent') { recent = value; continue; }
          list.append(el('dt', key), el('dd', textValue(value)));
        }
        target.append(list);
      } else target.append(el('p', textValue(data.status)));
    }
    if (Array.isArray(recent)) {
      const details = el('details'); details.append(el('summary', 'Recent messages'));
      const list = el('ul');
      for (const item of recent) {
        if (!item || typeof item !== 'object') continue;
        const parts = [item.sender, item.channel, item.verdict, item.reason]
          .filter((value): value is string => typeof value === 'string' && value.length > 0);
        const row = el('li', parts.join(' · '));
        if (typeof item.message === 'string') row.append(el('p', item.message));
        list.append(row);
      }
      details.append(list); target.append(details);
    }
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
