// Adapted from realm-engine-client client/src/proxy/__tests__/autoDrinkWorker.test.ts @ 88a66b2 (MIT, see NOTICE).
// Harness adapted from RealmTool src/transport/__tests__/session.test.ts.
import net from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { Session, type SessionEnv } from '../../../src/transport/session.ts';
import { Interest } from '../../../src/transport/interest.ts';
import { DEFAULTS, type WorkerEvent } from '../../../src/transport/messages.ts';
import type { WorkerModule, WorkerSessionContext } from '../../../src/transport/modules.ts';
import { Router } from '../../../src/routing/router.ts';
import { createFactory } from '../../../src/protocol/schema.ts';
import { connectGame, FakeServer, until, type Peer } from '../../../src/testing/net.ts';
import { helloBytes, reconnectBytes } from '../../../src/testing/wire.ts';
import { DEFAULT_AUTO_DRINK_SETTINGS, type AutoDrinkSettings } from '../../../src/auto-drink/AutoDrinkTypes.ts';
import { createAutoDrinkModule } from '../worker.ts';
import type { AutoDrinkEvent } from '../messages.ts';

const cleanups:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const factory=createFactory();
const packet=(name:string,data:Record<string,unknown>={})=>{const p=factory.createByName(name);p.data=data;return factory.serialize(p);};
const stat=(id:number,value:number,stackCount=0)=>({id,value,stackCount,stringValue:''});
const slot=(slotId=1_000_000,objectType=10)=>({objectId:1,slotId,objectType});
const use=(slotId=1_000_000,objectType=10,time=2000)=>packet('USEITEM',{time,slotObject:slot(slotId,objectType),itemUsePos:{x:1.5,y:2.5},useType:0,unknownInt:0});
const swap=(slotId=1_000_000)=>packet('INVENTORYSWAP',{time:2000,position:{x:1.5,y:2.5},slotObject1:slot(slotId),slotObject2:slot(5,-1)});
const items=[{type:10,name:'HP',hp:100,mp:0,healingDurationMs:0,quickslot:true},
  {type:11,name:'MP',hp:0,mp:100,healingDurationMs:0,quickslot:true},{type:12,name:'Healing',hp:0,mp:0,healingDurationMs:4000,quickslot:true}];

