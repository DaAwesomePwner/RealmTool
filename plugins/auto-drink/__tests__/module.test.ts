import { afterEach, expect, it, vi } from 'vitest';
import { createFactory } from '../../../src/protocol/schema.ts';
import { SessionAutomation } from '../../../src/transport/automation.ts';
import type { WorkerSessionContext } from '../../../src/transport/modules.ts';
import { AutoDrinkController } from '../../../src/auto-drink/AutoDrinkController.ts';
import { DEFAULT_AUTO_DRINK_SETTINGS } from '../../../src/auto-drink/AutoDrinkTypes.ts';
import { createAutoDrinkModule } from '../worker.ts';
import type { AutoDrinkEvent } from '../messages.ts';
import { validateConfig } from '../messages.ts';

const cleanups: (()=>void)[]=[];
afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.restoreAllMocks();});
async function fixture(buildReader: (dir: string) => Promise<string> = async () => 'test-build') {
  let now=0,generation=1;
  const module=createAutoDrinkModule(buildReader);
  const settings={...DEFAULT_AUTO_DRINK_SETTINGS,enabled:true};
  const items=[{type:10,name:'HP',hp:100,mp:0,healingDurationMs:0,quickslot:true}];
  module.configure!({settings,items,gameBuild:'test-build',gameDir:'fixture'});
  const events:AutoDrinkEvent[]=[];
  const factory=createFactory();
  const automation=new SessionAutomation();automation.reset(generation);
  const write=vi.fn(()=>true);
  const context:WorkerSessionContext={sessionId:'s',factory,automation,generation:()=>generation,now:()=>now,
    writePriority:write,transport:()=>({available:true,backlog:false,upstreamBackpressure:false}),held:()=>[],pendingDelivery:()=>[],post:e=>events.push(e as AutoDrinkEvent)};
  const hooks=module.createSession(context);cleanups.push(()=>hooks.close?.());hooks.connectionChanged?.(generation);
  const packet=(name:string,data:Record<string,unknown>={})=>{const p=factory.createByName(name);p.data=data;return p;};
  const spawn=()=>{
    for(const [name,data] of [['MAPINFO',{name:'Realm'}],['CREATESUCCESS',{objectId:1}],['UPDATE',{newObjs:[{status:{objectId:1,position:{x:1.5,y:2.5},data:[
      {id:0,value:1000},{id:1,value:400},{id:29,value:0},{id:95,value:0},{id:116,value:10,stackCount:3},
    ]}}]}]] as const)hooks.observe?.(packet(name,data),false,now,1);
    hooks.written?.(packet('PONG',{serial:1,time:1000+now}),'normal',now,1,null);
  };
  spawn();
  await Promise.resolve();
  return {module,hooks,context,settings,items,write,events,packet,spawn,
    advance:(ms=0)=>{now+=ms;hooks.tick?.(now);},
    next:()=>{automation.reset(++generation);hooks.connectionChanged?.(generation);spawn();},
  };
}
it('does not pass its own USEITEM to observeOutgoing, but observes game USEITEM',async()=>{
  const f=await fixture();const observe=vi.spyOn(AutoDrinkController.prototype,'observeOutgoing');
  const use=f.packet('USEITEM',{time:1000,slotObject:{objectId:1,slotId:1000000,objectType:10}});
  f.hooks.written?.(use,'priority',0,null,'auto-drink');expect(observe).not.toHaveBeenCalled();
  f.hooks.written?.(use,'normal',0,4,null);expect(observe).toHaveBeenCalledExactlyOnceWith(use);
});
it.each(['accepted','rejected','manual'])('disarms for the entire generation on a %s escape latch',async reason=>{
  const f=await fixture();const escape=vi.spyOn(AutoDrinkController.prototype,'escape');
  f.context.automation.latchEscape(reason);f.advance();f.spawn();f.advance(400);
  f.module.configure!({settings:f.settings,items:f.items,gameBuild:'test-build',gameDir:'fixture'});await Promise.resolve();f.advance(400);
  expect(f.write).not.toHaveBeenCalled();expect(escape).toHaveBeenCalledTimes(1);
  f.next();f.advance();expect(f.write).toHaveBeenCalledTimes(1);
});
it('a missing catalog reports no eligible stock and never writes',async()=>{
  const f=await fixture();f.module.configure!({settings:f.settings,items:[],gameBuild:'test-build',gameDir:'fixture'});await Promise.resolve();f.advance();
  expect(f.events.at(-1)?.status.reason).toBe('no eligible stock');expect(f.write).not.toHaveBeenCalled();
});
it('subscribes to accepted RECONNECT writes and disarms without relying on Auto Nexus', async () => {
  const f = await fixture();
  expect(f.module.observe?.server).not.toContain('RECONNECT');
  expect(f.module.writtenServer).toContain('RECONNECT');
  f.hooks.writtenServer?.(f.packet('RECONNECT'), 'normal', 0, null);
  expect(f.context.automation.escapeLatched()).toBe(false);
  f.advance();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.status.reason).toBe('escape lifecycle');
});
it.each(['settings','items','both'])('rejects invalid %s before mutating live or future sessions',async part=>{
  const f=await fixture();const config={settings:{...f.settings,enabled:false},items:f.items,gameBuild:'test-build',gameDir:'fixture'};
  const invalid=part==='settings'?{...config,settings:{...config.settings,enableHp:'false'}}:
    part==='items'?{...config,items:[{...f.items[0],hp:-1}]}:{settings:null,items:null};
  expect(()=>f.module.configure!(invalid)).toThrow();f.advance();expect(f.write).toHaveBeenCalledTimes(1);
  const future=f.module.createSession(f.context);future.connectionChanged?.(1);
  future.tick?.(200);expect(f.events.at(-1)?.status.enabled).toBe(true);
  const apply=vi.spyOn(AutoDrinkController.prototype,'configure');f.module.configure!({settings:f.settings,items:f.items,gameBuild:'test-build',gameDir:'fixture'});await Promise.resolve();
  expect(apply).toHaveBeenCalledTimes(2);future.close?.();
});
it.each(['throw','undefined','mismatch','short'])('rejects %s serialization preflight without a write',async failure=>{
  const f=await fixture();
  if(failure==='throw')vi.spyOn(f.context.factory,'serialize').mockImplementation(()=>{throw new Error('invalid');});
  if(failure==='short')vi.spyOn(f.context.factory,'serialize').mockReturnValue(Buffer.alloc(4));
  if(failure==='undefined'||failure==='mismatch')vi.spyOn(f.context.factory,'createFromBytes').mockReturnValue({...f.packet('USEITEM'),isDefined:failure!=='undefined',data:{}});
  f.advance();expect(f.write).not.toHaveBeenCalled();expect(f.events.at(-1)?.status.reason).toBe('write rejected');
});
it('tags priority writes, throttles changed status to 200ms, and retires closed controllers',async()=>{
  const f=await fixture();f.advance();expect(f.write).toHaveBeenCalledWith(expect.any(Buffer),false,expect.any(Function),'auto-drink');
  expect(f.events).toHaveLength(1);f.advance(100);expect(f.events).toHaveLength(1);f.advance(100);expect(f.events).toHaveLength(2);
  const apply=vi.spyOn(AutoDrinkController.prototype,'configure');f.hooks.close?.();
  f.module.configure!({settings:f.settings,items:f.items,gameBuild:'test-build',gameDir:'fixture'});await Promise.resolve();expect(apply).not.toHaveBeenCalled();
});

