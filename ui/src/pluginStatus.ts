import { el, textValue } from './dom.ts';

/** Renders a plugin's published status as text: a key/value list plus Chat Filter's recent messages. */
export function renderStatus(target: HTMLElement, data: Record<string, unknown>): void {
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
