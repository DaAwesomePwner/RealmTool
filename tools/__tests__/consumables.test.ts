// Adapted from realm-engine-client client/src/plugins/__tests__/autoDrinkCatalog.test.ts @ 88a66b2 (MIT, see NOTICE).
import { describe, expect, it } from 'vitest';
import { consumablesFromObjectsXml, parseConsumable } from '../catalogs/consumables.ts';

// Retain upstream parser assertions while supplying the new expected-type contract.
const parseAutoDrinkItem = (raw: string) => parseConsumable(raw, Number(raw.replace(/<!--[\s\S]*?-->/g, '').match(/<Object\s[^>]*?type=["']([^"']+)["']/)?.[1]));

// Synthetic XML exercises the current schema without shipping game-data excerpts.
const item = (effects: string, flags = '<Consumable/><QuickslotAllowed maxstack="4"/>') =>
  `<Object type="0x1234" id="Fixture"><DisplayId>Restorative fixture</DisplayId>${flags}${effects}</Object>`;

describe('Auto Drink structured restorative catalog', () => {
  it('keeps HP and MP separate, sums direct effects, and ignores slot type/name heuristics', () => {
    expect(parseAutoDrinkItem(item(`
      <SlotType>99</SlotType>
      <Activate amount="35">Heal</Activate><Activate amount="65">Heal</Activate>
      <Activate amount="21">Magic</Activate><Activate amount="9">Magic</Activate>
    `))).toEqual({
      type: 0x1234, name: 'Restorative fixture', hp: 100, mp: 30, healingDurationMs: 0, quickslot: true,
    });
    expect(parseAutoDrinkItem('<Object type="0xa22" id="Health Potion"><SlotType>10</SlotType><Consumable/><QuickslotAllowed/></Object>')).toBeNull();
  });

  it('ignores nested activations, equip effects and event procs', () => {
    const nested = `
      <OnPlayerHitActivate amount="400">Heal</OnPlayerHitActivate>
      <OnPlayerShootActivate amount="400">Magic</OnPlayerShootActivate>
      <ActivateOnEquip amount="400">Heal</ActivateOnEquip>
      <Proc><Activate amount="999">Heal</Activate></Proc>
      <ExtraTooltipData><Activate amount="999">MagicNova</Activate></ExtraTooltipData>
      <Proc><Activate effect="Healing" duration="99">ConditionEffectSelf</Activate></Proc>
    `;
    expect(parseAutoDrinkItem(item(nested))).toBeNull();
    expect(parseAutoDrinkItem(item(`${nested}<Activate amount="12">Magic</Activate>`)))
      .toMatchObject({ hp: 0, mp: 12, healingDurationMs: 0 });
    expect(parseAutoDrinkItem(item('<Activate amount="80">Heal<Proc/></Activate>'))).toBeNull();
  });

  it.each(['', '0', '-10', 'NaN', 'Infinity', '1e309', 'ten', '10hp', '0x64'])('fails closed on bad amount %j', amount => {
    expect(parseAutoDrinkItem(item(`<Activate amount="${amount}">Heal</Activate>`))).toBeNull();
    expect(parseAutoDrinkItem(item(`<Activate amount="${amount}">MagicNova</Activate>`))).toBeNull();
  });

  it('requires amounts and does not substitute damage or an arbitrary default', () => {
    expect(parseAutoDrinkItem(item('<Activate>Heal</Activate><Activate damage="80">HealNova</Activate>'))).toBeNull();
    expect(parseAutoDrinkItem(item('<Activate amount="bad">Heal</Activate><Activate amount="22.5">Magic</Activate>')))
      .toMatchObject({ hp: 0, mp: 22.5 });
    expect(parseAutoDrinkItem(item('<Activate amount="1e308">Heal</Activate><Activate amount="1e308">Heal</Activate>'))).toBeNull();
  });

  it('records Healing-only duration without inventing immediate healing', () => {
    expect(parseAutoDrinkItem(item('<Activate effect="Healing" amount="250" duration="2.5">ConditionEffectSelf</Activate>')))
      .toMatchObject({ hp: 0, mp: 0, healingDurationMs: 2500 });
    expect(parseAutoDrinkItem(item(`
      <Activate effect="Healing" duration="2">ConditionEffectSelf</Activate>
      <Activate effect="Healing" duration="3.25" range="4">ConditionEffectAura</Activate>
      <Activate amount="12">Heal</Activate>
    `))).toMatchObject({ hp: 12, mp: 0, healingDurationMs: 3250 });
    expect(parseAutoDrinkItem(item(`
      <Activate amount="30">Magic</Activate>
      <Activate effect="Healing" duration="4">ConditionEffectSelf</Activate>
    `))).toMatchObject({ hp: 0, mp: 30, healingDurationMs: 4000 });
  });

  it('rejects durations beyond the worker limit without dropping the rest of a catalog', () => {
    expect(parseAutoDrinkItem(item('<Activate effect="Healing" duration="86400">ConditionEffectSelf</Activate>')))
      .toMatchObject({ hp: 0, healingDurationMs: 86_400_000 });
    const excessive = item('<Activate amount="20">Heal</Activate><Activate effect="Healing" duration="86400.001">ConditionEffectSelf</Activate>');
    expect(parseAutoDrinkItem(excessive)).toBeNull();
    expect(consumablesFromObjectsXml(`<Objects>${excessive}<Object type="42"><Consumable/><Activate amount="80">Heal</Activate></Object></Objects>`)).toEqual([expect.objectContaining({ type: 42, hp: 80, healingDurationMs: 0 })]);
  });

  it.each(['', '0', '-2', 'bad', 'NaN', 'Infinity', '1e308'])('does not downgrade a mixed restorative with unknown Healing duration %j to instant-only', duration => {
    expect(parseAutoDrinkItem(item(`
      <Activate amount="20">Heal</Activate><Activate amount="30">Magic</Activate>
      <Activate effect="Healing" duration="${duration}">ConditionEffectSelf</Activate>
    `))).toBeNull();
    expect(parseAutoDrinkItem(item(`
      <Activate effect="Healing" duration="2">ConditionEffectSelf</Activate>
      <Activate effect="Healing" duration="${duration}">ConditionEffectAura</Activate>
    `))).toBeNull();
  });

  it.each([
    '<Activate effect="Healing" duration="10">ApplyCondition</Activate>',
    '<Activate effect="Healing" duration="10">GenericActivate</Activate>',
    '<Activate effect="Energized" duration="10">ConditionEffectSelf</Activate>',
    '<Activate effect="Healing">ConditionEffectAura</Activate>',
    '<Activate effect="Healing" duration="-2">ConditionEffectSelf</Activate>',
    '<Activate effect="Healing" duration="0">ConditionEffectSelf</Activate>',
    '<Activate effect="Healing" duration="bad">ConditionEffectSelf</Activate>',
    '<Activate effect="Healing" duration="1e308">ConditionEffectSelf</Activate>',
    '<Activate stat="MAXHP" amount="50" duration="30">StatBoostSelf</Activate>',
    '<Activate stat="0" amount="5">IncrementStat</Activate>',
  ])('does not classify an unsupported effect as restoration: %s', effect => {
    expect(parseAutoDrinkItem(item(effect))).toBeNull();
  });

  it('supports direct HP/MP novas independently', () => {
    expect(parseAutoDrinkItem(item('<Activate amount="15" range="3">HealNova</Activate><Activate amount="45" range="3">MagicNova</Activate>')))
      .toMatchObject({ hp: 15, mp: 45, healingDurationMs: 0 });
  });

  it.each([
    '', '<QuickslotAllowed/>', '<Consumable>false</Consumable>', '<Consumable>0</Consumable>',
    '<Consumable>unknown</Consumable>', '<Wrapper><Consumable/></Wrapper>', '<Consumable><Unknown/></Consumable>',
    '<Consumable/><Consumable>false</Consumable>',
  ])('requires an unambiguous direct Consumable flag: %s', flags => {
    expect(parseAutoDrinkItem(item('<Activate amount="60">Heal</Activate>', flags))).toBeNull();
  });

  it.each(['<Consumable/>', '<Consumable>true</Consumable>', '<Consumable>1</Consumable>'])('accepts explicit consumables: %s', flags => {
    expect(parseAutoDrinkItem(item('<Activate amount="60">Heal</Activate>', flags)))
      .toMatchObject({ hp: 60, quickslot: false });
  });

  it.each([
    ['', false], ['<QuickslotAllowed/>', true], ['<QuickslotAllowed maxstack="3"/>', true],
    ['<QuickslotAllowed>true</QuickslotAllowed>', true], ['<QuickslotAllowed>1</QuickslotAllowed>', true],
    ['<QuickslotAllowed>false</QuickslotAllowed>', false], ['<QuickslotAllowed>0</QuickslotAllowed>', false],
    ['<QuickslotAllowed>unknown</QuickslotAllowed>', false], ['<Wrapper><QuickslotAllowed/></Wrapper>', false],
    ['<QuickslotAllowed><Unknown/></QuickslotAllowed>', false],
    ['<QuickslotAllowed/><QuickslotAllowed>false</QuickslotAllowed>', false],
  ])('reads QuickslotAllowed independently: %s -> %s', (flag, quickslot) => {
    expect(parseAutoDrinkItem(item('<Activate amount="60">Heal</Activate>', `<Consumable/>${flag}`)))
      .toMatchObject({ hp: 60, quickslot });
  });

  it('fails closed on malformed, wrapped, ambiguous or invalidly identified XML', () => {
    for (const raw of [
      '', '<Object><Consumable/><Activate amount="80">Heal</Object>',
      `<Objects>${item('<Activate amount="80">Heal</Activate>')}</Objects>`,
      item('<Activate amount="80">Heal</Activate>').repeat(2),
      `${item('<Activate amount="80">Heal</Activate>')}<Other/>`,
      `<Other/>${item('<Activate amount="80">Heal</Activate>')}`,
      '<Object type="42" type="43"><Consumable/><Activate amount="80">Heal</Activate></Object>',
      ...['-1', 'NaN', '0xZZ', '1.5', '2147483648', '9007199254740992'].map(type =>
        `<Object type="${type}"><Consumable/><Activate amount="80">Heal</Activate></Object>`),
    ]) expect(parseAutoDrinkItem(raw)).toBeNull();
  });

  it('uses names only for display and supports decimal object IDs', () => {
    expect(parseAutoDrinkItem('<Object type="42" id="Fixture ID"><Consumable/><Activate amount="3">Heal</Activate></Object>'))
      .toMatchObject({ type: 42, name: 'Fixture ID', hp: 3 });
    expect(parseAutoDrinkItem('<Object type="42"><Consumable/><Activate amount="3">Heal</Activate></Object>'))
      .toMatchObject({ name: '0x2a' });
  });

  it('accepts declarations, comments, whitespace and numeric boundaries without reading embedded fake effects', () => {
    const raw = `<?xml version="1.0"?>
      <!-- <Object type="42"><Consumable/><Activate amount="999">Magic</Activate></Object> -->
      <Object type="0X7FFFFFFF" id="Display &amp; name">
        <Consumable> true </Consumable><QuickslotAllowed> 1 </QuickslotAllowed>
        <!-- <Activate amount="999">Magic</Activate> -->
        <ExtraTooltipData><![CDATA[<Activate amount="999">Magic</Activate>]]></ExtraTooltipData>
        <Activate amount=" 2.5e1 "> HealNova </Activate>
        <Activate amount=".5"> Magic </Activate>
        <Activate amount="999">UnknownHeal</Activate>
      </Object>`;
    expect(parseAutoDrinkItem(raw)).toEqual({
      type: 0x7fffffff, name: 'Display & name', hp: 25, mp: 0.5, healingDurationMs: 0, quickslot: true,
    });
    expect(parseAutoDrinkItem('<Object type="0"><Consumable/><Activate amount="1">Heal</Activate></Object>'))
      .toMatchObject({ type: 0, hp: 1 });
  });

  it('builds fresh snapshots, skips missing/mismatched XML, and has no fallback IDs', () => {
    let raw = item('<Activate amount="60">Heal</Activate>');
    expect(consumablesFromObjectsXml('<Objects/>')).toEqual([]);
    expect(parseConsumable(raw, 8)).toBeNull();
    expect(parseConsumable('<broken>', 9)).toBeNull();
    expect(consumablesFromObjectsXml(`<Objects>${raw}</Objects>`)).toEqual([expect.objectContaining({ type: 0x1234, hp: 60 })]);
    raw = item('<Activate stat="MAXHP" amount="50">StatBoostSelf</Activate>');
    expect(consumablesFromObjectsXml(`<Objects>${raw}</Objects>`)).toEqual([]);
  });
});