function deferred() {
  let resolve!: (build: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('cannot drink until the worker verifies the installed build, without any main-thread connection event', async () => {
  const read = deferred();
  const reader = vi.fn(() => read.promise);
  const f = await fixture(reader);
  f.advance();
  expect(reader).toHaveBeenCalledExactlyOnceWith('fixture');
  expect(f.write).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.status.reason).toContain('verifying installed game build');
  read.resolve('test-build'); await Promise.resolve();
  f.advance(200);
  expect(f.write).toHaveBeenCalledOnce();
});

it.each([0, 1000])('tracks manual inventory consumption during verification, including a %sms healing window', async healingDurationMs => {
  const read = deferred();
  const reader = vi.fn().mockResolvedValueOnce('test-build').mockReturnValueOnce(read.promise);
  const f = await fixture(reader);
  f.module.configure!({ settings: { ...f.settings, healingOverTime: true },
    items: [{ ...f.items[0], healingDurationMs }], gameDir: 'fixture', gameBuild: 'test-build' });
  f.advance(100);
  expect(f.events.at(-1)?.status).toMatchObject({ pending: false, lastAttemptAt: null, slotId: null, cooldownRemainingMs: 0 });
  expect(f.events.at(-1)?.status.reason).toContain('verifying installed game build');
  expect(f.write).not.toHaveBeenCalled();
  f.hooks.written?.(f.packet('USEITEM', { time: 1100, slotObject: { objectId: 1, slotId: 4, objectType: 10 } }), 'normal', 100, 2, null);
  read.resolve('test-build'); await Promise.resolve();
  f.advance(10); expect(f.write).not.toHaveBeenCalled();
  f.advance(389); expect(f.write).not.toHaveBeenCalled();
  if (healingDurationMs) {
    f.advance(1); expect(f.write).not.toHaveBeenCalled();
    f.advance(599); expect(f.write).not.toHaveBeenCalled();
  }
  f.advance(1); expect(f.write).toHaveBeenCalledOnce();
});

it.each(['different-build', null])('fails closed for installed build %s', async installed => {
  const f = await fixture(async () => { if (installed === null) throw new Error('boot.config unavailable'); return installed; });
  f.advance();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.status.reason).toContain(installed === null
    ? 'installed game build unknown (boot.config unavailable)'
    : 'catalog is for game build test-build but the installed game is different-build');
});

