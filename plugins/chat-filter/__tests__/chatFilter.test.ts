// Ported from realm-engine-client client/src/plugins/__tests__/chatFilter.test.ts @ 88a66b2 (MIT, see NOTICE).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chatFilter from '../index.ts';
import { evaluate } from '../engine.ts';
import { advertisingText, readableText } from '../normalize.ts';
import { compileSettings, DEFAULTS, normalizeChatProfile, SETTING_DEFS } from '../settings.ts';
import { SenderState } from '../sender-state.ts';
import { definePlugin } from '../../../src/plugins/api.ts';
import { startHost, textData, type Harness } from '../../../src/testing/pluginHarness.ts';
import { writeJsonAtomic, type Profile } from '../../../src/config/store.ts';
import { log, type LogRecord } from '../../../src/util/log.ts';

const SPAM = [
  'Again instock Maxing + Rare E.Nchanted set 9.99$ ======== rea!mshop INFO == 3x Maxing + enchanted 19.99 217',
  'Bulk keys instock 100 keys 24.99  ======== rea!mshop INFO == 472',
  '<sprite name=shiny> D<a>SC.g<a>g/Fama<a>zon - "We love Famazon" -Brazil <2830>',
  'D<k>SC.g<q>g/Fam<z>azon - Fast, cheap services :D <518>',
  'Re<g>alm Sto<l>ck co<w>m - Now Accepting Pa<g>ypal and Ve<p>nmo! <244>',
  'Real<t>m Stock.com - best prices',
  'Realm Sto<x>ck co<y>m - quick and trusted',
  // Live captures that bypassed the letter-only marker strip and campaign rules.
  '<sprite name=shiny> DS<g>C.g<r>g/Fama<8>zon - I know your secret <9359>',
  '<sprite name=shiny> DS<1>C.g<5>g/F<c>amazon - /tell Reze for free stat potions :D <5325>',
  '<sprite name=shiny> DS<q>C.g<3>g/Famaz<3>on - Everything you\'ll ever need here :) <2166>',
  '======== rea!mshop INFO == Dungeon Services, get your white within hour, high chance of whitabag guarantee! 825',
  'DIvine Pet account now 99.99  ======== rea!mshop INFO == 47',
  'RP6(dot)RIP 72x Seas0n Grand Life for 13.99 132',
  'RP6(dot)RIP ST Sets for 2 Rare egg for 1 708',
  'rpg6 [dot] rip cheap maxing',
  'Shopname(dot)gg seasonal sets 4.99',
];
const harnesses = new Set<Harness>();
const records: LogRecord[] = [];
let removeSink: () => void;
beforeEach(() => {
  log.setConsole(false);
  removeSink = log.addSink(record => records.push(record));
});
afterEach(() => {
  try {
    for (const h of harnesses) h.host.stop();
    expect(records.filter(record => record.level === 'error')).toEqual([]);
  } finally {
    harnesses.clear();
    vi.restoreAllMocks();
    removeSink();
    log.setConsole(true);
    records.length = 0;
  }
});

