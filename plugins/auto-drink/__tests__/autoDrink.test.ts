// Adapted from realm-engine-client client/src/plugins/__tests__/autoDrinkPlugin.test.ts @ 88a66b2 (MIT, see NOTICE).
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTO_DRINK_SETTINGS as defaults } from '../../../src/auto-drink/AutoDrinkTypes.ts';
import { parseExcludedItems, parseSlotPriority, SETTING_DEFS } from '../settings.ts';
import { fixture, records, workerStatus, item, catalog } from './fixture.ts';
import { readGameBuild } from '../../../src/game/gameBuild.ts';
import { createAutoDrinkModule } from '../worker.ts';
import { SessionAutomation } from '../../../src/transport/automation.ts';
import type { AutoDrinkEvent } from '../messages.ts';

describe('Auto Drink facade through the RealmTool host', () => {
  it('disarms stale data immediately and cannot re-enable it until verified reload', () => {
    const f = fixture(); f.ctx.enabled = true;
    f.host.notifyDataInvalidated('game files changed');
    expect(f.config().items).toEqual([]);
    f.ctx.enabled = false; f.ctx.enabled = true; f.connect();
    expect(f.config().items).toEqual([]);
    f.host.notifyDataRefreshed(); expect(f.config().items).toEqual([item]);
  });
  it('reloads into the current session and keeps the previous catalog on failure', () => {
    const f = fixture({ catalog: { ok: false, reason: 'missing' } }); f.connect();
    expect(f.config().items).toEqual([]);
    f.loader.mockReturnValue(catalog); f.host.notifyDataRefreshed();
    expect(f.config().items).toEqual([item]);
    expect(f.config().gameBuild).toBe('test-build');
    const before = f.config(), count = f.proxy.configured.length;
    f.loader.mockReturnValue({ ok: false, reason: 'bad' }); f.host.notifyDataRefreshed();
    expect(f.config()).toBe(before); expect(f.proxy.configured).toHaveLength(count);
    f.loader.mockImplementation(() => { throw new Error('fixture reload failure'); }); f.host.notifyDataRefreshed();
    expect(f.config()).toBe(before);
  });
  it('retries a thrown reload on the next session', () => {
    const f = fixture(); f.ctx.enabled = true;
    f.host.notifyDataInvalidated('stale');
    f.loader.mockReturnValue({ ok: false, reason: 'transient failure' });
    f.host.notifyDataRefreshed();
    expect(records.some(r => r.message.includes('Catalog reload failed'))).toBe(true);
    expect(f.config().items).toEqual([]);
    f.loader.mockReturnValue(catalog); f.connect();
    expect(f.config().items).toEqual([item]);
  });
  it('retries failed reloads mid-session at most once per 15 seconds, except while invalidated', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); f.ctx.enabled = true;
    const client = f.connect();
    const send = () => f.workerMessage(client, 'auto-drink', { type: 'status', generation: 1, status: workerStatus });
    f.host.notifyDataInvalidated('stale');
    const before = f.loader.mock.calls.length;
    send(); expect(f.loader).toHaveBeenCalledTimes(before);
    f.loader.mockImplementation(() => { throw new Error('disk busy'); });
    f.host.notifyDataRefreshed();
    send();
    const failed = f.loader.mock.calls.length;
    f.loader.mockReturnValue(catalog);
    now = 14_999; send(); expect(f.loader).toHaveBeenCalledTimes(failed);
    expect(f.config().items).toEqual([]);
    now = 15_000; send();
    expect(f.loader).toHaveBeenCalledTimes(failed + 1);
    expect(f.config().items).toEqual([item]);
  });
  it('does not sync an unchanged catalog retry', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture({ catalog: { ok: false, reason: 'missing' } }); f.ctx.enabled = true;
    const client = f.connect();
    const before = f.proxy.configured.length, reads = f.loader.mock.calls.length;
    const send = () => f.workerMessage(client, 'auto-drink', { type: 'status', generation: 1, status: workerStatus });
    send(); now = 15_000; send();
    expect(f.loader).toHaveBeenCalledTimes(reads + 2);
    expect(f.proxy.configured).toHaveLength(before);
  });
  it('starts disabled before the enable callback, publishes strict defaults and an offline status', () => {
    const timer=vi.spyOn(globalThis,'setInterval');const f=fixture();
    expect(f.ctx.name).toBe('Auto Drink');expect(f.ctx.category).toBe('automation');expect(f.ctx.enabled).toBe(false);
    expect(f.data()).toEqual({enabled:false,state:'disabled',reason:'Auto Drink is disabled',hp:null,maxHp:0,
      slotId:null,itemType:null,lastAttemptAt:null,cooldownRemainingMs:0,pending:false,epoch:0,clientId:null});
    expect(f.proxy.injected).toEqual([]);expect(timer).not.toHaveBeenCalled();
  });
  it('publishes waiting/disabled toggles without a worker session or fabricated attempts',()=>{
    const f=fixture();const disabled=f.data();
    for(const enabled of [true,false,true,false]){
      f.ctx.enabled=enabled;expect(f.data()).toEqual(enabled?{...disabled,enabled:true,state:'waiting',reason:'Waiting for worker status'}:disabled);
      expect(f.config().settings.enabled).toBe(enabled);expect(f.proxy.injected).toEqual([]);
    }
  });
  it('registers the profile/UI contract with advanced opt-ins and the cross-plugin warning', () => {
    const f = fixture();
    expect(f.ctx.enabled).toBe(false); expect(f.config().settings).toEqual(defaults);
    expect(f.data()).toMatchObject({ reason: 'Auto Drink is disabled', clientId: null });
    const def = (key: string) => SETTING_DEFS.find(d => d.key === key);
    expect(def('hpThresholdPct')).toMatchObject({ min: 0, max: 95, step: 5, warnWhen: { pluginId: 'auto-nexus', key: 'ForceAutoNexusHealth', cmp: 'gte' } });
    expect(def('drinkIntervalMs')).toMatchObject({ min: 400, max: 5000, step: 50 });
    expect(def('strictSettingsVersion')).toMatchObject({ hidden: true, min: 1, max: 1 });
    for (const key of ['enableMp', 'mpThresholdPct', 'inventoryFallback', 'healingOverTime', 'slotPriority', 'excludedItems', 'diagnostics']) expect(def(key)?.advanced).toBe(true);
    for (const key of ['hpPanicPct', 'maxBurst', 'preferBelt', 'drinkCooldownMs']) expect(f.ctx.updateSetting(key, 1)).toBe(false);
  });
  it('replays saved values through real callbacks and maps UI strings to worker fields', () => {
    const f = fixture();
    for (const [k,v] of Object.entries({ enableHp: false, hpThresholdPct: 0, enableMp: true, mpThresholdPct: 37,
      drinkIntervalMs: 850, inventoryFallback: true, healingOverTime: true, slotPriority: '3, 1, 2', excludedItems: '0x2a, 43, 42', diagnostics: true })) expect(f.ctx.updateSetting(k,v)).toBe(true);
    f.ctx.enabled = true;
    expect(f.config().settings).toEqual({ enabled: true, enableHp: false, hpThresholdPct: 0, enableMp: true, mpThresholdPct: 37,
      intervalMs: 850, inventoryFallback: true, healingOverTime: true, slotPriority: [2,0,1], excludedItems: [42,43] });
    expect(f.ctx.getSetting('slotPriority')).toBe('3,1,2'); expect(f.ctx.getSetting('excludedItems')).toBe('42,43');
    f.ctx.enabled = false; expect(f.config().settings.enabled).toBe(false);
  });
  it('keeps normalized numeric values and the fixed version visible in snapshots', () => {
    const f = fixture();
    for (const [k,v,e] of [['hpThresholdPct',-10,0],['mpThresholdPct',150,95],['drinkIntervalMs',125,400],['drinkIntervalMs',650.9,650],['drinkIntervalMs',9999,5000],['strictSettingsVersion',9,1]] as const) {
      expect(f.ctx.updateSetting(k,v)).toBe(true); expect(f.ctx.getSetting(k)).toBe(e);
    }
    expect(f.config().settings).toMatchObject({ hpThresholdPct: 0, mpThresholdPct: 95, intervalMs: 5000 });
  });
  it.each(['1,1,2','0,1,2','1,2','3,2,1,0','1,2,3junk','1,,3',''])('retains the prior valid priority on %j', value => {
    const f=fixture(); f.ctx.updateSetting('slotPriority','2,3,1'); const before=f.config();
    expect(f.ctx.updateSetting('slotPriority',value)).toBe(false);
    expect(f.ctx.getSetting('slotPriority')).toBe('2,3,1'); expect(f.config()).toBe(before);
  });
  it.each(['42,wat','0xZZ','-1','1.2','42,','42,,43','Infinity','2147483648','1e2'])('retains all prior exclusions on %j',value=>{
    const f=fixture(); f.ctx.updateSetting('excludedItems','0x2A, 43'); const before=f.config();
    expect(f.ctx.updateSetting('excludedItems',value)).toBe(false); expect(f.config()).toBe(before);
    expect(f.ctx.getSetting('excludedItems')).toBe('42,43');
    f.ctx.updateSetting('excludedItems',' '); expect(f.config().settings.excludedItems).toEqual([]);
  });
  it('copies outgoing arrays so a receiver cannot mutate later config replays',()=>{
    const f=fixture(); f.config().settings.slotPriority.reverse(); f.config().settings.excludedItems.push(99);
    f.ctx.enabled=true; expect(f.config().settings).toEqual({...defaults,enabled:true});
  });
  it('publishes one canonical config per normalized change while disabled',()=>{
    const f=fixture(); f.proxy.configured.length=0;
    f.ctx.updateSetting('slotPriority',' 3, 2, 1 '); f.ctx.updateSetting('excludedItems','0X7fffffff, 0, 00042, 0x2a'); f.ctx.updateSetting('drinkIntervalMs',777.9);
    expect(f.proxy.configured).toHaveLength(3); expect(f.config().settings).toEqual({...defaults,slotPriority:[2,1,0],excludedItems:[2147483647,0,42],intervalMs:777});
  });
  it('rejects non-text priority and exclusion inputs before callback normalization',()=>{
    for(const value of [null,undefined,true,123,[1,2,3],{},NaN]) {expect(parseSlotPriority(value)).toBeNull();expect(parseExcludedItems(value)).toBeNull();}
  });
  it('loads an existing catalog on registration without enabling the worker',()=>{
    const f=fixture(); expect(f.loader).toHaveBeenCalledTimes(1); expect(f.config()).toEqual({settings:defaults,items:[item],gameBuild:'test-build',gameDir:'C:/fixture/game'});
    expect(records.some(r=>r.message==='Loaded 1 verified restorative consumables (game build test-build).')).toBe(true);
    expect(f.buildReader).toHaveBeenCalledExactlyOnceWith('C:/fixture/game');
    expect(f.ctx.gameDir).toBe('C:/fixture/game');
  });
  it('rejects a catalog generated for another installed build with the exact recovery log', () => {
    const f = fixture({ buildReader: () => 'installed-build' });
    expect(f.config().items).toEqual([]);
    expect(records.map(r => r.message)).toContain('Consumables catalog unavailable: catalog is for game build test-build but the installed game is installed-build; RealmTool refreshes game data automatically; if it keeps failing, use "Refresh game data" in RealmTool and check the log');
    expect(records.some(r => r.message.startsWith('Loaded '))).toBe(false);
  });
  it('rechecks each connection, disables a stale catalog and restores it when the installed build matches again', () => {
    let build = 'test-build';
    const f = fixture({ buildReader: () => build });
    f.ctx.enabled = true;
    f.status();
    f.proxy.configured.length = 0;
    records.length = 0;
    build = 'updated-build';
    f.connect('updated');
    const reason = 'catalog is for game build test-build but the installed game is updated-build; RealmTool refreshes game data automatically; if it keeps failing, use "Refresh game data" in RealmTool and check the log';
    expect(f.config().items).toEqual([]);
    expect(f.data().reason).toBe(`consumables catalog unavailable: ${reason}`);
    expect(records.map(r => r.message)).toEqual([`Consumables catalog unavailable: ${reason}`]);
    f.connect('still-updated');
    expect(f.proxy.configured).toHaveLength(1);
    expect(records).toHaveLength(1);
    build = 'test-build';
    f.connect('restored');
    expect(f.config().items).toEqual([item]);
    expect(f.data().reason).toBe(workerStatus.reason);
    expect(records.at(-1)?.message).toBe('Loaded 1 verified restorative consumables (game build test-build).');
    // Fallback connections now re-read disk so transient reload failures can recover.
    expect(f.loader).toHaveBeenCalledTimes(3);
  });
  it('rechecks on enable after a connection arrived while the host gated disabled plugin events', () => {
    let build = 'test-build';
    const f = fixture({ buildReader: () => build });
    build = 'updated-build';
    f.connect();
    f.ctx.enabled = true;
    expect(f.config().items).toEqual([]);
    expect(f.data().reason).toContain('installed game is updated-build');
  });
  it.each([
    { catalog: { ok: false as const, reason: 'catalog missing' } },
    { catalog: { ok: false as const, reason: 'invalid catalog' } },
    { buildReader: () => 'wrong-build' },
    { gameDir: null },
    { buildReader: () => { throw new Error('boot.config unreadable'); } },
  ])('preserves catalog failure in stored and broadcast status through worker replies and toggles: %j', options => {
    const f = fixture(options);
    const reason = records.find(r => r.message.startsWith('Consumables catalog unavailable: '))!.message;
    const expected = reason[0].toLowerCase() + reason.slice(1);
    expect(f.data().reason).toBe(expected);
    const broadcast = vi.spyOn(f.ctx, 'broadcastData');
    for (const enabled of [true, false]) {
      f.ctx.enabled = enabled;
      f.status();
      expect(f.data()).toEqual({ ...workerStatus, reason: expected, clientId: 'connection-a' });
      expect(broadcast).toHaveBeenLastCalledWith('status', f.data());
    }
  });
  it('rejects the catalog when the game directory is unknown without invoking the build reader', () => {
    const f = fixture({ gameDir: null });
    expect(f.config().items).toEqual([]);
    expect(f.ctx.gameDir).toBeNull();
    expect(f.buildReader).not.toHaveBeenCalled();
    expect(records.map(r => r.message)).toContain('Consumables catalog unavailable: installed game build unknown (game directory unavailable)');
  });
  it('rejects the catalog when boot.config cannot be read and reports the path', () => {
    const f = fixture({ gameDir: 'C:/fixture/missing-game', buildReader: readGameBuild });
    expect(f.config().items).toEqual([]);
    expect(records.some(r => r.message.startsWith('Consumables catalog unavailable: installed game build unknown (')
      && r.message.includes('boot.config') && r.message.includes('ENOENT'))).toBe(true);
  });
  it('retains catalog load errors after determining build preference', () => {
    const f = fixture({ catalog: { ok: false, reason: 'catalog missing' } });
    expect(f.config().items).toEqual([]); expect(f.buildReader).toHaveBeenCalledExactlyOnceWith('C:/fixture/game');
    expect(records.map(r => r.message)).toContain('Consumables catalog unavailable: catalog missing');
  });
  it('receives exactly one final disconnected worker status on close despite the status throttle', () => {
    const f = fixture(); f.ctx.enabled = true; const id = f.connect();
    const module = createAutoDrinkModule(); module.configure!(f.config());
    const events: AutoDrinkEvent[] = [];
    const hooks = module.createSession({ sessionId: id, factory: f.factory, automation: new SessionAutomation(),
      generation: () => 7, now: () => 10, writePriority: () => false,
      transport: () => ({ available: true, backlog: false, upstreamBackpressure: false }), held: () => [], pendingDelivery: () => [],
      post(message) { events.push(message as AutoDrinkEvent); f.workerMessage(id, 'auto-drink', message); },
    });
    hooks.tick?.(10); expect(f.data().reason).not.toBe('disconnected');
    hooks.close?.(); f.close(id); hooks.close?.();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'status', generation: 7, status: { state: 'blocked', reason: 'disconnected', pending: false } });
    expect(f.data()).toMatchObject({ clientId: id, state: 'blocked', reason: 'disconnected', pending: false });
  });
  it('recovers from an empty initial catalog and replaces it on each reload, including removals',()=>{
    // JSON is loaded at registration; recovery/removal takes effect at the next host startup.
    const missing=fixture({catalog:{ok:false,reason:'missing'}}); expect(missing.config().items).toEqual([]);
    expect(records.some(r=>r.message==='Consumables catalog unavailable: missing')).toBe(true);
    expect(fixture().config().items).toEqual([item]);
    expect(fixture({catalog:{ok:false,reason:'invalid'}}).config().items).toEqual([]);
  });
  it('relays authoritative status with ownership without changing packet/config state',()=>{
    const f=fixture(); f.proxy.configured.length=0; f.status(); expect(f.data()).toEqual({...workerStatus,clientId:'connection-a'});
    f.status({...workerStatus,epoch:1,hp:20},'connection-b'); expect(f.data()).toMatchObject({clientId:'connection-b',epoch:1,hp:20});
    expect(workerStatus).not.toHaveProperty('clientId'); expect(f.proxy.configured).toEqual([]); expect(f.proxy.injected).toEqual([]);
  });
  it('preserves reported fields across toggles until the worker reports a new outcome',()=>{
    const f=fixture(); f.ctx.enabled=true; f.status(); f.ctx.enabled=false;
    expect(f.data()).toEqual({...workerStatus,enabled:false,state:'disabled',reason:'Auto Drink is disabled',clientId:'connection-a'});
    f.ctx.enabled=true; expect(f.data()).toEqual({...workerStatus,state:'waiting',reason:'Waiting for worker status',clientId:'connection-a'});
    f.status({...workerStatus,state:'ready',reason:'above thresholds',hp:80,pending:false}); expect(f.data().hp).toBe(80);
  });
  it('keeps synchronous worker toggle replies instead of replacing them with local waiting status',()=>{
    const f=fixture(); vi.spyOn(f.proxy,'configureModules').mockImplementation(configs=>{
      const enabled=(configs['auto-drink'] as {settings:{enabled:boolean}}).settings.enabled;
      f.status({...workerStatus,enabled,state:enabled?'cooldown':'disabled',reason:'worker reply'});
    });
    for(const enabled of [true,false]){f.ctx.enabled=enabled;expect(f.data()).toMatchObject({enabled,reason:'worker reply'});}
  });
  it('logs status transitions only when diagnostics are enabled and deduplicates cooldown ticks',()=>{
    const f=fixture(); records.length=0; f.status(); expect(records).toEqual([]);
    f.ctx.updateSetting('diagnostics',true); f.status(); f.status({...workerStatus,cooldownRemainingMs:200}); expect(records).toHaveLength(1);
    f.status({...workerStatus,state:'ready',reason:'eligible',pending:false});expect(records).toHaveLength(2);
    f.ctx.updateSetting('diagnostics',false);f.status();expect(records).toHaveLength(2);
  });
  it('keeps diagnostic deduplication independent for separate connections',()=>{
    const f=fixture(); f.ctx.updateSetting('diagnostics',true);records.length=0;
    for(const id of ['a','b','a','b']) f.status(workerStatus,id);
    expect(records).toHaveLength(2);expect(records[0].message).toContain('[a]');expect(records[1].message).toContain('[b]');
  });
  it('cleanup sends only a disable and retires callbacks without clearing connection cooldown/catalog',()=>{
    const f=fixture(); f.ctx.enabled=true;f.status();f.proxy.configured.length=0;f.host.stop();
    expect(f.proxy.configured).toHaveLength(1);expect(f.config()).toMatchObject({settings:{enabled:false},items:[item]});
    const old=f.data();f.ctx.enabled=true;f.ctx.updateSetting('hpThresholdPct',75);f.status({...workerStatus,hp:90});
    expect(f.proxy.configured).toHaveLength(1);expect(f.data()).toEqual(old);expect(f.proxy.listenerCount('module')).toBe(0);
  });
});
