import type { ApiClient, AppState } from './api.ts';
import { button, el, message } from './dom.ts';

export class Readiness {
  /** Game folder, launcher, game data and helper controls. */
  readonly element = el('section', undefined, 'readiness');
  /** Compact proxy/helper/session summary for the top bar. */
  readonly status = el('div', undefined, 'readiness-bar');
  /** Launch and proxy controls for the top bar. */
  readonly actions = el('div', undefined, 'controls');
  /** Proxy and request errors, shown above the tabs so they stay visible. */
  readonly notices = el('div', undefined, 'notices');
  private readonly protectionItem = el('div', undefined, 'protection');
  private readonly protectionValue = el('strong');
  private readonly protectionReasons = el('ul', undefined, 'protection-reasons');
  private readonly error = el('p', '', 'error');
  private readonly requestError = el('p', '', 'error');
  private readonly folder = el('input');
  private readonly launcher = el('input');
  private readonly candidates = el('datalist');
  private readonly launch: HTMLButtonElement;
  private readonly proxy: HTMLButtonElement;
  private readonly refresh: HTMLButtonElement;
  private readonly dataStatus = el('p', '', 'help');
  private readonly uninstall: HTMLButtonElement;
  private readonly saveFolder: HTMLButtonElement;
  private readonly saveLauncher: HTMLButtonElement;
  private state?: AppState;
  private busy = false;
  private readonly api: Pick<ApiClient, 'post'>;
  private readonly changed: () => void;

  constructor(api: Pick<ApiClient, 'post'>, changed: () => void) {
    this.api = api; this.changed = changed;
    this.status.setAttribute('aria-live', 'polite');
    this.protectionItem.dataset.key = 'protection';
    this.protectionItem.append(el('span', 'Protection'), this.protectionValue);
    this.status.append(this.protectionItem);
    this.launch = button('Launch', () => void this.run('/api/game/launch'));
    this.launch.className = 'primary';
    this.proxy = button('Start proxy', () => void this.run(`/api/proxy/${this.state?.proxy.state === 'running' ? 'stop' : 'start'}`));
    this.refresh = button('Refresh game data', () => void this.run('/api/refresh-data'));
    this.dataStatus.setAttribute('aria-live', 'polite');
    this.uninstall = button('Uninstall helper', () => void this.run('/api/helper/uninstall'));
    this.actions.append(this.launch, this.proxy);
    const label = el('label', 'Game folder'); this.folder.type = 'text'; this.folder.placeholder = 'Path to the RotMG Exalt game folder';
    this.candidates.id = 'game-folders'; this.folder.setAttribute('list', this.candidates.id);
    this.saveFolder = button('Save game folder', () => void this.run('/api/game/dir', { dir: this.folder.value }));
    label.append(this.folder); const folderRow = el('div', undefined, 'path-row'); folderRow.append(label, this.saveFolder, this.candidates);
    const launcherLabel = el('label', 'Launcher path (blank for automatic discovery)'); this.launcher.type = 'text'; launcherLabel.append(this.launcher);
    this.saveLauncher = button('Save launcher', () => void this.run('/api/game/launcher', { path: this.launcher.value.trim() || null }));
    const launcherRow = el('div', undefined, 'path-row'); launcherRow.append(launcherLabel, this.saveLauncher);
    const options = el('details'); options.append(el('summary', 'Launcher settings'), launcherRow);
    const data = el('div', undefined, 'setup-row'); data.append(this.refresh, this.dataStatus);
    const helper = el('div', undefined, 'setup-row');
    helper.append(this.uninstall, el('p', 'Closing the window while the proxy runs hides RealmTool to the tray. Use tray Quit to exit. The helper stays installed until you uninstall it.', 'help'));
    this.error.setAttribute('role', 'alert'); this.requestError.setAttribute('role', 'alert');
    this.notices.append(this.error, this.requestError, this.protectionReasons);
    this.element.append(el('h2', 'Game'), folderRow, options, el('h3', 'Game data'), data, el('h3', 'Helper'), helper);
    this.controls();
  }

