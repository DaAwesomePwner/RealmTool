import { afterEach, expect, it, vi } from 'vitest';
import { createFactory } from '../../../src/protocol/schema.ts';
import { SessionAutomation } from '../../../src/transport/automation.ts';
import type { WorkerSessionContext } from '../../../src/transport/modules.ts';
import { AutoDrinkController } from '../../../src/auto-drink/AutoDrinkController.ts';
import { DEFAULT_AUTO_DRINK_SETTINGS } from '../../../src/auto-drink/AutoDrinkTypes.ts';
import { createAutoDrinkModule } from '../worker.ts';
import type { AutoDrinkEvent } from '../messages.ts';

const cleanups: (()=>void)[]=[];
afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.restoreAllMocks();});
function fixture() {
  let now=0,generation=1;
  const module=createAutoDrinkModule();
  const settings={...DEFAULT_AUTO_DRINK_SETTINGS,enabled:true};
  const items=[{type:10,name:'HP',hp:100,mp:0,healingDurationMs:0,quickslot:true}];
  module.configure!({settings,items});
  const events:AutoDrinkEvent[]=[];
  const factory=createFactory();
  const automation=new SessionAutomation();automation.reset(generation);
  const write=vi.fn(()=>true);
  const context:WorkerSessionContext={sessionId:'s',factory,automation,generation:()=>generation,now:()=>now,
    writePriority:write,transport:()=>({available:true,backlog:false,upstreamBackpressure:false}),held:()=>[],post:e=>events.push(e as AutoDrinkEvent)};
  const hooks=module.createSession(context);cleanups.push(()=>hooks.close?.());hooks.connectionChanged?.(generation);
  const packet=(name:string,data:Record<string,unknown>={})=>{const p=factory.createByName(name);p.data=data;return p;};
  const spawn=()=>{
    for(const [name,data] of [['MAPINFO',{name:'Realm'}],['CREATESUCCESS',{objectId:1}],['UPDATE',{newObjs:[{status:{objectId:1,position:{x:1.5,y:2.5},data:[
      {id:0,value:1000},{id:1,value:400},{id:29,value:0},{id:95,value:0},{id:116,value:10,stackCount:3},
    ]}}]}]] as const)hooks.observe?.(packet(name,data),false,now,1);
    hooks.written?.(packet('PONG',{serial:1,time:1000+now}),'normal',now,1,null);
  };
  spawn();
  return {module,hooks,context,settings,items,write,events,packet,spawn,
    advance:(ms=0)=>{now+=ms;hooks.tick?.(now);},
    next:()=>{automation.reset(++generation);hooks.connectionChanged?.(generation);spawn();},
  };
}
it('does not pass its own USEITEM to observeOutgoing, but observes game USEITEM',()=>{
  const f=fixture();const observe=vi.spyOn(AutoDrinkController.prototype,'observeOutgoing');
  const use=f.packet('USEITEM',{time:1000,slotObject:{objectId:1,slotId:1000000,objectType:10}});
  f.hooks.written?.(use,'priority',0,null,'auto-drink');expect(observe).not.toHaveBeenCalled();
  f.hooks.written?.(use,'normal',0,4,null);expect(observe).toHaveBeenCalledExactlyOnceWith(use);
});
it.each(['accepted','rejected','manual'])('disarms for the entire generation on a %s escape latch',reason=>{
  const f=fixture();const escape=vi.spyOn(AutoDrinkController.prototype,'escape');
  f.context.automation.latchEscape(reason);f.advance();f.spawn();f.advance(400);
  f.module.configure!({settings:f.settings,items:f.items});f.advance(400);
  expect(f.write).not.toHaveBeenCalled();expect(escape).toHaveBeenCalledTimes(1);
  f.next();f.advance();expect(f.write).toHaveBeenCalledTimes(1);
});
it('a missing catalog reports no eligible stock and never writes',()=>{
  const f=fixture();f.module.configure!({settings:f.settings,items:[]});f.advance();
  expect(f.events.at(-1)?.status.reason).toBe('no eligible stock');expect(f.write).not.toHaveBeenCalled();
});
it.each(['settings','items','both'])('rejects invalid %s before mutating live or future sessions',part=>{
  const f=fixture();const config={settings:{...f.settings,enabled:false},items:f.items};
  const invalid=part==='settings'?{...config,settings:{...config.settings,enableHp:'false'}}:
    part==='items'?{...config,items:[{...f.items[0],hp:-1}]}:{settings:null,items:null};
  expect(()=>f.module.configure!(invalid)).toThrow();f.advance();expect(f.write).toHaveBeenCalledTimes(1);
  const future=f.module.createSession(f.context);future.connectionChanged?.(1);
  future.tick?.(200);expect(f.events.at(-1)?.status.enabled).toBe(true);
  const apply=vi.spyOn(AutoDrinkController.prototype,'configure');f.module.configure!({settings:f.settings,items:f.items});
  expect(apply).toHaveBeenCalledTimes(2);future.close?.();
});
it.each(['throw','undefined','mismatch','short'])('rejects %s serialization preflight without a write',failure=>{
  const f=fixture();
  if(failure==='throw')vi.spyOn(f.context.factory,'serialize').mockImplementation(()=>{throw new Error('invalid');});
  if(failure==='short')vi.spyOn(f.context.factory,'serialize').mockReturnValue(Buffer.alloc(4));
  if(failure==='undefined'||failure==='mismatch')vi.spyOn(f.context.factory,'createFromBytes').mockReturnValue({...f.packet('USEITEM'),isDefined:failure!=='undefined',data:{}});
  f.advance();expect(f.write).not.toHaveBeenCalled();expect(f.events.at(-1)?.status.reason).toBe('write rejected');
});
it('tags priority writes, throttles changed status to 200ms, and retires closed controllers',()=>{
  const f=fixture();f.advance();expect(f.write).toHaveBeenCalledWith(expect.any(Buffer),false,expect.any(Function),'auto-drink');
  expect(f.events).toHaveLength(1);f.advance(100);expect(f.events).toHaveLength(1);f.advance(100);expect(f.events).toHaveLength(2);
  const apply=vi.spyOn(AutoDrinkController.prototype,'configure');f.hooks.close?.();
  f.module.configure!({settings:f.settings,items:f.items});expect(apply).not.toHaveBeenCalled();
});
