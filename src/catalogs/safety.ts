// Adapted from realm-engine-client client/src/game-data/GameDataLoader.ts @ 88a66b2 (MIT, see NOTICE).
import { XMLParser } from 'fast-xml-parser';
import { objectFragments } from './consumables.ts';
import { PROJECTILE_FLAGS, SAFETY_CATALOG_LIMITS as limits, type SafetyProjectileRow } from '../safety/SafetyCatalog.ts';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false,
  parseAttributeValue: false, ignoreDeclaration: true, isArray: name => name === 'Projectile' || name === 'ConditionEffect' });
type Node = Record<string, unknown>;
function node(value: unknown): Node {
  if (value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid XML node');
  return value as Node;
}
function numeric(value: unknown, field: string, max: number, integer = false, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const pattern = integer ? /^(?:0x[\da-f]+|\d+)$/i : /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw new TypeError(`Invalid ${field}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > max || (integer && !Number.isInteger(result))) throw new TypeError(`Invalid ${field} (0…${max})`);
  return result;
}

/** Enumerate direct Ground fragments with quoted markup, comments and CDATA opaque. */
export function groundFragments(xml: string): string[] {
  const document = node(parser.parse(xml, true));
  if (Object.keys(document).length !== 1 || !Object.hasOwn(document, 'GroundTypes') || Array.isArray(document.GroundTypes)) {
    throw new TypeError('Expected a GroundTypes XML document');
  }
  const fragments: string[] = [];
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  let depth = 0, start = -1;
  for (const match of xml.matchAll(tags)) {
    const tag = match[0];
    if (tag.startsWith('<!') || tag.startsWith('<?')) continue;
    const closing = tag.startsWith('</'), selfClosing = tag.endsWith('/>');
    if (!closing && depth === 1 && /^<Ground(?:\s|\/?>)/.test(tag)) start = match.index;
    if (closing) depth--; else if (!selfClosing) depth++;
    if (start < 0 || depth !== 1) continue;
    fragments.push(xml.slice(start, match.index + tag.length)); start = -1;
  }
  return fragments;
}

export function safetyFromXml(objectsXml: string, tilesXml: string): { projectiles: SafetyProjectileRow[]; tiles: [number, number][] } {
  const projectiles = new Map<string, SafetyProjectileRow>();
  const grounds = new Map<number, number>();
  for (const fragment of objectFragments(objectsXml)) {
    const object = node(node(parser.parse(fragment, true)).Object);
    // Decorative/item objects without projectiles do not contribute safety metadata.
    if (!Object.hasOwn(object, 'Projectile')) continue;
    const type = numeric(object['@_type'], 'object type', limits.maxType, true);
    for (const raw of (object.Projectile ?? []) as unknown[]) {
      const projectile = node(raw);
      const id = numeric(projectile['@_id'], 'projectile id', limits.maxProjectileId, true, 0);
      const effects: [string, number][] = [];
      for (const value of (projectile.ConditionEffect ?? []) as unknown[]) {
        const effect = typeof value === 'string' ? { '#text': value } : node(value);
        const name = effect['#text'];
        if (name === undefined || name === '') continue;
        if (typeof name !== 'string') throw new TypeError('Invalid effect name');
        if (!name.trim()) continue;
        effects.push([name, numeric(effect['@_duration'], 'durationSec', limits.maxDurationSec, false, 0)]);
      }
      const row: SafetyProjectileRow = [type, id, numeric(projectile.LifetimeMS, 'lifetimeMs', limits.maxLifetimeMs, false, 0),
        (Object.hasOwn(projectile, 'MultiHit') ? PROJECTILE_FLAGS.multiHit : 0) | (Object.hasOwn(projectile, 'ArmorPiercing') ? PROJECTILE_FLAGS.armorPiercing : 0),
        numeric(projectile.MaxHealthDamage, 'maxHealthDamage', limits.maxDamage, false, 0), effects];
      const key = `${type}:${id}`, previous = projectiles.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new TypeError(`Conflicting duplicate projectile key ${key}`);
      projectiles.set(key, row);
    }
  }
  for (const fragment of groundFragments(tilesXml)) {
    const ground = node(node(parser.parse(fragment, true)).Ground);
    const type = numeric(ground['@_type'], 'ground type', limits.maxType, true);
    const damage = numeric(ground.MaxDamage ?? ground.MinDamage, 'tile damage', limits.maxDamage, false, 0);
    if (grounds.has(type) && grounds.get(type) !== damage) throw new TypeError(`Conflicting duplicate tile key ${type}`);
    grounds.set(type, damage);
  }
  return { projectiles: [...projectiles.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    tiles: [...grounds].filter(([, damage]) => damage > 0).sort((a, b) => a[0] - b[0]) };
}