it.each(['gameDir', 'gameBuild'] as const)('fails closed with an unknown %s without reading disk', async field => {
  const reader = vi.fn(async () => 'test-build');
  const f = await fixture(reader); reader.mockClear();
  f.module.configure!({ settings: f.settings, items: f.items, gameDir: 'fixture', gameBuild: 'test-build', [field]: null });
  f.advance();
  expect(reader).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.status.reason).toContain(field === 'gameDir'
    ? 'installed game build unknown (game directory unavailable)' : 'catalog game build unknown');
});

it('re-gates changed catalog stamps and ignores obsolete and closed-session verification results', async () => {
  const reads = [deferred(), deferred(), deferred(), deferred()];
  let index = 0;
  const f = await fixture(() => reads[index++].promise);
  const configure = (gameBuild: string) => f.module.configure!({ settings: f.settings, items: f.items, gameDir: 'fixture', gameBuild });
  configure('build-b');
  reads[0].resolve('test-build'); await Promise.resolve();
  f.advance(); expect(f.write).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.status.reason).toContain('verifying');
  reads[1].resolve('build-b'); await Promise.resolve();
  // A verified session loses its usable catalog immediately when configured for another stamp.
  configure('build-c');
  f.advance(200); expect(f.write).not.toHaveBeenCalled();
  reads[2].resolve('build-b'); await Promise.resolve();
  f.advance(200); expect(f.write).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.status.reason).toContain('catalog is for game build build-c but the installed game is build-b');
  configure('build-d');
  f.hooks.close?.();
  const catalog = vi.spyOn(AutoDrinkController.prototype, 'setCatalog');
  reads[3].resolve('build-d'); await Promise.resolve();
  expect(catalog).not.toHaveBeenCalled();
  f.advance(200); expect(f.write).not.toHaveBeenCalled();
});

it('only admits replacement items after their stamp verifies, ignoring a late failed old read', async () => {
  const old = deferred(), current = deferred();
  const reader = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const f = await fixture(reader);
  f.module.configure!({ settings: f.settings, items: f.items, gameDir: 'new-directory', gameBuild: 'new-build' });
  f.advance(); expect(f.write).not.toHaveBeenCalled();
  expect(reader).toHaveBeenLastCalledWith('new-directory');
  current.resolve('new-build'); await Promise.resolve();
  old.reject(null); await Promise.resolve();
  f.advance(200); expect(f.write).toHaveBeenCalledOnce();
  expect(f.events.at(-1)?.status.reason).not.toContain('catalog unavailable');
});

it.each(['gameDir', 'gameBuild'] as const)('rejects invalid %s without changing a verified session', async field => {
  const f = await fixture();
  for (const value of [undefined, '', '  ', 5, {}, [], 'bad\0value']) {
    const config = { settings: { ...f.settings, enabled: false }, items: [], gameDir: 'fixture', gameBuild: 'test-build', [field]: value };
    expect(() => validateConfig(config)).toThrow();
    expect(() => f.module.configure!(config)).toThrow();
  }
  f.advance(); expect(f.write).toHaveBeenCalledOnce();
});
