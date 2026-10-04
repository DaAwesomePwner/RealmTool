// Adapted from realm-engine-client client/plugins/auto-drink/catalog.ts @ 88a66b2 (MIT, see NOTICE).
import { XMLParser } from 'fast-xml-parser';
import { validateConsumableItems, type AutoDrinkItem } from '../../src/data/consumables.ts';

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false,
  ignoreDeclaration: true,
  isArray: name => name === 'Activate',
});
// Match the worker's catalog limit so one malformed entry cannot reject a reload.
const MAX_HEALING_DURATION_MS = 86_400_000;
type XmlNode = Record<string, unknown>;

function node(value: unknown): XmlNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : null;
}

/** Empty XML flags may carry attributes (e.g. a quickslot stack cap). */
function flag(value: unknown): boolean {
  const object = node(value);
  if (object) {
    if (Object.keys(object).some(key => key !== '#text' && !key.startsWith('@_'))) return false;
    return flag(object['#text'] ?? '');
  }
  return value === '' || value === 'true' || value === '1';
}

function positive(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return 0;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** Only direct, explicit consumable effects qualify; names and SlotType prove nothing. */
export function parseConsumable(rawXml: string, expectedType: number): AutoDrinkItem | null {
  let object: XmlNode | null;
  try {
    const document = node(parser.parse(rawXml, true));
    if (!document || Object.keys(document).some(key => key !== 'Object')) return null;
    object = node(document.Object);
  } catch {
    return null;
  }
  if (!object || !flag(object.Consumable)) return null;
  const rawType = object['@_type'];
  if (typeof rawType !== 'string' || !/^(?:0x[\da-f]+|\d+)$/i.test(rawType)) return null;
  const type = Number(rawType);
  if (type !== expectedType || !Number.isSafeInteger(type) || type < 0 || type > 0x7fffffff) return null;

  let hp = 0, mp = 0, healingDurationMs = 0;
  const activations = Array.isArray(object.Activate) ? object.Activate : [];
  for (const value of activations) {
    const activate = node(value);
    if (!activate || Object.keys(activate).some(key => key !== '#text' && !key.startsWith('@_'))) continue;
    switch (activate['#text']) {
      case 'Heal':
      case 'HealNova':
        hp += positive(activate['@_amount']);
        break;
      case 'Magic':
      case 'MagicNova':
        mp += positive(activate['@_amount']);
        break;
      case 'ConditionEffectSelf':
      case 'ConditionEffectAura':
        if (activate['@_effect'] === 'Healing') {
          // A duration is metadata, never an estimated or instantaneous HP gain.
          const durationMs = positive(activate['@_duration']) * 1000;
          // Do not turn an unverified HoT into an ordinary instant restorative.
          if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_HEALING_DURATION_MS) return null;
          healingDurationMs = Math.max(healingDurationMs, durationMs);
        }
        break;
    }
  }
  if (![hp, mp, healingDurationMs].every(Number.isFinite) || (hp === 0 && mp === 0 && healingDurationMs === 0)) return null;
  const display = typeof object.DisplayId === 'string' ? object.DisplayId.trim() : '';
  const id = typeof object['@_id'] === 'string' ? object['@_id'].trim() : '';
  return { type, name: display || id || `0x${type.toString(16)}`, hp, mp, healingDurationMs, quickslot: flag(object.QuickslotAllowed) };
}

/** Enumerate direct Object fragments, keeping comments, CDATA and quoted markup opaque. */
export function objectFragments(objectsXml: string): string[] {
  const document = node(parser.parse(objectsXml, true));
  if (!document || Object.keys(document).length !== 1 || !Object.hasOwn(document, 'Objects') || Array.isArray(document.Objects)) {
    throw new TypeError('Expected an Objects XML document');
  }
  const fragments: string[] = [];
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  let depth = 0;
  let start = -1;
  for (const match of objectsXml.matchAll(tags)) {
    const tag = match[0];
    if (tag.startsWith('<!') || tag.startsWith('<?')) continue;
    const closing = tag.startsWith('</');
    const selfClosing = tag.endsWith('/>');
    if (!closing && depth === 1 && /^<Object(?:\s|\/?>)/.test(tag)) start = match.index;
    if (closing) depth--;
    else if (!selfClosing) depth++;
    if (start < 0 || depth !== 1) continue;
    const raw = objectsXml.slice(start, match.index + tag.length);
    start = -1;
    fragments.push(raw);
  }
  return fragments;
}

export function consumablesFromObjectsXml(objectsXml: string): AutoDrinkItem[] {
  const items = new Map<number, AutoDrinkItem>();
  for (const raw of objectFragments(objectsXml)) {
    const parsed = node(parser.parse(raw, true));
    const object = node(parsed?.Object);
    const candidate = parseConsumable(raw, Number(object?.['@_type']));
    if (!candidate) continue;
    const previous = items.get(candidate.type);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) {
      throw new TypeError(`Conflicting duplicate consumable type ${candidate.type}`);
    }
    items.set(candidate.type, candidate);
  }
  return validateConsumableItems([...items.values()].sort((a, b) => a.type - b.type));
}