function fixture(withPreDrop = false) {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let dropNext = false;
  const preDrop = definePlugin({
    id: 'test-pre-drop', name: 'Test pre-drop', apiVersion: 1, capabilities: ['packets'],
    register(ctx) {
      ctx.hookPacket('TEXT', (_client, packet) => {
        if (dropNext) packet.send = false;
      }, { prepend: true });
    },
  });
  const definitions = withPreDrop ? [chatFilter, preDrop] : [chatFilter];
  let h = startHost(definitions);
  harnesses.add(h);
  const client = 'one';
  const other = 'two';
  function connect(id: string, name: string) {
    h.connect(id);
    h.packet(id, 'CREATESUCCESS', { objectId: 42, charId: 1, stats: '' });
    h.packet(id, 'NEWTICK', { tickId: 1, tickTime: 0, serverRealTimeMs: 0, serverLastRttMs: 0,
      statuses: [{ objectId: 42, position: { x: 0, y: 0 }, data: [{ id: 31, value: name, stackCount: 0 }] }] });
  }
  function connectPlayers() { connect(client, 'Me'); connect(other, 'OtherMe'); }
  connectPlayers();
  function packet(text: string, extra: Record<string, unknown> = {}, connection = client, send = true) {
    dropNext = !send;
    const verdict = h.packet(connection, 'TEXT', textData({ name: 'Spammer', numStars: 20, text, cleanText: '', ...extra }));
    expect(verdict).toBeDefined();
    return verdict!;
  }
  function snapshot(): Profile {
    h.profile.flush();
    return JSON.parse(readFileSync(h.profile.path, 'utf8')) as Profile;
  }
  function reload(saved: Profile = snapshot()) {
    h.host.stop();
    harnesses.delete(h);
    writeJsonAtomic(h.profile.path, saved);
    h = startHost(definitions, { profileDir: h.profileDir });
    harnesses.add(h);
    expect(h.host.loaded()).toContain('chat-filter');
    connectPlayers();
  }
  const status = () => {
    h.host.context('chat-filter')!.updateSetting('refreshStatus', true);
    return h.host.data('chat-filter')!.get('status') as any;
  };
  return {
    get ctx() { return h.host.context('chat-filter')!; },
    get h() { return h; },
    client, other, packet, snapshot, reload, status,
    disconnect() { h.close(client); connect(client, 'Me'); },
    advance: (ms: number) => { now += ms; },
  };
}

