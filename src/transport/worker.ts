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
import type { WorkerModule } from './modules.ts';
import { describeError } from '../util/describeError.ts';
import { guardWorkerCall, tickSessions } from './workerGuard.ts';

const TICK_MS = 8;
const init = workerData as WorkerInit;
const port = parentPort;
if (!port) throw new Error('src/transport/worker.ts must run as a worker thread');
const post = (event: WorkerEvent): void => port.postMessage(event);

function configureModule(module: WorkerModule, config: unknown): void {
  try {
    module.configure?.(config);
  } catch (error) {
    post({ type: 'diagnostic', message: `module ${module.id} rejected its configuration: ${describeError(error)}` });
  }
}

function configureModules(configs: Record<string, unknown>): void {
  for (const module of WORKER_MODULES) {
    if (Object.hasOwn(configs, module.id)) configureModule(module, configs[module.id]);
  }
}

if (init.host !== '127.0.0.1') {
  post({ type: 'fault', message: `Refusing to listen on ${init.host}: RealmTool listens only on 127.0.0.1` });
} else {
  configureModules(init.moduleConfig);

  const sessions = new Map<string, Session>();
  const env: SessionEnv = {
    factory: new PacketFactory(init.definitions, init.stats, true),
    router: new Router({ loopbackPort: init.port }),
    interest: new Interest(init.interest),
    modules: WORKER_MODULES,
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

  const timer = WORKER_MODULES.length > 0
    ? setInterval(() => {
      const now = performance.now();
      tickSessions(sessions.values(), now, post);
    }, TICK_MS)
    : null;

  port.on('message', (command: WorkerCommand) => guardWorkerCall(post, `Worker command ${command.type}`, () => {
    if (command.type === 'stop') {
      if (timer) clearInterval(timer);
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
      if (module) configureModule(module, command.message);
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
