import type { AppState, Protection } from './api.ts';
import { el } from './dom.ts';
import { shieldIcon } from './icons.ts';

const LABELS = { idle: 'Idle', protected: 'Protected', degraded: 'Degraded', unprotected: 'Not protected' };

/** The one sentence under the protection state word. */
export function protectionSentence(protection: Protection | undefined): string {
  if (!protection) return 'Waiting for the backend';
  if (protection.state === 'idle') return 'No game connected. Press Launch to start.';
  if (protection.state === 'protected') return 'Game traffic is going through the proxy';
  const reason = protection.reasons.find(r => r.severity !== 'info');
  if (reason) return reason.message;
  return protection.state === 'degraded' ? 'Protection is running with problems' : 'Game traffic is not protected';
}

type Tone = 'ok' | 'warn' | 'bad' | 'off';
interface Fact { item: HTMLElement; value: HTMLElement; dot?: HTMLElement }

/** Header summary: the protection block first, then the proxy, helper and session facts. */
export class StatusSummary {
  readonly element = el('div', undefined, 'readiness-bar');
  readonly protection = el('div', undefined, 'protection');
  private readonly value = el('strong', undefined, 'protection-value');
  private readonly sentence = el('small', undefined, 'protection-sentence');
  private icon = shieldIcon('unknown');
  private readonly facts = el('dl', undefined, 'facts');
  private readonly proxy = this.fact('Proxy', true);
  private readonly helper = this.fact('Helper', true);
  private readonly sessions = this.fact('Sessions', false);

  constructor() {
    this.element.setAttribute('aria-live', 'polite');
    this.protection.dataset.key = 'protection';
    this.protection.dataset.value = 'unknown';
    const text = el('div', undefined, 'protection-text');
    text.append(this.value, this.sentence);
    this.protection.append(el('span', 'Protection', 'sr-only'), this.icon, text);
    this.element.append(this.protection, this.facts);
  }

  update(state: AppState): void {
    const protection = state.protection;
    const key = protection?.state ?? 'unknown';
    if (this.protection.dataset.value !== key || !this.value.textContent) {
      this.protection.dataset.value = key;
      const icon = shieldIcon(key); this.icon.replaceWith(icon); this.icon = icon;
    }
    const value = protection ? LABELS[protection.state] : 'Unknown';
    if (this.value.textContent !== value) this.value.textContent = value;
    const sentence = protectionSentence(protection);
    if (this.sentence.textContent !== sentence) { this.sentence.textContent = sentence; this.sentence.title = sentence; }

    const proxy = state.proxy.state, helper = state.game.helper.state;
    this.set(this.proxy, proxy, proxy === 'running' ? 'ok' : proxy === 'failed' ? 'bad' : 'off');
    this.set(this.helper, helper, helper === 'installed' ? 'ok' : helper === 'outdated' || helper === 'foreign' ? 'warn' : 'off');
    const { connected, open } = state.sessions;
    if (this.sessions.item.dataset.value === `${connected}/${open}`) return;
    this.sessions.item.dataset.value = `${connected}/${open}`;
    this.sessions.value.replaceChildren(`${connected} connected`, ' ', el('span', `of ${open} open`, 'muted'));
    this.sessions.value.title = `${connected} connected, ${open} open`;
  }

  private fact(label: string, withDot: boolean): Fact {
    const item = el('div', undefined, 'fact'); item.dataset.key = label.toLowerCase();
    const holder = el('dd'), value = el('span', undefined, 'fact-text');
    const dot = withDot ? el('span', undefined, 'dot') : undefined;
    if (dot) holder.append(dot);
    holder.append(value);
    item.append(el('dt', label), holder); this.facts.append(item);
    return { item, value, dot };
  }

  private set(fact: Fact, value: string, tone: Tone): void {
    fact.item.dataset.value = value;
    if (fact.value.textContent !== value) fact.value.textContent = value;
    if (fact.dot) fact.dot.dataset.tone = tone;
  }
}
