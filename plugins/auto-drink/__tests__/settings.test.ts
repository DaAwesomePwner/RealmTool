// Adapted from realm-engine-client client/src/plugins/__tests__/autoDrinkSettings.test.ts @ 88a66b2 (MIT, see NOTICE).
import { describe, expect, it } from 'vitest';
import { definePlugin } from '../../../src/plugins/api.ts';
import type { Profile } from '../../../src/config/store.ts';
import { DEFAULT_AUTO_DRINK_SETTINGS } from '../../../src/auto-drink/AutoDrinkTypes.ts';
import { DEFAULTS, migrate, validate, workerSettings } from '../settings.ts';
import { fixture, records, workerStatus } from './fixture.ts';

const savedChoices = { ...DEFAULTS, enableHp: false, hpThresholdPct: 0, enableMp: true, mpThresholdPct: 37,
  drinkIntervalMs: 850, inventoryFallback: true, healingOverTime: true, slotPriority: '3,1,2', excludedItems: '42,43', diagnostics: true };
const savedWorker = workerSettings(savedChoices, true);
const profile = (settings: unknown, enabled = true) => ({schemaVersion:1,plugins:{'auto-drink':{enabled,settings:settings as Record<string,unknown>}}});
const other = (id = 'other') => definePlugin({id,name:id,apiVersion:1,capabilities:['worker'],register(ctx){ctx.worker.configure({enabled:true});}});

describe('Auto Drink profiles through the real manager and worker facade',()=>{
  it('registers disabled factory settings and supplies settings/catalog to worker startup',()=>{
    const f=fixture(); expect(f.ctx.enabled).toBe(false);expect(f.config().settings).toEqual(DEFAULT_AUTO_DRINK_SETTINGS);expect(f.proxy.configured).toHaveLength(1);
  });
  it.each([[false,true],[true,false],[true,true],[false,false]])('publishes a single complete profile for enabled %s -> %s, preserving false and zero',(oldEnabled,enabled)=>{
    const old=fixture({profile:profile(savedChoices,oldEnabled)});expect(old.ctx.enabled).toBe(oldEnabled);
    const f=fixture({profile:profile({...savedChoices,slotPriority:' 3, 1, 2 ',excludedItems:'0x2a, 43, 00042'},enabled)});
    expect(f.proxy.configured).toHaveLength(1);expect(f.config().settings).toEqual({...savedWorker,enabled});
  });
  it.each([undefined,{}])('resets every absent setting to factory values on a full replay: %j',settings=>{
    fixture({profile:profile(savedChoices)});
    const f=fixture({profile:profile(settings,false)});expect(f.config().settings).toEqual(DEFAULT_AUTO_DRINK_SETTINGS);
  });
  it.each([
    {label:'missing entry',plugins:{}}, {label:'missing enabled/settings/hotkey',plugins:{'auto-drink':{}}},
    {label:'missing enabled with explicit choices',plugins:{'auto-drink':{settings:savedChoices}}},
  ])('defaults OFF and clears the previous hotkey for $label',({plugins})=>{
    const f=fixture({profile:{schemaVersion:1,plugins:plugins as Profile['plugins']}});expect(f.ctx.enabled).toBe(false);
    expect(f.config().settings).toEqual(plugins['auto-drink'] && 'settings' in plugins['auto-drink'] ? {...savedWorker,enabled:false}:DEFAULT_AUTO_DRINK_SETTINGS);
  });
  it('prepares without mutations and captures canonical values before the caller changes its input',()=>{
    const input={...savedChoices}; const prepared=migrate(input,true); input.enableHp=true;input.slotPriority='1,2';
    expect(prepared).toEqual(savedChoices);expect(fixture({profile:profile(prepared)}).config().settings).toEqual(savedWorker);
  });
  it('keeps the entire accepted worker config during every setting and enable callback',()=>{
    const f=fixture({profile:profile(savedChoices)});expect(f.proxy.configured).toHaveLength(1);expect(f.config().settings).toEqual(savedWorker);
  });
  it('applies both validated worker profiles once and preserves the AutoNexus prediction opt-in',()=>{
    // No prediction lane in 3a: a separate worker-capable plugin stands in for Auto Nexus.
    const f=fixture({profile:profile(savedChoices),others:[other('auto-nexus')]});
    expect(f.proxy.configured).toEqual([{'auto-drink':f.config(),'auto-nexus':{enabled:true}}]);
  });
  it('restricts the prepare wrapper to the bundled Auto Drink context',()=>{
    const denied=definePlugin({id:'denied',name:'denied',apiVersion:1,capabilities:[],register(ctx){ctx.worker.configure({});}});
    const f=fixture({others:[denied]});expect(f.host.loaded()).not.toContain('denied');expect(f.proxy.configured[0]).not.toHaveProperty('denied');
    expect(records.some(r=>r.message.includes('did not declare the "worker" capability'))).toBe(true);
  });
});

