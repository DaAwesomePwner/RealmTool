import type { ProtectionState } from './api.ts';

const SVG = 'http://www.w3.org/2000/svg';
const SHIELD = 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z';
const MARKS: Partial<Record<ProtectionState, string>> = {
  protected: 'M8.5 12l2.5 2.5 4.5-5',
  degraded: 'M12 8v5M12 16.5v.01',
  unprotected: 'M9.5 9.5l5 5M14.5 9.5l-5 5',
};

/** Decorative shield: a check when protected, an exclamation when degraded, a cross when not protected. */
export function shieldIcon(state: ProtectionState | 'unknown'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(name, value);
  svg.classList.add('protection-icon');
  svg.dataset.state = state;
  for (const d of [SHIELD, state === 'unknown' ? undefined : MARKS[state]]) {
    if (!d) continue;
    const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}