describe('Modular chat filter through the real settings and packet adapter', () => {
  it.each(SPAM)('blocks advertisement and its suffix-free form: %s', text => {
    const f = fixture();
    expect(f.packet(text).data).toBeNull();
    expect(f.packet(text.replace(/\s+(?:\d+|<\d+>)$/, '')).data).toBeNull();
    expect(f.status().recent[0].reason).toBe('advertising');
  });

  it.each([
    'WTB a life potion', 'bulk keys for the guild tonight',
    'We cleared the realm together and our final guild score was 217',
    'Discord.gg/ourGuild join us', 'I read about Famazon yesterday',
    'The game cost me $9.99', '==============================',
    'I bought a shop item for $10',
    'is realm stock legit?', 'I <3 this <insert name> guy',
    'Does Realm Stock compare well?', 'Oryx shop community', 'Coinbase.com sent me $20 on Venmo',
    'Selling 8x Ring of Decades for 1x Rare Perennial Cranium      @nohulotae    <0>',
    'the dot in the middle of the map', 'realmeye(dot)com documents version 1.20', 'pair lod or ddock pls', 'add me to join guild w discord server',
  ])('allows ordinary chat by default: %s', text => {
    expect(fixture().packet(text).data).not.toBeNull();
  });

  it('scans both text fields and handles invisible characters/fullwidth/homoglyphs', () => {
    const f = fixture();
    expect(f.packet(SPAM[1]!, { cleanText: '' }).data).toBeNull();
    expect(f.packet('hello', { cleanText: SPAM[2] }).data).toBeNull();
    expect(f.packet(SPAM[1]!.replace('rea!mshop', 'ｒｅａ!ｍｓｈｏｐ')).data).toBeNull();
    expect(f.packet(SPAM[1]!.replace('rea!mshop', 'reа\u200blmshop')).data).toBeNull();
  });

  it('matches literal phrases, # and Unicode whole words without regex semantics', () => {
    const f = fixture();
    f.ctx.updateSetting('blockedWords', 'ass\n#tag\na.b\nслово');
    f.ctx.updateSetting('wordMatch', 'whole');
    expect(f.packet('class').data).not.toBeNull();
    expect(f.packet('an ass!').data).toBeNull();
    expect(f.packet('the #tag is here').data).toBeNull();
    expect(f.packet('axb').data).not.toBeNull();
    expect(f.packet('a.b').data).toBeNull();
    expect(f.packet('слово!').data).toBeNull();
    expect(f.packet('словом').data).not.toBeNull();
    f.ctx.updateSetting('wordMatch', 'contains');
    expect(f.packet('class').data).toBeNull();
  });

  it('keeps advertising, trade and custom words independent', () => {
    const f = fixture();
    f.ctx.updateSetting('advertising', false);
    f.ctx.updateSetting('blockedWords', 'famazon');
    expect(f.packet(SPAM[2]!).data).toBeNull();
    expect(f.packet(SPAM[0]!).data).not.toBeNull();
    f.ctx.updateSetting('trade', true);
    expect(f.packet('WTB life').data).toBeNull();
    f.ctx.updateSetting('blockedWordsEnabled', false);
    expect(f.packet(SPAM[2]!).data).not.toBeNull();
  });

  it('respects channel scope and exemptions but explicit blocks apply across channels', () => {
    const f = fixture();
    expect(f.packet(SPAM[0]!, { recipient: 'Me' }).data).toBeNull();
    for (const recipient of ['*guild*', '*party*', 'unclassified']) expect(f.packet(SPAM[0]!, { recipient }).data).not.toBeNull();
    expect(f.packet('Guild> ' + SPAM[0]).data).toBeNull();
    expect(f.packet('Party> ' + SPAM[0]).data).toBeNull();
    for (const name of ['Me', '', '*', '#', '[server]']) expect(f.packet(SPAM[0]!, { name }).data).not.toBeNull();
    expect(f.packet(SPAM[0]!, { numStars: -1 }).data).not.toBeNull();
    f.ctx.updateSetting('whispers', false);
    expect(f.packet(SPAM[0]!, { recipient: 'Me' }).data).not.toBeNull();
    f.ctx.updateSetting('blockedSenders', 'spammer');
    expect(f.packet('hello', { recipient: '*guild*' }).data).toBeNull();
  });

  it('uses exact new sender names, preserves legacy regex, and never resurrects a packet', () => {
    const f = fixture(true);
    f.ctx.updateSetting('blockedSenders', 'spam');
    expect(f.packet('hello').data).not.toBeNull();
    f.ctx.updateSetting('blacklist', '/spammer/g');
    expect(f.packet('hello').data).toBeNull();
    expect(f.packet('hello').data).toBeNull();
    f.ctx.updateSetting('allowedSenders', 'spammer');
    expect(f.packet('hello').data).toBeNull();
    expect(f.status().conflicts).toEqual(['spammer']);
    f.ctx.updateSetting('blacklist', '');
    expect(f.packet(SPAM[0]!).data).not.toBeNull();
    expect(f.packet('hello', {}, f.client, false).data).toBeNull();
  });

  it.each([
    ['blockedWords', 'x'.repeat(201)], ['blockedWords', Array(501).fill('a').join('\n')],
    ['wordMatch', 'regex'], ['advertising', 'false'], ['repeatCount', NaN],
    ['repeatCount', 1], ['muteMinutes', Infinity], ['whitelist', '/foo/q'],
    ['blacklist', '/(/'], ['previewMessage', 'x'.repeat(2001)],
  ])('rejects invalid server-side update %s', (key, value) => {
    const f = fixture();
    const before = f.ctx.getSetting(key as string);
    expect(f.ctx.updateSetting(key as string, value)).toBe(false);
    expect(f.ctx.getSetting(key as string)).toEqual(before);
  });

  it('suppresses repetition without muting ordinary repeated callouts', () => {
    const f = fixture(); f.ctx.updateSetting('autoMute', true);
    expect(f.packet('oryx up').data).not.toBeNull();
    expect(f.packet('oryx up').data).not.toBeNull();
    expect(f.packet('oryx up').data).toBeNull();
    expect(f.packet('different message').data).not.toBeNull();
    expect(f.status().mutes).toEqual([]);
    f.advance(20_000);
    expect(f.packet('oryx up').data).not.toBeNull();
  });

  it('mutes cross-channel repeat advertisers only when enabled, with fixed expiry and isolated clients', () => {
    const f = fixture(); f.ctx.updateSetting('autoMute', true);
    f.ctx.updateSetting('blockedWords', 'instock'); // Custom rules cannot mask independent advertising evidence.
    f.packet(SPAM[0]!); f.packet(SPAM[2]!, { recipient: 'Me' });
    expect(f.packet('hello').data).toBeNull();
    expect(f.packet('hello', {}, f.other).data).not.toBeNull();
    expect(f.packet('guild hello', { recipient: '*guild*' }).data).not.toBeNull();
    f.advance(599_000);
    expect(f.packet('hello again').data).toBeNull();
    f.advance(1000);
    expect(f.packet('hello after expiry').data).not.toBeNull();
    expect(f.status().mutes).toEqual([]);
  });

  it('does not escalate custom words or offenses outside the 60-second window', () => {
    const f = fixture(); f.ctx.updateSetting('autoMute', true);
    f.packet(SPAM[0]!); f.advance(60_000); f.packet(SPAM[2]!);
    expect(f.status().mutes).toEqual([]);
    f.ctx.updateSetting('blockedWords', 'foo');
    f.packet('foo'); f.packet('foo');
    expect(f.status().mutes).toEqual([]);
  });

  it.each(['disconnect', 'disable', 'master', 'profile', 'clear', 'allow'])('clears sender history on %s', how => {
    const f = fixture(); f.ctx.updateSetting('autoMute', true);
    f.packet(SPAM[0]!); f.packet(SPAM[1]!);
    expect(f.status().mutes).toHaveLength(1);
    if (how === 'disconnect') f.disconnect();
    if (how === 'disable') { f.ctx.enabled = false; f.ctx.enabled = true; }
    if (how === 'master') { f.ctx.updateSetting('enabled', false); f.ctx.updateSetting('enabled', true); }
    if (how === 'profile') f.reload();
    if (how === 'clear') f.ctx.updateSetting('clearMutes', true);
    if (how === 'allow') { f.ctx.updateSetting('selectedSender', 'Spammer'); f.ctx.updateSetting('allowSender', true); }
    expect(f.status().mutes).toEqual([]);
    expect(f.packet('hello').data).not.toBeNull();
  });

  it('previews rules without recording offenses and captures bodies only on opt-in', () => {
    const f = fixture(); f.ctx.updateSetting('autoMute', true);
    f.ctx.updateSetting('previewMessage', SPAM[2]);
    f.ctx.updateSetting('testMessage', true); f.ctx.updateSetting('testMessage', true);
    expect(f.status().preview.reason).toBe('advertising');
    expect(f.status().mutes).toEqual([]);
    f.packet(SPAM[0]!);
    expect(f.status().recent[0]).not.toHaveProperty('message');
    f.ctx.updateSetting('captureMessages', true);
    f.packet(SPAM[0]!);
    expect(f.status().recent[0].message).toBe(SPAM[0]);
    f.ctx.updateSetting('captureMessages', false);
    expect(f.status().recent).toEqual([]);
  });

  it('round-trips profiles, resets missing fields/absent plugin, and never replays action/preview inputs', () => {
    const f = fixture();
    f.ctx.updateSetting('blockedWords', 'foo'); f.ctx.updateSetting('advertising', false);
    f.ctx.updateSetting('previewMessage', 'private');
    const saved = f.snapshot();
    expect(saved.plugins['chat-filter']!.settings).not.toHaveProperty('previewMessage');
    expect(saved.plugins['chat-filter']!.settings).not.toHaveProperty('clearMutes');
    f.reload({ schemaVersion: 1, plugins: {} });
    expect(f.ctx.getSetting('advertising')).toBe(true);
    expect(f.ctx.getSetting('blockedWords')).toBe('');
    f.reload(saved);
    expect(f.ctx.getSetting('advertising')).toBe(false);
    expect(f.ctx.getSetting('blockedWords')).toBe('foo');
    f.reload({ schemaVersion: 1, plugins: { 'chat-filter': { settings: { blacklist: 'bot', previewMessage: 'ignored', blockSender: true } } } });
    expect(f.ctx.getSetting('blockedWords')).toBe('');
    expect(f.ctx.getSetting('trade')).toBe(true);
    expect(f.ctx.getSetting('previewMessage')).toBe('');
    expect(f.ctx.getSetting('blockedSenders')).toBe('');
    expect(f.status().actionResult).toBe('');
    f.reload({ schemaVersion: 1, plugins: {} });
    expect(f.ctx.getSetting('blacklist')).toBe('');
    expect(f.ctx.getSetting('trade')).toBe(false);
  });

  it('validates full profiles before mutating and preserves explicit legacy disable', () => {
    const f = fixture(); f.ctx.updateSetting('blockedWords', 'foo');
    f.reload({ schemaVersion: 1, plugins: { 'chat-filter': { enabled: false, settings: { blockedWords: 'bar', muteMinutes: -1 } } } });
    // RealmTool rejects the entire settings object; the host-level toggle remains independent.
    expect(f.ctx.enabled).toBe(false);
    for (const [key, value] of Object.entries(DEFAULTS)) expect(f.ctx.getSetting(key)).toEqual(value);
    expect(records.filter(record => record.level === 'warn')).toHaveLength(1);
    expect(records.find(record => record.level === 'warn')!.message).toMatch(/Chat Filter: saved settings are invalid.*using defaults/);
    expect(normalizeChatProfile({ enabled: false, trade: false }, true).enabled).toBe(false);
    f.reload({ schemaVersion: 1, plugins: { 'chat-filter': { settings: { enabled: false, trade: false } } } });
    expect(f.ctx.getSetting('enabled')).toBe(false);
    expect(f.ctx.getSetting('trade')).toBe(false);
    expect(f.packet(SPAM[0]!).data).not.toBeNull();
    // Profile entries are keyed by plugin id; reloading cannot create duplicate instances.
    expect(f.h.host.loaded()).toEqual(['chat-filter']);
    expect(records.filter(record => record.level === 'warn')).toHaveLength(1);
  });
});

