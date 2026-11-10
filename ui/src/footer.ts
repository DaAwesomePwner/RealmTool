import type { AppState } from './api.ts';
import { el } from './dom.ts';

export type ConnectionTone = 'ok' | 'bad' | 'pending';
type LoopLag = NonNullable<NonNullable<AppState['loopLag']>['worker']>;
interface Item { element: HTMLElement; value: HTMLElement }

/** Bottom status bar: backend connection, profile, current operation and loop timings. */
export class StatusFooter {
  readonly element = el('footer', undefined, 'statusbar');
  /** Text-only connection status; the GUI smoke test reads `#app .connection`. */
  readonly connection = el('span', 'Connecting to backend…', 'connection');
  private readonly connectionItem = el('span', undefined, 'statusbar-item statusbar-connection');
  private readonly profile = this.item('Profile', 'profile');
  private readonly operation = this.item('Operation', 'operation');
  private readonly worker = this.item('Network loop', 'loop-worker');
  private readonly main = this.item('Main loop', 'loop-main');

  constructor() {
    this.connection.setAttribute('role', 'status');
    this.connectionItem.dataset.tone = 'pending';
    this.connectionItem.append(el('span', undefined, 'dot'), this.connection);
    for (const item of [this.profile, this.operation, this.worker, this.main]) item.element.hidden = true;
    const loops = el('span', undefined, 'statusbar-loops'); loops.append(this.worker.element, this.main.element);
    this.element.append(this.connectionItem, this.profile.element, this.operation.element, loops);
  }

  setConnection(text: string, tone: ConnectionTone): void {
    this.connection.textContent = text;
    this.connectionItem.dataset.tone = tone;
  }

  update(state: AppState): void {
    this.show(this.profile, state.profile.active);
    this.show(this.operation, state.operation ?? undefined);
    this.loop(this.worker, state.loopLag?.worker, 'Network loop timer drift');
    this.loop(this.main, state.loopLag?.main, 'Main loop timer drift (informational)');
  }

  private item(label: string, key: string): Item {
    const element = el('span', undefined, 'statusbar-item'); element.dataset.key = key;
    const value = el('b');
    element.append(`${label} `, value);
    return { element, value };
  }

  private show(item: Item, value: string | undefined): void {
    item.element.hidden = !value;
    if (item.value.textContent !== (value ?? '')) item.value.textContent = value ?? '';
  }

  private loop(item: Item, lag: LoopLag | undefined, title: string): void {
    this.show(item, lag ? `${lag.p99.toFixed(1)} ms` : undefined);
    if (!lag) { item.element.removeAttribute('title'); return; }
    item.element.title = `${title}: p99 ${lag.p99.toFixed(1)} ms, max ${lag.max.toFixed(1)} ms`;
    item.element.dataset.degraded = String(lag.degraded);
  }
}