  update(state: AppState): void {
    this.state = state;
    for (const child of [...this.status.children]) if (child !== this.protectionItem) child.remove();
    for (const [name, lag] of Object.entries(state.loopLag ?? {})) {
      if (lag) this.status.append(el('div', `${name === 'worker' ? 'Network' : 'Main (informational)'} loop: p99 ${lag.p99.toFixed(1)} ms / max ${lag.max.toFixed(1)} ms`));
    }
    const protection = state.protection;
    this.protectionItem.dataset.value = protection?.state ?? 'unknown';
    const labels = { idle: 'Idle', protected: 'Protected', degraded: 'Degraded', unprotected: 'Not protected' };
    const value = protection ? labels[protection.state] : 'Unknown';
    if (this.protectionValue.textContent !== value) this.protectionValue.textContent = value;
    this.protectionReasons.replaceChildren(...(protection?.reasons ?? []).filter(r => r.severity !== 'info').map(reason => el('li', reason.message)));

    for (const [label, value] of [
      ['Proxy', state.proxy.state], ['Helper', state.game.helper.state],
      ['Sessions', `${state.sessions.connected} connected / ${state.sessions.open} open`],
      ['Profile', state.profile.active], ['Operation', state.operation ?? 'Idle'],
    ]) {
      const item = el('div'); item.dataset.key = label.toLowerCase(); item.dataset.value = value;
      item.append(el('span', label, 'muted'), el('strong', value)); this.status.append(item);
    }
    this.error.textContent = state.proxy.error ?? '';
    const data = state.data, result = data?.lastResult;
    this.dataStatus.textContent = data?.state === 'refreshing' ? 'Refreshing game data… This may take up to two minutes.'
      : data?.state === 'failed' ? `Game data refresh failed: ${data.error}. Check the log and try Refresh game data.`
      : result ? `Game data refreshed for build ${result.gameBuild}: ${result.items} items, ${result.projectiles} projectiles, ${result.tiles} tiles (${result.ms} ms).`
      : data?.catalogBuild ? `Game data: build ${data.catalogBuild}` : 'Game data is checked automatically when the proxy starts.';
    if (result && data.state !== 'idle') this.dataStatus.textContent += ` Last refresh: build ${result.gameBuild}, ${result.items} items, ${result.projectiles} projectiles, ${result.tiles} tiles (${result.ms} ms).`;
    this.folder.classList.toggle('invalid', !state.game.dir);
    this.folder.setAttribute('aria-invalid', String(!state.game.dir));
    if (document.activeElement !== this.folder) this.folder.value = state.game.dir ?? '';
    if (document.activeElement !== this.launcher) this.launcher.value = state.game.launcher ?? '';
    this.candidates.replaceChildren(...state.game.candidates.map(path => { const option = el('option'); option.value = path; return option; }));
    this.controls();
  }

  private controls(): void {
    const state = this.state;
    const busy = this.busy || !!state?.operation || !state;
    const running = state?.proxy.state === 'running';
    const stopped = state?.proxy.state === 'stopped' || state?.proxy.state === 'failed';
    this.refresh.disabled = busy || !state?.game.dir || state?.data?.state === 'refreshing';
    this.refresh.textContent = state?.data?.state === 'refreshing' ? 'Refreshing game data…' : 'Refresh game data';
    this.proxy.textContent = running ? 'Stop proxy' : 'Start proxy';
    this.proxy.disabled = busy || (!running && !stopped);
    this.launch.disabled = busy || !state?.game.dir;
    this.uninstall.disabled = busy || !stopped || !state?.game.dir;
    this.folder.disabled = this.saveFolder.disabled = busy || !stopped;
    this.launcher.disabled = this.saveLauncher.disabled = busy || !stopped;
  }

  private async run(path: string, body: unknown = {}): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.controls(); this.requestError.textContent = '';
    try { await this.api.post(path, body); this.changed(); }
    catch (error) { this.requestError.textContent = message(error); }
    finally { this.busy = false; this.controls(); }
  }
}
