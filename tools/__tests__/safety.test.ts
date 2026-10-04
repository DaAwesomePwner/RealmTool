import { describe, expect, it } from 'vitest';
import { groundFragments, safetyFromXml } from '../catalogs/safety.ts';

const objects = (body: string) => `<Objects>${body}</Objects>`;
const object = (body = '<Projectile/>', type = '42') => `<Object type='${type}'>${body}</Object>`;
const tiles = (body = '') => `<GroundTypes>${body}</GroundTypes>`;
describe('safety XML extraction', () => {
  it('normalizes types, defaults id and metadata, and sorts deterministically', () => {
    expect(safetyFromXml(objects(object('<Projectile id="2"/><Projectile/>', '0x2a') + object('<Projectile/>', '1')), tiles()))
      .toEqual({ projectiles: [[1, 0, 0, 0, 0, []], [42, 0, 0, 0, 0, []], [42, 2, 0, 0, 0, []]], tiles: [] });
    expect(safetyFromXml(objects(object('', '0xc283a')), tiles())).toEqual({ projectiles: [], tiles: [] });
  });
  it('uses flag presence, keeps named effects in seconds, and excludes raw damage', () => {
    expect(safetyFromXml(objects(object(`<Projectile><LifetimeMS>100</LifetimeMS><MultiHit>false</MultiHit><ArmorPiercing/>
      <MaxHealthDamage>0.25</MaxHealthDamage><ConditionEffect duration='100000'>Sick</ConditionEffect>
      <ConditionEffect>Quiet</ConditionEffect><ConditionEffect/><Damage>999</Damage><MinDamage>4</MinDamage><MaxDamage>8</MaxDamage></Projectile>`)), tiles()).projectiles)
      .toEqual([[42, 0, 100, 3, 0.25, [['Sick', 100000], ['Quiet', 0]]]]);
  });
  it('collapses identical keys and reports conflicting projectile and tile keys', () => {
    expect(safetyFromXml(objects(object() + object('<Projectile/>', '0x2a')), tiles()).projectiles).toHaveLength(1);
    expect(() => safetyFromXml(objects(object() + object('<Projectile><LifetimeMS>1</LifetimeMS></Projectile>')), tiles())).toThrow(/42.*0/);
    const ground = '<Ground type="42"><MaxDamage>1</MaxDamage></Ground>';
    expect(safetyFromXml(objects(''), tiles(ground + ground)).tiles).toEqual([[42, 1]]);
    expect(() => safetyFromXml(objects(''), tiles(ground + ground.replace('>1<', '>2<')))).toThrow(/42/);
  });
  it.each([
    ['<Projectile id="256"/>', 'id'], ['<Projectile id="1.5"/>', 'id'],
    ['<Projectile><LifetimeMS>1000000001</LifetimeMS></Projectile>', 'lifetimeMs'],
    ['<Projectile><LifetimeMS>NaN</LifetimeMS></Projectile>', 'lifetimeMs'],
    ['<Projectile><ConditionEffect duration="1000001">Sick</ConditionEffect></Projectile>', 'durationSec'],
    ['<Projectile><MaxHealthDamage>-1</MaxHealthDamage></Projectile>', 'maxHealthDamage'],
  ])('rejects invalid metadata %s', (body, field) => {
    expect(() => safetyFromXml(objects(object(body)), tiles())).toThrow(field);
  });
  it('exports positive tile damage, preferring MaxDamage, with numeric sorting', () => {
    expect(safetyFromXml(objects(''), tiles(`<Ground type='0x2a'><MinDamage>1</MinDamage><MaxDamage>5</MaxDamage></Ground>
      <Ground type='2'><MinDamage>3</MinDamage></Ground><Ground type='3'><MinDamage>7</MinDamage><MaxDamage>0</MaxDamage></Ground><Ground type='4'/>`)).tiles)
      .toEqual([[2, 3], [42, 5]]);
  });
  it('enumerates only direct structural fragments and rejects malformed roots and bounds', () => {
    const ground = '<Ground type="2"><MaxDamage>1</MaxDamage></Ground>';
    expect(groundFragments(tiles(`<!--${ground}--><Note><![CDATA[${ground}]]></Note><Wrapper>${ground}</Wrapper>${ground}`))).toEqual([ground]);
    expect(safetyFromXml(objects(`<Wrapper>${object()}</Wrapper><!--${object()}--><Note><![CDATA[${object()}]]></Note>`), tiles()).projectiles).toEqual([]);
    for (const xml of ['<Other/>', '<GroundTypes/><GroundTypes/>', '<GroundTypes><bad></GroundTypes>']) expect(() => groundFragments(xml)).toThrow();
    for (const type of ['65536', '-1', '1.5', 'garbage']) expect(() => safetyFromXml(objects(object('<Projectile/>', type)), tiles())).toThrow(/type/);
    expect(() => safetyFromXml(objects(''), tiles('<Ground type="2"><MaxDamage>1000001</MaxDamage></Ground>'))).toThrow(/damage/);
  });
});