describe('Auto Drink strict validation and legacy migration',()=>{
  it.each([
    ['hpThresholdPct',-10,0],['hpThresholdPct',150,95],['mpThresholdPct',-1,0],['mpThresholdPct',96,95],
    ['drinkIntervalMs',-10,400],['drinkIntervalMs',650.9,650],['drinkIntervalMs',9999,5000],['strictSettingsVersion',9,1],
  ])('normalizes %s=%s to %s in individual updates and full snapshots',(key,value,expected)=>{
    expect(validate(key as string,value)).toBe(expected);expect(migrate({[key]:value},true)[key]).toBe(expected);
    const f=fixture();expect(f.ctx.updateSetting(key as string,value)).toBe(true);expect(f.ctx.getSetting(key as string)).toBe(expected);
  });
  const invalidValues:Array<[string,unknown]>=[
    ['hpThresholdPct','50'],['hpThresholdPct',null],['hpThresholdPct',NaN],['hpThresholdPct',BigInt(50)],
    ['mpThresholdPct',Infinity],['mpThresholdPct',-Infinity],['drinkIntervalMs','400'],['drinkIntervalMs',undefined],
    ['strictSettingsVersion','1'],['strictSettingsVersion',NaN],['enableHp','false'],['enableMp','true'],['inventoryFallback',1],['healingOverTime',null],['diagnostics','false'],
    ['slotPriority',[1,2,3]],['slotPriority','1,1,2'],['slotPriority','1,2'],['slotPriority','0,1,2'],['slotPriority','1,2,3,1'],['slotPriority','1,2,3junk'],['slotPriority',Symbol('slots')],
    ['excludedItems',[42]],['excludedItems',null],['excludedItems','42,wat'],['excludedItems','42,'],['excludedItems','-1'],['excludedItems','1.2'],['excludedItems','1e2'],['excludedItems','0xZZ'],
    ['excludedItems','2147483648'],['excludedItems','9007199254740993'],['excludedItems',{toString(){throw new Error('must not coerce');}}],
  ];
  it.each(invalidValues)('rejects malformed %s before any plugin, hotkey or worker mutation',(key,value)=>{
    expect(()=>migrate({hpThresholdPct:20,[key]:value},true)).toThrow(key);expect(()=>validate(key,value)).toThrow(key);
    const f=fixture({profile:profile({...savedChoices,[key]:value})});
    expect(f.config().settings).toEqual({...DEFAULT_AUTO_DRINK_SETTINGS,enabled:true});
    expect(records.filter(r=>r.level==='warn'&&r.message.includes('saved settings are invalid'))).toHaveLength(1);
    const before=f.config();const count=f.proxy.configured.length;
    expect(f.ctx.updateSetting(key,value)).toBe(false);expect(f.config()).toBe(before);expect(f.proxy.configured).toHaveLength(count);
    expect(f.ctx.updateSetting('hpThresholdPct',18)).toBe(true);expect(f.config().settings.hpThresholdPct).toBe(18);
  });
  it.each([{enabled:'false'},{enabled:null},{enabled:1},{settings:null},{settings:[]},{settings:'settings'},{settings:false}])('rejects malformed containers/enable flags: %j',entry=>{
    // Enabled belongs to the host envelope. The worker normalizer rejects it; migrate owns settings containers.
    if ('enabled' in entry) expect(()=>workerSettings({},entry.enabled as unknown as boolean)).toThrow();
    else expect(()=>migrate(entry.settings,true)).toThrow();
  });
  it.each(['auto-drink','auto-nexus'])('rejects duplicate %s entries before either worker publication',id=>{
    // RT profiles are keyed records; duplicate definitions are rejected by the host before registration.
    const f=fixture({others:id==='auto-drink'?[other(id)]:[other(id),other(id)]});
    expect(f.host.loaded().filter(v=>v===id)).toHaveLength(1);expect(records.filter(r=>r.message.includes('Duplicate plugin id'))).toHaveLength(1);
  });
  it('validates AutoNexus before applying an otherwise valid Auto Drink profile',()=>{
    const peer=other('auto-nexus');peer.settings={migrate(){throw new Error('PreHitPrediction unavailable');}};
    const f=fixture({profile:profile(savedChoices),others:[peer]});expect(f.host.loaded()).not.toContain('auto-nexus');
    expect(f.config().settings).toEqual(savedWorker);expect(f.proxy.configured).toHaveLength(1);
  });
  it('enforces text/select types and declared options before callbacks',()=>{
    const f=fixture({others:[{id:'typed',name:'typed',apiVersion:1,capabilities:[],register(ctx){
      ctx.registerSetting('text',{type:'text',label:'Text',value:''});ctx.registerSetting('choice',{type:'select',label:'Choice',value:'one',options:[{label:'One',value:'one'}]});
    }}]});const ctx=f.host.context('typed')!;
    for(const [key,value] of [['text',1],['text',null],['choice',true],['choice','unknown']] as const)expect(ctx.updateSetting(key,value)).toBe(false);
    expect(ctx.updateSetting('text','saved')).toBe(true);expect(ctx.getSetting('text')).toBe('saved');
  });
  it('canonicalizes exclusions to unique decimal IDs and keeps a complete slot permutation',()=>{
    expect(migrate({excludedItems:'0X7fffffff, 0, 00042, 0x2a',slotPriority:' 2, 3, 1 '},true)).toMatchObject({excludedItems:'2147483647,0,42',slotPriority:'2,3,1'});
    expect(validate('excludedItems',' ')).toBe('');
  });
  it.each([[0,400],[125,400],[-1,400],[850.9,850],[9999,5000],['850',400],[NaN,400],[Infinity,400],[null,400],[BigInt(850),400]])('migrates only finite numeric legacy cooldowns (case %#)',(drinkCooldownMs,intervalMs)=>{
    expect(migrate({enableHp:false,enableMp:true,hpThresholdPct:0,mpThresholdPct:0,drinkCooldownMs,hpPanicPct:'invalid retired value',maxBurst:BigInt(99),preferBelt:true},true)).toEqual({...DEFAULTS,enableHp:false,enableMp:true,hpThresholdPct:0,mpThresholdPct:0,drinkIntervalMs:intervalMs});
  });
  it('gives the new interval key precedence and rejects an invalid new value instead of migrating',()=>{
    expect(migrate({drinkIntervalMs:0,drinkCooldownMs:1200},true).drinkIntervalMs).toBe(400);
    for(const drinkIntervalMs of ['500',undefined,null,NaN])expect(()=>migrate({drinkIntervalMs,drinkCooldownMs:1200},true)).toThrow('drinkIntervalMs');
  });
  it('ignores unknown keys/buttons and leaves other plugins partial/coercion behavior intact',()=>{
    expect(migrate({action:true,unknown:BigInt(1)},true)).toEqual(DEFAULTS);
    const f=fixture();expect(f.ctx.updateSetting('unknown',1)).toBe(false);expect(()=>JSON.stringify(migrate({unknown:BigInt(1)},true))).not.toThrow();
  });
});

