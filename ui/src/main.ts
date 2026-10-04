import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PluginSnapshot } from '../../src/plugins/snapshot.ts';
import type { StoredLog } from '../../src/util/logStore.ts';
import { ApiClient, backendInfo, type AppState } from './api.ts';
import { button, el, message } from './dom.ts';
import { PluginCards } from './plugins.ts';
import { Readiness } from './readiness.ts';
import { LogPanel } from './logs.ts';
import { ProfilePicker } from './profiles.ts';
import './styles.css';

type BackendEvent = { type: 'state'; state: AppState } | { type: 'plugins'; plugins: PluginSnapshot[] }
  | { type: 'data'; pluginId: string; dataType: string; data: unknown } | { type: 'log'; record: StoredLog };

async function main(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app')!;
  const header = el('header', undefined, 'app-heading');
  header.append(el('h1', 'RealmTool'), el('p', 'Launch, configure, and monitor your proxy.'));
  const connection = el('p', 'Connecting to backend…', 'connection'); connection.setAttribute('role', 'status');
  const error = el('p', '', 'error'); error.setAttribute('role', 'alert');
  const restart = button('Restart', () => {
    restart.disabled = true;
    void invoke('restart_backend').then(() => location.reload()).catch(failure => { error.textContent = message(failure); restart.disabled = false; });
  });
  restart.hidden = true;
  const retry = button('Retry connection', () => location.reload()); retry.hidden = true;
  root.replaceChildren(header, connection, error, restart, retry);
  let stopEvents: (() => void) | undefined;
  let cards: PluginCards | undefined;
  let stopped = false;
  let unlisten: (() => void) | undefined;
  const content = el('div');
  try {
    if (isTauri()) unlisten = await listen('backend-exited', () => {
      stopped = true; stopEvents?.(); cards?.dispose(); content.inert = true;
      connection.textContent = 'Backend stopped'; restart.hidden = false;
    });
    const api = new ApiClient(await backendInfo());
    if (stopped) return;
    const logs = new LogPanel();
    let refreshVersion = 0;
    let stateVersion = 0;
    let pluginsVersion = 0;
    let activeProfile: string | undefined;
    const showState = (state: AppState) => {
      if (activeProfile !== undefined && activeProfile !== state.profile.active) cards!.update([]);
      activeProfile = state.profile.active;
      if (state.operation) cards!.cancelDrafts();
      cards!.element.inert = !!state.operation;
      readiness.update(state); profiles.update(state.profile, state.sessions.connected, !!state.operation);
    };
    const refresh = async () => {
      const version = ++refreshVersion; const stateAtStart = stateVersion; const pluginsAtStart = pluginsVersion;
      try {
        const [state, plugins] = await Promise.all([
          api.get<AppState>('/api/state'), api.get<PluginSnapshot[]>('/api/plugins'),
          api.get<{ records: StoredLog[]; next: number; dropped: boolean }>(`/api/logs?since=${logs.next}`).then(history => {
            // History is additive: an older refresh can still fill gaps between live events.
            // LogPanel advances its cursor only from the records it actually merges.
            if (!stopped) logs.merge(history.records, history.dropped);
          }),
        ]);
        if (stopped || version !== refreshVersion) return;
        if (stateAtStart === stateVersion) showState(state);
        if (pluginsAtStart === pluginsVersion) cards!.update(plugins);
        error.textContent = '';
      } catch (failure) { if (!stopped) { error.textContent = message(failure); retry.hidden = false; } }
    };
    const changed = () => { void refresh(); };
    const readiness = new Readiness(api, changed);
    const profiles = new ProfilePicker(api, changed, undefined, () => cards!.beforeProfileSwitch());
    cards = new PluginCards(api, changed);
    content.append(readiness.element, profiles.element, cards.element, logs.element); root.append(content);
    api.onConnection = connected => {
      if (stopped) return;
      connection.textContent = connected ? 'Backend connected' : 'Connection lost. Reconnecting…';
      content.inert = !connected;
      if (!connected) cards!.cancelDrafts();
      if (connected) { retry.hidden = true; void refresh(); }
    };
    content.inert = true;
    stopEvents = await api.events(raw => {
      if (stopped || !raw || typeof raw !== 'object' || !('type' in raw)) return;
      const event = raw as BackendEvent;
      if (event.type === 'state') { stateVersion++; showState(event.state); }
      else if (event.type === 'plugins') { pluginsVersion++; cards!.update(event.plugins); }
      else if (event.type === 'data') cards!.data(event.pluginId, event.dataType, event.data);
      else if (event.type === 'log') logs.add(event.record);
    });
    if (stopped) stopEvents(); else await refresh();
    window.addEventListener('beforeunload', () => { stopEvents?.(); unlisten?.(); cards?.dispose(); }, { once: true });
  } catch (failure) {
    error.textContent = message(failure); connection.textContent = stopped ? 'Backend stopped' : 'Backend unavailable';
    if (isTauri()) restart.hidden = false; else retry.hidden = false;
  }
}

void main();