async function fixture(options:{hp?:number;maxHp?:number;clock?:boolean;settings?:Partial<AutoDrinkSettings>;stats?:ReturnType<typeof stat>[];escapeStub?:boolean}={}){
  let now=1000,tick=0,count=0;
  const events:WorkerEvent[]=[];
  const sessions:Session[]=[];
  const contexts=new Map<string,WorkerSessionContext>();
  const escapeAttempts:boolean[]=[];
  const module=createAutoDrinkModule();
  const settings={...DEFAULT_AUTO_DRINK_SETTINGS,enabled:true,...options.settings};
  module.configure!({settings,items});
  let observed=0;
  const wrapped:WorkerModule={...module,createSession(ctx){contexts.set(ctx.sessionId,ctx);const hooks=module.createSession(ctx);
    return {...hooks,observe(p,c,n,id){hooks.observe?.(p,c,n,id);++observed;}};}};
  const escapeStub:WorkerModule={id:'auto-nexus-stub',priority:0,observe:{server:['NEWTICK']},createSession(ctx){return {
    observe(p){if(p.data.statuses?.some((s:any)=>s.data?.some((v:any)=>v.id===1&&v.value<=200))){
      ctx.automation.latchEscape('rejected auto nexus attempt');
      escapeAttempts.push(ctx.writePriority(packet('ESCAPE'),false,undefined,'auto-nexus-stub'));
    }},
    allowWrite(name){return name!=='ESCAPE';},
  };}};
  const env:SessionEnv={factory,router:new Router(),interest:new Interest(),modules:options.escapeStub?[escapeStub,wrapped]:[wrapped],
    post:e=>events.push(e),now:()=>now,fallbackDestination:null,targetTimeoutMs:1000,helloTimeoutMs:DEFAULTS.helloTimeoutMs,
    maxPendingBytes:DEFAULTS.maxPendingBytes,onClosed:()=>{}};
  const listener=net.createServer(socket=>sessions.push(new Session(`s${++count}`,socket,env)));
  await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const port=(listener.address() as net.AddressInfo).port;
  env.router=new Router({loopbackPort:port});
  cleanups.push(()=>new Promise<void>(resolve=>{sessions.forEach(s=>s.close());listener.close(()=>resolve());}));
  const server=new FakeServer();await server.listen();cleanups.push(()=>server.close());
  async function connect(){
    const peers=server.peers.length,sessionCount=sessions.length;
    const game=await connectGame(port);cleanups.push(()=>game.destroy());game.send(helloBytes(factory,Buffer.alloc(0)));
    await until(()=>sessions.length>sessionCount,'session');const session=sessions.at(-1)!;
    session.setTarget({host:'127.0.0.1',port:server.port});await until(()=>(server.peers[peers]?.frames.length??0)>0,'HELLO');
    return {game,session,upstream:server.peers[peers],context:contexts.get(session.id)!};
  }
  const first=await connect();
  let {game,session,upstream,context}=first;
  async function drain(){await until(()=>!context.transport().backlog,'transport drained');}
  async function sendServer(...frames:Buffer[]){const before=observed;frames.forEach(frame=>upstream.send(frame));await until(()=>observed>=before+frames.length,'server observations');}
  async function sendClient(bytes:Buffer){const before=upstream.frames.length;game.send(bytes);await until(()=>upstream.frames.length>before,'client accepted');}
  const tickPacket=(data:ReturnType<typeof stat>[],tickId=++tick)=>packet('NEWTICK',{tickId,tickTime:200,statuses:[{objectId:1,position:{x:1.5,y:2.5},data}]});
  async function spawn(map='Realm'){
    tick=0;await sendServer(packet('MAPINFO',{name:map}),packet('CREATESUCCESS',{objectId:1,charId:2}),packet('UPDATE',{tiles:[],drops:[],newObjs:[{objectType:768,status:{objectId:1,position:{x:1.5,y:2.5},data:[
      stat(0,options.maxHp??1000),stat(1,options.hp??400),stat(3,500),stat(4,100),stat(29,0),stat(95,0),stat(116,10,3),...(options.stats??[]),
    ]}}]}));await drain();
  }
  const clock=()=>sendClient(packet('PONG',{serial:91,time:1000+now}));
  const wire=()=>server.peers.flatMap((peer,index)=>peer.frames.map(bytes=>({connection:index+1,packet:factory.createFromBytes(bytes,'client')})));
  const uses=()=>wire().filter(p=>p.packet.name==='USEITEM');
  async function advance(ms=0){now+=ms;await drain();session.tick(now);await new Promise(resolve=>setTimeout(resolve,5));}
  await spawn();if(options.clock!==false)await clock();
  return {env,events,server,sessions,contexts,escapeAttempts,module,settings,wire,uses,spawn,clock,sendServer,sendClient,advance,drain,tickPacket,
    get game(){return game;},get upstream(){return upstream;},get context(){return context;},get session(){return session;},now:()=>now,
    status:()=> (events.filter(e=>e.type==='module'&&e.id===session.id).at(-1) as Extract<WorkerEvent,{type:'module'}>|undefined)?.message as AutoDrinkEvent|undefined,
    stats:(data:ReturnType<typeof stat>[],tickId?:number)=>sendServer(tickPacket(data,tickId)),
    configure:(change:Partial<AutoDrinkSettings>)=>{Object.assign(settings,change);module.configure!({settings,items});},
    inject:(bytes:Buffer,toClient=false)=>session.inject(bytes,toClient),
    reconnect:async()=>{
      const peers=server.peers.length;session['connect']({host:'127.0.0.1',port:server.port},helloBytes(factory,Buffer.alloc(0)));
      await until(()=>(server.peers[peers]?.frames.length??0)>0,'reconnected HELLO');upstream=server.peers[peers];await spawn();await clock();
    },
    secondClient:async()=>{({game,session,upstream,context}=await connect());await spawn();await clock();},
  };
}

