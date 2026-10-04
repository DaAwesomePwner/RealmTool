import { join } from 'node:path';
import { AppController } from './controller.ts';
import { resourcePaths } from './resources.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import { appDataDir } from '../config/store.ts';
import { log } from '../util/log.ts';
import { LogRing, attachFileLog } from '../util/logStore.ts';

export async function runSidecar(options: { env: NodeJS.ProcessEnv; stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream;
  startApi: (controller: AppController, token: string, origins: string[]) => Promise<{ port: number; close(): Promise<void> }> }): Promise<number> {
  const token = options.env.REALMTOOL_API_TOKEN;
  delete options.env.REALMTOOL_API_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{43,}$/.test(token)) return 2;
  const origins = (options.env.REALMTOOL_UI_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  // The handshake is the only stdout output. Never log API errors that could contain its token.
  log.setConsole(false);
  const detach = attachFileLog(join(appDataDir(options.env), 'logs'));
  let controller: AppController | undefined;
  let api: Awaited<ReturnType<typeof options.startApi>> | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let code = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let stopping = false;
  const stop = () => {
    stopping = true; finish();
    // Request cancellation immediately even while the API is still starting.
    void shutdown?.().catch(() => { code = 1; });
  };
  options.stdin.once('end', stop); options.stdin.once('close', stop);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (('readableEnded' in options.stdin && options.stdin.readableEnded)
    || ('destroyed' in options.stdin && options.stdin.destroyed)) stop();
  options.stdin.resume();
  try {
    controller = new AppController({ config: new AppConfigStore(appDataDir(options.env)), resources: resourcePaths(options.env), logs: new LogRing() });
    shutdown = controller.shutdown.bind(controller);
    controller.shutdown = () => { stopping = true; finish(); return shutdown!(); };
    if (stopping) await shutdown();
    if (!stopping) {
      api = await options.startApi(controller, token, origins);
      if (!stopping) options.stdout.write(`REALMTOOL_READY ${JSON.stringify({ port: api.port })}\n`);
    }
    await finished;
    await controller.shutdown();
  } catch {
    log.error('Sidecar', 'Sidecar startup or shutdown failed');
    code = 1;
  } finally {
    options.stdin.off('end', stop); options.stdin.off('close', stop); options.stdin.pause();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { await controller?.shutdown(); } catch { code = 1; }
    try { await api?.close(); } catch { code = 1; }
    detach();
  }
  return code;
}
