import { LoopLagSampler } from './latency.ts';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { PacketFactory } from '../protocol/PacketFactory.ts';
import { Router } from '../routing/router.ts';
import { Interest } from './interest.ts';
import type { WorkerCommand, WorkerEvent, WorkerInit } from './messages.ts';
import { Session, type SessionEnv } from './session.ts';
import { WORKER_MODULES } from './workerModules.ts';
import { ModuleDiagnosticLimiter, configureWorkerModule, guardWorkerCall, tickSessions } from './workerGuard.ts';

const TICK_MS = 8;
const init = workerData as WorkerInit;
const port = parentPort;
if (!port) throw new Error('src/transport/worker.ts must run as a worker thread');
const post = (event: WorkerEvent): void => port.postMessage(event);

// Report fatal errors before terminating: continuing could leave sockets/ciphers corrupt.
function fatal(reason: unknown): never {
  try {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message).split('\n').slice(0, 6).join('\n') : String(reason);
    post({ type: 'fault', message: `Fatal network worker error: ${detail.slice(0, 2000)}` });
  } finally { process.exit(1); }
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);


function configureModules(configs: Record<string, unknown>): void {
  // Preserve registry order regardless of caller key order.
  for (const module of WORKER_MODULES) {
    if (Object.hasOwn(configs, module.id)) configureWorkerModule(module, module.id, configs[module.id], post);
  }
  for (const moduleId of Object.keys(configs)) {
    if (!WORKER_MODULES.some(module => module.id === moduleId)) configureWorkerModule(undefined, moduleId, configs[moduleId], post);
  }
}

if (init.host !== '127.0.0.1') {
  post({ type: 'fault', message: `Refusing to listen on ${init.host}: RealmTool listens only on 127.0.0.1` });
} else {
  for (const module of WORKER_MODULES) module.start?.();
  configureModules(init.moduleConfig);

  const sessions = new Map<string, Session>();
  const moduleDiagnostics = new ModuleDiagnosticLimiter(post);
  const env: SessionEnv = {
    factory: new PacketFactory(init.definitions, init.stats, true),
    router: new Router({ loopbackPort: init.port }),
    interest: new Interest(init.interest),
    modules: WORKER_MODULES,
    moduleDiagnostics,
    post,
    now: () => performance.now(),
    fallbackDestination: init.fallbackDestination,
    targetTimeoutMs: init.targetTimeoutMs,
    helloTimeoutMs: init.helloTimeoutMs,
    maxPendingBytes: init.maxPendingBytes,
    onClosed: id => { sessions.delete(id); },
  };

  const listener = net.createServer(socket => {
    const id = randomUUID();
    sessions.set(id, new Session(id, socket, env));
  });
  listener.on('error', error =>
    post({ type: 'fault', message: `Could not listen on ${init.host}:${init.port}: ${error.message}` }));
  listener.listen(init.port, init.host, () => {
    const address = listener.address();
    const bound = typeof address === 'object' && address ? address.port : init.port;
    // RECONNECTs must point the game at the port we actually bound.
    env.router = new Router({ loopbackPort: bound });
    post({ type: 'listening', port: bound });
  });

  const lag = new LoopLagSampler(performance.now());
  const lagTimer = setInterval(() => {
    const sample = lag.sample(performance.now());
    if (sample) post({ type: 'loopLag', lag: sample });
  }, 100);
  // Transport verdict deadlines must advance even without realtime modules.
  const timer = setInterval(() => {
    const now = performance.now();
    tickSessions(sessions.values(), now, post);
    moduleDiagnostics.flush(now);
  }, TICK_MS);

  port.on('message', (command: WorkerCommand) => guardWorkerCall(post, `Worker command ${command.type}`, () => {
    if (command.type === 'stop') {
      clearInterval(timer); clearInterval(lagTimer);
      for (const session of [...sessions.values()]) guardWorkerCall(post, 'Session close', () => session.close('proxy'), session.id);
      listener.close(() => port.close());
      return;
    }
    if (command.type === 'interest') {
      env.interest.set(command.interest);
      return;
    }
    if (command.type === 'module' && command.id === undefined) {
      const module = WORKER_MODULES.find(module => module.id === command.moduleId);
      configureWorkerModule(module, command.moduleId, command.message, post);
      return;
    }
    if (command.type === 'modules') {
      configureModules(command.configs);
      return;
    }
    const session = sessions.get(command.id ?? '');
    if (!session) return;
    switch (command.type) {
      case 'target': session.setTarget(command.destination); break;
      case 'forward': session.forward(command.sequence, command.generation, command.data === null ? null : Buffer.from(command.data)); break;
      case 'inject': session.inject(Buffer.from(command.data), command.toClient); break;
      case 'module': session.command(command.moduleId, command.message); break;
      case 'close': session.close('proxy'); break;
    }
  }, 'id' in command ? command.id : undefined));
}