it('writes one real USEITEM at a time with a 400ms floor; raw maxima ignore boosts and HP is never predicted',async()=>{
  const f=await fixture({hp:354,maxHp:707,settings:{intervalMs:1},stats:[stat(46,500),stat(111,100)]});
  await f.advance();expect(f.uses()).toHaveLength(0);await f.stats([stat(1,353)]);await f.advance();expect(f.uses()).toHaveLength(1);
  const first=f.uses()[0].packet;expect(first.data).toMatchObject({slotObject:slot(),itemUsePos:{x:1.5,y:2.5},useType:0,unknownInt:0});
  await f.stats([stat(116,10,2)]);await f.advance(399);expect(f.uses()).toHaveLength(1);await f.advance(1);expect(f.uses()).toHaveLength(2);
  expect(f.uses()[1].packet.data.time-first.data.time).toBe(400);await f.stats([stat(116,10,2)]);await f.advance(450);expect(f.uses()).toHaveLength(2);
  expect(f.status()?.status).toMatchObject({hp:353,maxHp:707,pending:true});expect(f.wire().every(p=>p.packet.isDefined)).toBe(true);
});
it('requires an accepted finite game clock and drains held and partial packets before automatic writes',async()=>{
  const f=await fixture({clock:false});await f.advance();expect(f.uses()).toHaveLength(0);
  await f.sendClient(packet('PONG',{serial:1,time:-1}));await f.advance(200);expect(f.uses()).toHaveLength(0);
  f.env.interest=new Interest({verdict:{client:['PONG']}});f.game.send(packet('PONG',{serial:2,time:2200}));
  await until(()=>f.events.some(e=>e.type==='packet'&&e.fromClient),'held PONG');f.session.tick(f.now());expect(f.uses()).toHaveLength(0);
  const frame=f.tickPacket([stat(1,300)]);f.upstream['sendCipher'].cipher(frame);f.upstream['socket'].write(frame.subarray(0,4));
  await new Promise(resolve=>setTimeout(resolve,10));
  const held=f.events.find(e=>e.type==='packet'&&e.fromClient) as Extract<WorkerEvent,{type:'packet'}>;
  f.session.forward(held.sequence,held.generation,Buffer.from(held.data));f.session.tick(f.now());expect(f.uses()).toHaveLength(0);
  f.upstream['socket'].write(frame.subarray(4));await until(()=>!f.context.transport().backlog,'partial frame completed');
  await f.advance();expect(f.uses()).toHaveLength(1);
});
it.each(['MOVE','PONG'])('a delayed %s calibration cannot rewind encrypted USEITEM timestamps or shorten their 400ms spacing',async name=>{
  const f=await fixture({hp:900});await f.advance(700);await f.stats([stat(1,400)]);await f.advance();const first=f.uses()[0].packet.data.time;
  await f.stats([stat(116,10,2)]);await f.advance(150);
  const sample=(time:number)=>packet(name,name==='MOVE'?{tickId:2,records:[{time,x:1.5,y:2.5}]}:{serial:2,time});
  await f.sendClient(sample(2100));await f.advance(550);expect(f.uses()).toHaveLength(1);
  await f.sendClient(sample(2650));await f.stats([]);await f.advance();
  // The resynchronized clock remains below the prior protocol deadline.
  expect(f.uses()).toHaveLength(1);await f.advance(450);expect(f.uses()).toHaveLength(2);expect(f.uses()[1].packet.data.time-first).toBeGreaterThanOrEqual(400);
});
it.each(['forwarded','injected'])('%s manual consumes share the limiter but continuous ability packets do not',async source=>{
  const f=await fixture({hp:900});const input=async(bytes:Buffer)=>{if(source==='forwarded')await f.sendClient(bytes);else {f.inject(bytes);await f.drain();}};
  await input(use(1_000_001,999,2000));await f.stats([stat(1,400)]);
  for(let i=0;i<5;++i){await input(use(1,10,0x7fffffff));await f.advance(50);}
  expect(f.uses().filter(p=>p.packet.data.slotObject.slotId===1_000_000)).toHaveLength(0);
  await f.advance(150);expect(f.uses().filter(p=>p.packet.data.slotObject.slotId===1_000_000)).toHaveLength(1);
  expect(f.uses().filter(p=>p.packet.data.slotObject.slotId===1)).toHaveLength(5);
});
it('shares HP/MP cooldown across same-connection MAPINFO, toggles and catalog reloads',async()=>{
  const f=await fixture({settings:{enableMp:true},stats:[stat(117,11,3)]});await f.advance();expect(f.uses()).toHaveLength(1);
  await f.spawn('Snake Pit');f.configure({enabled:false});f.configure({enabled:true});f.module.configure!({settings:f.settings,items});
  await f.stats([stat(1,900)]);await f.clock();await f.advance(550);expect(f.uses()).toHaveLength(1);
  await f.clock();await f.stats([]);await f.advance();expect(f.uses()).toHaveLength(2);expect(f.uses()[1].packet.data.slotObject).toEqual(slot(1_000_001,11));
});
it.each([[29,1<<4,'sick'],[95,0x20000000,'drought']] as const)('blocks %s/%s (%s) and resumes on authoritative clearance',async(id,value,reason)=>{
  const f=await fixture({stats:[stat(id,value)]});await f.advance();expect(f.status()?.status.reason).toBe(reason);expect(f.uses()).toHaveLength(0);
  await f.stats([stat(id,0)]);await f.advance(200);expect(f.uses()).toHaveLength(1);
});
it('supports HoT-only catalog entries opt-in without stacking or crediting health',async()=>{
  const f=await fixture({stats:[stat(116,12,3)]});await f.advance();expect(f.uses()).toHaveLength(0);f.configure({healingOverTime:true});await f.advance(200);expect(f.uses()).toHaveLength(1);
  await f.stats([stat(116,12,2)]);await f.advance(450);expect(f.uses()).toHaveLength(1);expect(f.status()?.status.hp).toBe(400);
});
it('stays clock-ready through realistic encrypted MOVE jitter, then prioritizes isolated ESCAPE and keeps the exactly-four guard',async()=>{
  // Guard ownership belongs to Auto Nexus; this stub pins ordering and a rejected attempt's latch.
  const f=await fixture({hp:900,escapeStub:true});await f.advance();
  for(const delay of [22,15,25,49,42,64,48,53,61,91,83]){
    await f.advance(200);await f.sendClient(packet('MOVE',{tickId:1,records:[{time:1000+f.now()-delay,x:1.5,y:2.5}]}));await f.stats([]);await f.advance();
  }
  expect(f.events.filter(e=>e.type==='module'&&(e.message as AutoDrinkEvent).status.reason==='client clock unavailable')).toHaveLength(0);
  await f.sendServer(f.tickPacket([stat(1,400)]),f.tickPacket([stat(1,200)]));await f.advance(200);expect(f.uses()).toHaveLength(0);
  expect(f.escapeAttempts).toEqual([false]);expect(f.wire().some(p=>p.packet.name==='ESCAPE')).toBe(false);
  expect(f.status()?.status.reason).toBe('escape lifecycle');f.configure({enabled:false});f.configure({enabled:true});await f.spawn('Snake Pit');await f.clock();await f.advance(500);expect(f.uses()).toHaveLength(0);
});
it.each(['game','injected','command'])('latches %s manual escape with auto nexus disabled; new TCP state cannot leak',async source=>{
  const f=await fixture({hp:900});
  if(source==='game')await f.sendClient(packet('ESCAPE'));else if(source==='injected')f.inject(packet('ESCAPE'));else f.context.automation.latchEscape('manual command');
  await f.spawn('Snake Pit');await f.stats([stat(1,400)]);await f.clock();f.configure({enabled:false});f.configure({enabled:true});await f.advance(450);expect(f.uses()).toHaveLength(0);
  expect(f.status()?.status.reason).toBe('escape lifecycle');await f.sendClient(packet('PLAYERHIT',{objectId:2,bulletId:1}));
  await f.reconnect();await f.stats([stat(1,400)]);await f.advance(200);expect(f.uses()).toHaveLength(1);expect(f.uses()[0].connection).toBe(2);
});
it('rejects auto-loot swaps on the pending slot before RC4, then releases on stock change without treating duplicates as ACK',async()=>{
  const f=await fixture();await f.advance();expect(f.uses()).toHaveLength(1);await f.stats([stat(116,10,3)],10);await f.stats([stat(116,10,2)],10);
  expect(f.inject(swap())).toBe(false);expect(f.inject(swap(6))).toBe(true);await f.drain();
  await f.stats([stat(116,10,2)],11);expect(f.inject(swap())).toBe(true);await f.advance(450);expect(f.uses()).toHaveLength(1);
  await f.stats([stat(116,10,1)],12);await f.advance();expect(f.uses()).toHaveLength(2);await f.sendClient(swap());
  expect(f.wire().filter(p=>p.packet.name==='INVENTORYSWAP').map(p=>p.packet.data.slotObject1.slotId)).toEqual([6,1_000_000,1_000_000]);
  expect(f.wire().every(p=>p.packet.isDefined)).toBe(true);
});
it('discards stale injections and unresolved old-generation replies without blocking a new connection',async()=>{
  // RT preserves game-owned client packets across generations; test controller and latch reset instead.
  const f=await fixture();await f.advance();expect(f.uses()).toHaveLength(1);f.context.automation.latchEscape('old generation');
  await f.advance(200);expect(f.status()?.status.reason).toBe('escape lifecycle');await f.reconnect();await f.advance(200);expect(f.uses()).toHaveLength(2);
  expect(f.context.automation.escapeLatched()).toBe(false);await f.stats([stat(116,10,2)]);await f.advance(400);expect(f.uses()).toHaveLength(3);
  expect(f.uses().map(p=>p.connection)).toEqual([1,2,2]);
});
it('keeps independent clients on the same worker isolated from reservations, cooldowns and escape latches',async()=>{
  const f=await fixture();await f.advance();f.context.automation.latchEscape('manual');await f.advance(200);await f.secondClient();await f.advance();
  expect(f.uses().map(p=>p.connection)).toEqual([1,2]);expect(f.uses()[1].packet.data.slotObject).toEqual(slot());
});
it('uses original server health and quantity only, ignoring injected state and plugin rewrites',async()=>{
  const f=await fixture({hp:900});f.inject(f.tickPacket([stat(1,100)]),true);await f.advance();expect(f.uses()).toHaveLength(0);
  f.env.interest=new Interest({verdict:{server:['NEWTICK']}});await f.stats([stat(1,400)]);
  const held=f.events.filter(e=>e.type==='packet').at(-1) as Extract<WorkerEvent,{type:'packet'}>;
  f.session.forward(held.sequence,held.generation,f.tickPacket([stat(1,900)]));await f.advance(200);expect(f.uses()).toHaveLength(1);
  f.inject(f.tickPacket([stat(116,10,2)]),true);await f.advance(450);expect(f.uses()).toHaveLength(1);expect(f.status()?.status).toMatchObject({hp:400,pending:true});
  f.env.interest=new Interest();await f.stats([stat(116,10,2)]);await f.advance();expect(f.uses()).toHaveLength(2);
});
it.each(['dropped', 'malformed', 'held', 'accepted'] as const)('only disarms on an accepted written RECONNECT: %s', async outcome => {
  const f = await fixture();
  f.env.interest = new Interest({ verdict: { server: ['RECONNECT'] } });
  f.upstream.send(reconnectBytes(factory, { host: outcome === 'malformed' ? 'invalid/host' : '127.0.0.1', port: 2050, key: Buffer.from([1]) }));
  await until(() => f.events.some(e => e.type === 'packet' && !e.fromClient), 'held RECONNECT verdict');
  const held = f.events.find(e => e.type === 'packet' && !e.fromClient) as Extract<WorkerEvent, { type: 'packet' }>;
  if (outcome === 'held') {
    f.session.tick(f.now());
    expect(f.uses()).toHaveLength(0); // Backlog blocks drinking until the verdict resolves.
    expect(f.status()?.status.reason).not.toBe('escape lifecycle');
  }
  f.session.forward(held.sequence, held.generation,
    outcome === 'dropped' || outcome === 'held' ? null : Buffer.from(held.data));
  await f.advance();
  if (outcome === 'accepted') {
    expect(f.uses()).toHaveLength(0);
    expect(f.status()?.status.reason).toBe('escape lifecycle');
    expect(f.game.frames.some(bytes => bytes[4] === factory.getPacketId('RECONNECT'))).toBe(true);
  } else {
    expect(f.uses()).toHaveLength(1);
    expect(f.game.frames.some(bytes => bytes[4] === factory.getPacketId('RECONNECT'))).toBe(false);
  }
  expect(f.events.filter(e => e.type === 'diagnostic').map(e => e.message)).toEqual(outcome === 'malformed'
    ? ['Dropped a malformed RECONNECT; the current route is unchanged'] : []);
});
it('bounds ambiguous quantity reservations and recovers after bad stock only when stock actually changes',async()=>{
  const f=await fixture();await f.advance();await f.stats([stat(116,10,-1)]);
  for(let i=0;i<5;++i){await f.advance(550);await f.clock();await f.stats([stat(116,10,3)]);}
  await f.advance();expect(f.uses()).toHaveLength(1);expect(f.status()?.status.pending).toBe(false);expect(f.inject(swap())).toBe(true);
  await f.stats([stat(116,10,-1)]);await f.stats([stat(116,10,2)]);await f.advance();expect(f.uses()).toHaveLength(2);expect(f.status()?.status.hp).toBe(400);
});
