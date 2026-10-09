import type { StoredLog } from '../../src/util/logStore.ts';
import { button, el } from './dom.ts';

export class LogPanel {
  readonly element = el('section', undefined, 'log-panel');
  readonly rows = el('div', undefined, 'log-rows');
  readonly filter = el('select');
  private records: StoredLog[] = [];
  private follow = true;
  private readonly resume: HTMLButtonElement;
  private readonly notice = el('p', '', 'muted');
  next = 0;

  constructor() {
    const header = el('header', undefined, 'section-heading'); header.append(el('h2', 'Live log'));
    const label = el('label', 'Level ');
    for (const value of ['all', 'debug', 'info', 'warn', 'error']) {
      const option = el('option', value === 'all' ? 'All levels' : value); option.value = value; this.filter.append(option);
    }
    label.append(this.filter); header.append(label);
    this.resume = button('Resume autoscroll', () => { this.follow = true; this.scroll(); });
    this.resume.hidden = true; header.append(this.resume);
    this.rows.tabIndex = 0; this.rows.setAttribute('aria-label', 'Log records');
    this.rows.addEventListener('scroll', () => {
      this.follow = this.rows.scrollHeight - this.rows.clientHeight - this.rows.scrollTop <= 24;
      this.resume.hidden = this.follow;
    });
    this.filter.addEventListener('change', () => this.render());
    this.element.append(header, this.notice, this.rows);
  }

  add(record: StoredLog): void {
    if (record.seq <= this.next) { this.merge([record]); return; }
    this.next = record.seq; this.records.push(record);
    const removed = this.records.length > 1000 ? this.records.shift() : undefined;
    const top = this.rows.scrollTop;
    if (removed) this.rows.querySelector(`[data-seq="${removed.seq}"]`)?.remove();
    if (this.filter.value === 'all' || record.level === this.filter.value) this.rows.append(this.row(record));
    if (this.follow) this.scroll(); else this.rows.scrollTop = top;
  }

  merge(records: StoredLog[], dropped = false): void {
    if (dropped) this.notice.textContent = 'Some earlier records are no longer available.';
    const existing = new Map(this.records.map(record => [record.seq, record]));
    for (const record of records) { existing.set(record.seq, record); this.next = Math.max(this.next, record.seq); }
    this.records = [...existing.values()].sort((a, b) => a.seq - b.seq).slice(-1000);
    this.render();
  }

  private render(): void {
    const scrollTop = this.rows.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const record of this.records) {
      if (this.filter.value !== 'all' && record.level !== this.filter.value) continue;
      fragment.append(this.row(record));
    }
    this.rows.replaceChildren(fragment);
    if (this.follow) this.scroll(); else this.rows.scrollTop = scrollTop;
  }

  /** Hidden panels have no scroll height, so re-pin to the newest record when the panel reappears. */
  shown(): void { if (this.follow) this.scroll(); }

  private scroll(): void { this.rows.scrollTop = this.rows.scrollHeight; this.resume.hidden = true; }

  private row(record: StoredLog): HTMLElement {
    const row = el('div', undefined, `log-row log-${record.level}`); row.dataset.seq = String(record.seq);
    const time = el('time', new Date(record.at).toLocaleTimeString()); time.dateTime = new Date(record.at).toISOString();
    row.append(time, el('span', record.level, 'log-level'), el('span', record.module, 'log-module'), el('span', record.message));
    return row;
  }
}