describe('Chat advertising evasion regressions', () => {
  const ad = 'NNSN Enchanted Deca hp/loot for 0.20 ==realmshop (d0t)info== SSN Decas 0.99';
  const settings = compileSettings(DEFAULTS);
  const decide = (text: string, state = new SenderState(() => 0), name = 'PROCRAZY') =>
    evaluate({ name, text, recipient: '', numStars: 20 }, 'me', settings, state);

  it.each(['(d0t)', '[d0t]', '{d0t}', '( dot )', '(DOT)'])('folds %s only for advertising', dot => {
    expect(advertisingText(`example ${dot} info`)).toBe('example (dot) info');
    expect(readableText(`example ${dot} info`)).toBe(`example ${dot.toLowerCase()} info`);
    expect(advertisingText('what does d0t or dot mean')).toBe('what does d0t or dot mean');
    expect(decide(ad.replace('(d0t)', dot) + ' 666')).toMatchObject({ action: 'block', reason: 'advertising', ruleId: 'realmshop' });
  });

  it.each(['==realmshop (dot)info==', '===realmshop info===', '== realmshop(d0t)info =='])('blocks banner %s', text => {
    expect(decide(text)).toMatchObject({ action: 'block', reason: 'advertising', ruleId: 'realmshop' });
  });

  it.each(['com', 'net', 'info', 'gg', 'org', 'shop', 'store'])('recognizes known-shop domain suffix %s', tld => {
    for (const separator of ['.', '(d0t)', '[d0t]', '{d0t}', ' ', '']) {
      expect(decide(`realmshop${separator}${tld}`)).toMatchObject({ action: 'block', reason: 'advertising', ruleId: 'realmshop' });
      expect(decide(`realm stock${separator}${tld}`).action).toBe('block');
    }
    expect(decide(`realmshop ${tld}munity`).action).toBe('allow');
  });

  it.each(['r2realm.shop', 'r2realm shop', 'r2realmshop'])('checks evidence for overlapping campaign names: %s', text => {
    expect(decide(text)).toMatchObject({ action: 'block', reason: 'advertising', ruleId: 'r2realm' });
  });

  it.each(['0.20', '0.99', '12.49'])('requires a known shop for bare price %s', price => {
    expect(decide(`realmshop ${price}`)).toMatchObject({ action: 'block', reason: 'advertising', ruleId: 'realmshop' });
    expect(decide(`deca ${price}`).action).toBe('allow');
  });

  it('keeps scam warnings with sales words blocked', () => {
    expect(decide('realmshop is a scam dont buy')).toMatchObject({ action: 'block', reason: 'advertising', ruleId: 'realmshop' });
  });

  it('blocks all three changing-counter advertisements', () => {
    const state = new SenderState(() => 0);
    for (const counter of [666, 667, 668]) {
      expect(decide(`${ad} ${counter}`, state)).toMatchObject({ action: 'block', reason: 'advertising', ruleId: 'realmshop' });
    }
  });

  it.each([['666', '667', '668'], ['<666>', '<667>', '<668>']])('counts ordinary repeats with counters %s / %s / %s', (a, b, c) => {
    let now = 0;
    const state = new SenderState(() => now);
    expect(decide(`oryx up ${a}`, state).action).toBe('allow');
    expect(decide(`oryx up ${b}`, state).action).toBe('allow');
    expect(decide(`oryx up ${c}`, state).reason).toBe('repetition');
    expect(decide(`oryx up ${c}`, state, 'OtherPlayer').action).toBe('allow');
    now = (DEFAULTS.repeatWindowSeconds + 1) * 1000;
    expect(decide(`oryx up ${c}`, state).action).toBe('allow');
  });

  it.each([
    'anyone doing shatts?', 'oryx 3 in 2 min, 0.99 chance we fail lol',
    'patch 4.2.0 is out, anyone know if the loot boost is still on?',
    'my hp is at 0.20 of max lmao', 'trading my deca for 2 life', 'pots for sale? jk',
    'event at USWest 3 realm Lich', 'gg', 'thanks for the run', 'need healing please',
    'where is the portal?', 'anyone have a spare pot?', 'meet at nexus', 'nice white bag',
    'the bandit camp (dot) is on the map', 'brb 2.50 min', 'what does d0t mean', 'info pls',
  ])('allows ordinary chat: %s', text => {
    expect(decide(text)).toMatchObject({ action: 'allow', reason: 'no-match' });
  });
});