describe('Auto Drink publication rollback and listener ownership',()=>{
  it.each(['setting','enabled','rollback'])('aborts both lanes when the second AutoNexus %s callback fails',failure=>{
    // Per-module rejection replaces old cross-plugin callback rollback.
    const f=fixture({profile:profile(savedChoices),others:[other('auto-nexus')]});const before=f.config();const n=f.proxy.configured.length;
    const key=failure==='setting'?'hpThresholdPct':failure==='enabled'?'enableHp':'slotPriority';
    expect(f.ctx.updateSetting(key,{})).toBe(false);expect(f.config()).toBe(before);expect(f.proxy.configured).toHaveLength(n);
  });
  it.each([true,false])('restores callback locals, dashboard and Proxy cache on rejected send (enabled=%s)',enabled=>{
    const f=fixture({profile:profile(savedChoices,enabled)});f.status();const data=f.data();const before=f.config();
    expect(f.ctx.updateSetting('excludedItems','42,wat')).toBe(false);expect(f.data()).toBe(data);expect(f.config()).toBe(before);
    f.ctx.updateSetting('hpThresholdPct',18);expect(f.config().settings).toEqual({...savedWorker,enabled,hpThresholdPct:18});
  });
  it.each(['setting','enable','rollback'])('discards failed %s callbacks without sending and clears batching for retry',failure=>{
    const f=fixture();const before=f.config();const key=failure==='setting'?'drinkIntervalMs':failure==='enable'?'enableMp':'excludedItems';
    expect(f.ctx.updateSetting(key,null)).toBe(false);expect(f.config()).toBe(before);
    expect(f.ctx.updateSetting('hpThresholdPct',18)).toBe(true);expect(f.config().settings.hpThresholdPct).toBe(18);
    f.host.stop();expect(f.config().settings.enabled).toBe(false);
  });
  it.each([false,true])('routes status/catalog while disabled and removes listeners on unload (enabled=%s)',enabled=>{
    const f=fixture();f.ctx.enabled=enabled;f.status();expect(f.data()).toEqual({...workerStatus,clientId:'connection-a'});
    expect(f.config().items).toHaveLength(1);const data=f.data();f.host.stop();f.status({...workerStatus,epoch:3});expect(f.data()).toBe(data);
    expect(f.proxy.listenerCount('module')).toBe(0);expect(f.config().settings.enabled).toBe(false);
  });
});

