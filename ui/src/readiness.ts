import type { ApiClient, AppState } from './api.ts';
import { button, el, message } from './dom.ts';

export class Readiness {
  readonly element = el('section', undefined, 'readiness');
  private readonly bar = el('div', undefined, 'readiness-bar');
  private readonly error = el('p', '', 'error');
  private readonly requestError = el('p', '', 'error');
  private readonly folder = el('input');
  private readonly launcher = el('input');
  private readonly candidates = el('datalist');
  private readonly launch: HTMLButtonElement;
  private readonly proxy: HTMLButtonElement;
  private readonly uninstall: HTMLButtonElement;
  private readonly saveFolder: HTMLButtonElement;
  private readonly saveLauncher: HTMLButtonElement;
  private state?: AppState;
  private busy = false;
  private readonly api: Pick<ApiClient, 'post'>;
  private readonly changed: () => void;

  constructor(api: Pick<ApiClient, 'post'>, changed: () => void) {
    this.api = api; this.changed = changed;
    this.bar.setAttribute('aria-live', 'polite');
    this.launch = button('Launch', () => void this.run('/api/game/launch'));
    this.launch.className = 'primary';
    this.proxy = button('Start proxy', () => void this.run(`/api/proxy/${this.state?.proxy.state === 'running' ? 'stop' : 'start'}`));
    this.uninstall = button('Uninstall helper', () => void this.run('/api/helper/uninstall'));
    const controls = el('div', undefined, 'controls'); controls.append(this.launch, this.proxy, this.uninstall);
    const label = el('label', 'Game folder'); this.folder.type = 'text'; this.folder.placeholder = 'Path to the RotMG Exalt game folder';
    this.candidates.id = 'game-folders'; this.folder.setAttribute('list', this.candidates.id);
    this.saveFolder = button('Save game folder', () => void this.run('/api/game/dir', { dir: this.folder.value }));
    label.append(this.folder); const folderRow = el('div', undefined, 'path-row'); folderRow.append(label, this.saveFolder, this.candidates);
    const launcherLabel = el('label', 'Launcher path (blank for automatic discovery)'); this.launcher.type = 'text'; launcherLabel.append(this.launcher);
    this.saveLauncher = button('Save launcher', () => void this.run('/api/game/launcher', { path: this.launcher.value.trim() || null }));
    const launcherRow = el('div', undefined, 'path-row'); launcherRow.append(launcherLabel, this.saveLauncher);
    const options = el('details'); options.append(el('summary', 'Launcher settings'), launcherRow);
    this.error.setAttribute('role', 'alert'); this.requestError.setAttribute('role', 'alert');
    this.element.append(this.bar, this.error, controls, folderRow, options, this.requestError,
      el('p', 'Closing the window while the proxy runs hides RealmTool to the tray. Use tray Quit to exit. The helper stays installed until you uninstall it.', 'help'));
    this.controls();
  }

  update(state: AppState): void {
    this.state = state;
    this.bar.replaceChildren();
    for (const [label, value] of [
      ['Proxy', state.proxy.state], ['Helper', state.game.helper.state],
      ['Sessions', `${state.sessions.connected} connected / ${state.sessions.open} open`],
      ['Profile', state.profile.active], ['Operation', state.operation ?? 'Idle'],
    ]) { const item = el('div'); item.append(el('span', label, 'muted'), el('strong', value)); this.bar.append(item); }
    this.error.textContent = state.proxy.error ?? '';
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