describe('Bounded sender state', () => {
  it('evicts oldest senders and preview clones cannot alter live history', () => {
    const state = new SenderState(() => 0, 2);
    const settings = compileSettings({ ...DEFAULTS, autoMute: true });
    const data = (name: string) => ({ name, text: SPAM[0], numStars: 20 });
    for (const name of ['a', 'b', 'c']) { evaluate(data(name), 'me', settings, state); evaluate(data(name), 'me', settings, state); }
    expect(state.isMuted('a')).toBe(false);
    expect(state.isMuted('b')).toBe(true);
    state.clone().forget('b');
    expect(state.isMuted('b')).toBe(true);
    expect(state.mutes()).toHaveLength(2);
  });
});

describe('settings groups', () => {
  it('assigns every Chat Filter setting its section and leaves schemaVersion, whitelist and blacklist ungrouped', () => {
    const expected: Record<string, string[]> = {
      'What to hide': ['enabled', 'trade', 'advertising', 'repetition', 'repeatCount', 'repeatWindowSeconds'],
      'Custom words': ['blockedWordsEnabled', 'blockedWords', 'wordMatch'],
      'Repeat advertisers': ['autoMute', 'muteMinutes'],
      'Where to filter': ['publicChat', 'whispers', 'guildChat', 'partyChat', 'unknownChat'],
      'Senders': ['allowedSenders', 'blockedSenders', 'selectedSender', 'unmuteSender', 'blockSender', 'allowSender', 'clearMutes'],
      'Test and diagnostics': ['previewMessage', 'previewSender', 'previewChannel', 'captureMessages', 'testMessage', 'refreshStatus'],
    };
    const h = startHost([chatFilter]);
    try {
      // The snapshot omits hidden settings (schemaVersion); the rest are exactly what registerSetting stored.
      const snapshot = h.host.snapshot()[0].settings;
      const groups = new Map<string, string | undefined>(snapshot.map(def => [def.key, def.group]));
      for (const [group, keys] of Object.entries(expected)) {
        for (const key of keys) expect([key, groups.get(key)]).toEqual([key, group]);
      }
      expect(snapshot.filter(def => def.group === undefined).map(def => def.key).sort()).toEqual(['blacklist', 'whitelist']);
      expect(snapshot.length).toBe(Object.values(expected).flat().length + 2);
      expect(SETTING_DEFS.find(def => def.key === 'schemaVersion')?.group).toBeUndefined();
    } finally { h.host.stop(); }
  });
});