describe('Combined automationSettings in the real network worker',()=>{
  it('installs both configurations for live and future sessions in a single message',()=>{
    const f=fixture({profile:profile(savedChoices),others:[other()]});expect(f.proxy.configured).toHaveLength(1);
    expect(Object.keys(f.proxy.configured[0])).toEqual(['auto-drink','other']);
    const before=f.proxy.configured[0];f.connect();f.connect('c2');
    expect(f.proxy.configured).toEqual([before]);expect(f.config().settings).toEqual(savedWorker);
  });
  it.each(['safety','drink'])('rejects invalid %s input before changing either live sessions or startup baselines',invalid=>{
    const peer=definePlugin({id:'other',name:'other',apiVersion:1,capabilities:['worker'],
      settings:{migrate(input){if(input!==undefined)throw new Error('Invalid safety input');return {threshold:20};}},
      register(ctx){ctx.registerSetting('threshold',{type:'number',label:'Threshold',value:20},()=>ctx.worker.configure({threshold:ctx.getSetting('threshold')}));},
    });
    const saved=profile(invalid==='drink'?{hpThresholdPct:'bad'}:savedChoices);
    const f=fixture({profile:{...saved,plugins:{...saved.plugins,other:invalid==='safety'?{settings:{threshold:null}}:{}}},others:[peer]});
    expect(f.proxy.configured).toHaveLength(1);expect(f.config().settings.hpThresholdPct).toBe(invalid==='drink'?50:0);
    expect(f.proxy.configured[0].other).toEqual({threshold:20});
    expect(records.filter(r=>r.level==='warn'&&r.message.includes('saved settings are invalid'))).toHaveLength(1);
  });
});
