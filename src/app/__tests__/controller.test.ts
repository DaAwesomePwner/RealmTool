import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController, OperationBusyError, type ControllerDeps, type AppState } from '../controller.ts';
import { resourcePaths } from '../resources.ts';
import { AppConfigStore } from '../../config/appConfig.ts';
import { ProfileStore } from '../../config/store.ts';
import { FakeProxy } from '../../testing/pluginHarness.ts';
import { PLUGIN_API_VERSION, type PluginContext } from '../../plugins/api.ts';
import { inspectHelper, installHelper, HELPER_FILE, BACKUP_FILE } from '../../game/helperInstaller.ts';
import { LogRing } from '../../util/logStore.ts';
import { log } from '../../util/log.ts';

class FakeHost extends FakeProxy {
  start = vi.fn(async () => 2050);
  stop = vi.fn(async () => {});
}

describe('AppController lifecycle', () => {
  let root: string, game: string, helper: string;
  let config: AppConfigStore, controller: AppController;
  let hosts: FakeHost[], contexts: PluginContext[], deps: Partial<ControllerDeps>;
  let detach: () => void;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'realmtool-controller-'));
    game = join(root, 'game'); mkdirSync(game);
    writeFileSync(join(game, 'RotMG Exalt.exe'), 'fixture');
    helper = join(root, 'helper.dll'); writeFileSync(helper, 'RealmTool-Helper/current');
    for (const key of ['TMP', 'TEMP', 'TMPDIR']) vi.stubEnv(key, root);
    config = new AppConfigStore(join(root, 'config')); config.update({ gameDir: game });
    hosts = []; contexts = [];
    deps = {
      readGameFileStamps: async () => ({ resourcesAssets: { size: 1, mtimeMs: 0 }, bootConfig: { size: 2, mtimeMs: 0 } }),
      findGameDirs: () => [game], nativeModuleError: () => null,
      createHost: vi.fn(options => {
        expect(options.workerUrl).toEqual(resourcePaths().workerUrl);
        const host = new FakeHost(); hosts.push(host);
        return host as unknown as ReturnType<ControllerDeps['createHost']>;
      }),
      plugins: [{ id: 'fixture', name: 'Fixture', apiVersion: PLUGIN_API_VERSION, capabilities: ['worker'],
        register(ctx) {
          contexts.push(ctx);
          ctx.registerSetting('value', { type: 'number', label: 'Value', value: 1 });
          ctx.registerCleanup(() => ctx.worker.configure({ enabled: false }));
        } }],
      installHelper: vi.fn((dir, path) => {
        expect(hosts.at(-1)!.start).toHaveBeenCalledOnce();
        return installHelper(dir, path);
      }),
    };
    log.setConsole(false); detach = log.addSink(() => {});
    controller = make();
  });
  async function drain() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
  function selection(build: string, files = { resourcesAssets: { size: 1, mtimeMs: 0 }, bootConfig: { size: 2, mtimeMs: 0 } }) {
    return { consumables: build, safety: build, usesAppData: true, source: { schemaVersion: 1 as const, gameBuild: build, ...files } };
  }
  function make() {
    return new AppController({ config, resources: { ...resourcePaths(), helperDll: helper }, logs: new LogRing() }, deps);
  }
  afterEach(async () => {
    await controller.shutdown(); detach(); log.setConsole(true); vi.unstubAllEnvs();
    expect(root.startsWith(join(tmpdir(), 'realmtool-controller-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('re-inspects helper on polls and sessions and detects missing routing with a grace period', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let running = true;
      deps.isGameRunning = vi.fn(async () => running);
      controller = make(); await controller.startProxy(); await drain();
      expect(controller.state().game.routing).toBe('unknown');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(controller.state().game.routing).toBe('not-routed');
      rmSync(join(game, HELPER_FILE));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.helper.state).toBe('absent');
      expect(deps.isGameRunning).toHaveBeenCalledTimes(7);
      writeFileSync(join(game, HELPER_FILE), 'RealmTool-Helper/current');
      hosts[0].emit('session', { id: 'game', remotePort: 123 });
      expect(controller.state().game).toMatchObject({ routing: 'routed', helper: { state: 'installed' } });
      hosts[0].emit('closed', { id: 'game', by: 'game' });
      running = false; await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.state().game.routing).toBe('unknown');
      running = true; await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.state().game.routing).toBe('not-routed');
      await controller.stopProxy();
      const count = vi.mocked(deps.isGameRunning!).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.state().game.routing).toBe('unknown');
      expect(deps.isGameRunning).toHaveBeenCalledTimes(count);
    } finally { vi.useRealTimers(); }
  });

  it('listens before mismatched data finishes, shares refreshes, then reloads live', async () => {
    await controller.shutdown();
    deps.readGameBuild = vi.fn(async () => 'new');
    let published = 'old'; deps.catalogBuilds = () => selection(published);
    let finish!: (value: any) => void;
    deps.refreshCatalogs = vi.fn(() => new Promise<import('../refreshData.ts').RefreshResult>(resolve => { finish = resolve; }));
    controller = make();
    const started = controller.startProxy();
    await vi.waitFor(() => expect(deps.refreshCatalogs).toHaveBeenCalledOnce());
    expect(controller.state().data.state).toBe('refreshing'); expect(contexts).toHaveLength(1);
    await started; expect(hosts[0].start).toHaveBeenCalledOnce();
    expect(controller.state().proxy.state).toBe('running');
    const manual = controller.refreshData();
    published = 'new'; finish({ gameBuild: 'new', items: 1, projectiles: 2, tiles: 3, ms: 4 });
    await Promise.all([started, manual]);
    expect(deps.refreshCatalogs).toHaveBeenCalledOnce();
    expect(controller.state().data).toMatchObject({ state: 'idle', catalogBuild: 'new', error: null });
    const reload = vi.fn(); contexts[0].onDataRefreshed(reload);
    const second = controller.refreshData();
    await vi.waitFor(() => expect(deps.refreshCatalogs).toHaveBeenCalledTimes(2));
    finish({ gameBuild: 'new', items: 2, projectiles: 3, tiles: 4, ms: 5 }); await second;
    expect(reload).toHaveBeenCalledOnce(); expect(hosts).toHaveLength(1); expect(hosts[0].stop).not.toHaveBeenCalled();
  });

  it('keeps proxy startup working on failure, backs off sessions and polls for five minutes, and allows manual retry', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    const warnings: string[] = []; const detach = log.addSink(r => { if (r.module === 'Data' && r.level === 'warn') warnings.push(r.message); });
    try {
      deps.readGameBuild = vi.fn(async () => 'new'); deps.catalogBuilds = () => ({ consumables: 'old', safety: 'old' });
      deps.refreshCatalogs = vi.fn(async () => { throw new Error('fixture extraction failure'); });
      controller = make(); await controller.startProxy(); await drain();
      expect(controller.state().proxy.state).toBe('running'); expect(controller.state().data.state).toBe('failed');
      hosts[0].emit('session', { id: 'one', remotePort: 123 });
      await vi.advanceTimersByTimeAsync(240_000);
      expect(deps.refreshCatalogs).toHaveBeenCalledOnce(); expect(warnings).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.refreshCatalogs).toHaveBeenCalledTimes(2); expect(warnings).toHaveLength(2);
      await expect(controller.refreshData()).rejects.toThrow('fixture extraction failure');
      expect(deps.refreshCatalogs).toHaveBeenCalledTimes(3); expect(warnings).toHaveLength(2);
      await controller.stopProxy(); await vi.advanceTimersByTimeAsync(600_000);
      expect(deps.refreshCatalogs).toHaveBeenCalledTimes(3);
    } finally { detach(); vi.useRealTimers(); }
  });

  it('backs off for five minutes after a manual failure but immediately attempts a different build', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let build = 'A'; deps.readGameBuild = async () => build;
      deps.catalogBuilds = () => ({ consumables: null, safety: null });
      deps.refreshCatalogs = vi.fn(async () => { throw new Error('fixture update in progress'); });
      controller = make(); await controller.startProxy(); await drain();
      await vi.advanceTimersByTimeAsync(240_000);
      await expect(controller.refreshData()).rejects.toThrow('fixture update in progress');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.refreshCatalogs).toHaveBeenCalledTimes(2);
      build = 'B'; hosts[0].emit('session', { id: 'new-build', remotePort: 123 });
      await vi.advanceTimersByTimeAsync(0); expect(deps.refreshCatalogs).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a manual refresh interrupted by shutdown before extraction starts', async () => {
    await controller.shutdown();
    let finish!: (build: string) => void;
    deps.readGameBuild = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    deps.refreshCatalogs = vi.fn(); controller = make();
    const pending = controller.refreshData();
    const rejected = expect(pending).rejects.toThrow('refresh cancelled');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const stopped = controller.shutdown(); finish('A');
    await rejected; await stopped; expect(deps.refreshCatalogs).not.toHaveBeenCalled();
  });

  it('detects updates on sessions and the 60 second poll without restarting', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let build = 'A'; deps.readGameBuild = async () => build;
      let published = 'A'; deps.catalogBuilds = () => selection(published);
      deps.refreshCatalogs = vi.fn(async () => { published = build; return { gameBuild: build, items: 1, projectiles: 2, tiles: 3, ms: 4 }; });
      controller = make(); await controller.startProxy(); await drain(); expect(deps.refreshCatalogs).not.toHaveBeenCalled();
      build = 'B'; hosts[0].emit('session', { id: 'one', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(deps.refreshCatalogs).toHaveBeenCalledOnce();
      build = 'C'; await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.refreshCatalogs).toHaveBeenCalledTimes(2); expect(hosts).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(['missing', 'invalid', 'build', 'assets', 'boot', 'matching'])('checks appdata source fingerprints: %s', async kind => {
    await controller.shutdown();
    const out = join(config.dir, 'data/catalogs'); mkdirSync(out, { recursive: true });
    for (const name of ['consumables', 'safety']) {
      const catalog = JSON.parse(readFileSync(join(resourcePaths().dataDir, `catalogs/${name}.json`), 'utf8'));
      writeFileSync(join(out, `${name}.json`), JSON.stringify({ ...catalog, gameBuild: 'same' }));
    }
    const source = { schemaVersion: 1, gameBuild: 'same', resourcesAssets: { size: 1, mtimeMs: 0 }, bootConfig: { size: 2, mtimeMs: 0 } };
    const stale = structuredClone(source);
    if (kind === 'build') stale.gameBuild = 'old';
    if (kind === 'assets') stale.resourcesAssets.size++;
    if (kind === 'boot') stale.bootConfig.mtimeMs++;
    if (kind !== 'missing') writeFileSync(join(out, 'source.json'), kind === 'invalid' ? '{bad' : JSON.stringify(stale));
    deps.readGameBuild = async () => 'same';
    deps.refreshCatalogs = vi.fn(async () => {
      writeFileSync(join(out, 'source.json'), JSON.stringify(source));
      return { gameBuild: 'same', items: 1, projectiles: 2, tiles: 3, ms: 4 };
    });
    controller = make(); await controller.startProxy(); await drain();
    expect(deps.refreshCatalogs).toHaveBeenCalledTimes(kind === 'matching' ? 0 : 1);
    expect(controller.state().data.state).toBe('idle');
  });

  it('accepts a matching bundled catalog without a fingerprint and only stats files on later checks', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      const build = JSON.parse(readFileSync(join(resourcePaths().dataDir, 'catalogs/safety.json'), 'utf8')).gameBuild;
      deps.readGameBuild = vi.fn(async () => build); deps.refreshCatalogs = vi.fn();
      const stats = deps.readGameFileStamps = vi.fn(deps.readGameFileStamps!);
      controller = make(); await controller.startProxy(); await drain();
      expect(deps.refreshCatalogs).not.toHaveBeenCalled(); expect(controller.state().data.catalogBuild).toBe(build);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stats).toHaveBeenCalledTimes(2); expect(deps.refreshCatalogs).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['resourcesAssets', 'bootConfig'] as const)('waits for quiet %s at startup without blocking the proxy or applying backoff', async file => {
    await controller.shutdown(); vi.useFakeTimers();
    const records: { module: string; level: string; message: string }[] = [];
    const detach = log.addSink(r => records.push(r));
    try {
      const now = Date.now(), stamps = { resourcesAssets: { size: 1, mtimeMs: 0 }, bootConfig: { size: 2, mtimeMs: 0 } };
      stamps[file].mtimeMs = now;
      deps.readGameBuild = async () => 'new'; deps.readGameFileStamps = async () => stamps;
      let published = 'old'; deps.catalogBuilds = vi.fn(() => selection(published, stamps));
      deps.refreshCatalogs = vi.fn(async () => { published = 'new'; return { gameBuild: 'new', items: 1, projectiles: 2, tiles: 3, ms: 4 }; });
      controller = make(); await controller.startProxy(); await drain();
      expect(controller.state().proxy.state).toBe('running'); expect(controller.state().data.state).toBe('idle');
      hosts[0].emit('session', { id: 'quiet', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(deps.refreshCatalogs).not.toHaveBeenCalled();
      expect(records.filter(r => r.module === 'Data').map(r => r.message)).toEqual(['Game files are still changing; waiting to refresh']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.refreshCatalogs).toHaveBeenCalledOnce(); expect(controller.state().data.state).toBe('idle');
      expect(records.filter(r => r.module === 'Data' && r.level === 'warn')).toHaveLength(0);
      expect(deps.catalogBuilds).toHaveBeenCalledTimes(2); // Initial selection, then successful publication.
    } finally { detach(); vi.useRealTimers(); }
  });

  it('manual refresh bypasses the automatic quiet period', async () => {
    await controller.shutdown();
    deps.readGameBuild = async () => 'new';
    const files = { resourcesAssets: { size: 1, mtimeMs: Date.now() }, bootConfig: { size: 2, mtimeMs: Date.now() } };
    deps.readGameFileStamps = async () => files;
    let published = 'old'; deps.catalogBuilds = () => selection(published, files);
    deps.refreshCatalogs = vi.fn(async () => { published = 'new'; return { gameBuild: 'new', items: 1, projectiles: 2, tiles: 3, ms: 4 }; });
    controller = make(); await controller.startProxy(); await drain(); expect(deps.refreshCatalogs).not.toHaveBeenCalled();
    await controller.refreshData(); expect(deps.refreshCatalogs).toHaveBeenCalledOnce();
  });

  it('detects assets replaced after boot changed, even with an unchanged build and cached catalog selection', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      const original = { resourcesAssets: { size: 1, mtimeMs: 0 }, bootConfig: { size: 2, mtimeMs: 0 } };
      let current = structuredClone(original);
      deps.readGameBuild = async () => 'new'; deps.readGameFileStamps = async () => current;
      deps.catalogBuilds = vi.fn(() => ({ consumables: 'new', safety: 'new', usesAppData: true,
        source: { schemaVersion: 1 as const, gameBuild: 'new', ...original } }));
      deps.refreshCatalogs = vi.fn(async () => { throw new Error('fixture extraction failure'); });
      controller = make(); await controller.startProxy(); await drain(); expect(deps.refreshCatalogs).not.toHaveBeenCalled();
      const invalidated = vi.fn(); contexts[0].onDataInvalidated(invalidated);
      current = { ...current, resourcesAssets: { size: 3, mtimeMs: 1 } };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.refreshCatalogs).toHaveBeenCalledOnce(); expect(deps.catalogBuilds).toHaveBeenCalledOnce();
      expect(invalidated).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['build mismatch', 'unreadable fingerprint'])('invalidates running plugins when stats fail: %s', async kind => {
    await controller.shutdown();
    let build = 'A', failStats = false;
    const files = { resourcesAssets: { size: 1, mtimeMs: 0 }, bootConfig: { size: 2, mtimeMs: 0 } };
    deps.readGameBuild = async () => build;
    deps.readGameFileStamps = async () => { if (failStats) throw new Error('fixture files temporarily unavailable'); return files; };
    deps.catalogBuilds = () => ({ consumables: 'A', safety: 'A', usesAppData: kind === 'unreadable fingerprint',
      source: { schemaVersion: 1, gameBuild: 'A', ...files } });
    deps.refreshCatalogs = vi.fn(); controller = make(); await controller.startProxy(); await drain();
    const invalidate = vi.fn(); contexts[0].onDataInvalidated(invalidate);
    if (kind === 'build mismatch') build = 'B'; failStats = true;
    await expect(controller.refreshData()).rejects.toThrow('temporarily unavailable');
    expect(invalidate).toHaveBeenCalled(); expect(deps.refreshCatalogs).not.toHaveBeenCalled();
    expect(controller.state().data.state).toBe('failed');
  });

  it.each(['bundled build', 'appdata build', 'appdata fingerprint'])('re-enables verified catalogs without extraction after a transient %s failure', async kind => {
    await controller.shutdown(); vi.useFakeTimers();
    const records: { module: string; level: string; message: string }[] = [];
    const detach = log.addSink(r => records.push(r));
    try {
      let failRead = false;
      const files = selection('A').source;
      deps.readGameBuild = async () => {
        if (failRead && kind.endsWith('build')) throw new Error('fixture locked file');
        return 'A';
      };
      deps.catalogBuilds = () => ({ ...selection('A'), usesAppData: kind !== 'bundled build' });
      deps.readGameFileStamps = async () => {
        if (failRead && kind === 'appdata fingerprint') throw new Error('fixture locked file');
        return files;
      };
      deps.refreshCatalogs = vi.fn(async () => ({ gameBuild: 'A', items: 1, projectiles: 2, tiles: 3, ms: 4 }));
      controller = make(); await controller.startProxy(); await drain();
      const invalidate = vi.fn(); contexts[0].onDataInvalidated(invalidate);
      const reload = vi.fn(); contexts[0].onDataRefreshed(reload);
      failRead = true;
      hosts[0].emit('session', { id: 'failure', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(invalidate).toHaveBeenCalledOnce();
      expect(controller.state().data).toMatchObject({ state: 'failed', error: 'fixture locked file', lastResult: null });
      failRead = false;
      hosts[0].emit('session', { id: 'recovery', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(deps.refreshCatalogs).not.toHaveBeenCalled(); expect(reload).toHaveBeenCalledOnce();
      expect(controller.state().data).toMatchObject({ state: 'idle', error: null, lastResult: null });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reload).toHaveBeenCalledOnce(); expect(deps.refreshCatalogs).not.toHaveBeenCalled();
      expect(records.filter(r => r.module === 'Data' && r.level === 'info').map(r => r.message))
        .toEqual(['Game data verified for build A; catalogs re-enabled']);
      // A new failure must warn immediately, including the unknown-build key.
      failRead = true;
      hosts[0].emit('session', { id: 'second-failure', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(records.filter(r => r.module === 'Data' && r.level === 'warn')).toHaveLength(2);
    } finally { detach(); vi.useRealTimers(); }
  });

  it('clears failure backoff on verification so newly stale data refreshes immediately', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let failStats = false, files = selection('A').source;
      deps.readGameBuild = async () => 'A'; deps.catalogBuilds = () => selection('A', files);
      deps.readGameFileStamps = async () => { if (failStats) throw new Error('fixture locked file'); return files; };
      deps.refreshCatalogs = vi.fn(async () => ({ gameBuild: 'A', items: 1, projectiles: 2, tiles: 3, ms: 4 }));
      controller = make(); await controller.startProxy(); await drain();
      failStats = true; await expect(controller.refreshData()).rejects.toThrow('locked file');
      failStats = false;
      hosts[0].emit('session', { id: 'recovery', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(deps.refreshCatalogs).not.toHaveBeenCalled();
      files = { ...files, resourcesAssets: { size: 3, mtimeMs: 0 } };
      hosts[0].emit('session', { id: 'stale', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(deps.refreshCatalogs).toHaveBeenCalledOnce();
      expect(controller.state().data).toMatchObject({ state: 'idle', error: null });
    } finally { vi.useRealTimers(); }
  });

  it('clears a recovered bundled stat failure without invalidation or losing the last refresh result', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let failStats = false;
      deps.readGameBuild = async () => 'A';
      deps.catalogBuilds = () => ({ ...selection('A'), usesAppData: false });
      deps.readGameFileStamps = async () => { if (failStats) throw new Error('fixture locked file'); return selection('A').source; };
      const result = { gameBuild: 'A', items: 1, projectiles: 2, tiles: 3, ms: 4 };
      deps.refreshCatalogs = vi.fn(async () => result);
      controller = make(); await controller.startProxy(); await drain();
      await controller.refreshData(); expect(deps.refreshCatalogs).toHaveBeenCalledOnce();
      const invalidate = vi.fn(); contexts[0].onDataInvalidated(invalidate);
      const reload = vi.fn(); contexts[0].onDataRefreshed(reload);
      failStats = true; await expect(controller.refreshData()).rejects.toThrow('locked file');
      expect(controller.state().data).toMatchObject({ state: 'failed', error: 'fixture locked file', lastResult: result });
      failStats = false; await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.state().data).toMatchObject({ state: 'idle', error: null, lastResult: result });
      expect(invalidate).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
      expect(deps.refreshCatalogs).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(['missing', 'old', 'missing fingerprint', 'wrong fingerprint'])('rejects unverifiable child success (%s) and retries after backoff', async kind => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let build = 'A', published = false;
      deps.readGameBuild = async () => build;
      deps.catalogBuilds = () => {
        if (!published) return selection('A');
        if (kind === 'missing') return { consumables: null, safety: null };
        if (kind === 'old') return selection('A');
        return { ...selection(build), source: kind === 'missing fingerprint' ? null : selection('old').source };
      };
      deps.refreshCatalogs = vi.fn(async () => { published = true; return { gameBuild: build, items: 1, projectiles: 2, tiles: 3, ms: 4 }; });
      controller = make(); await controller.startProxy(); await drain();
      const reload = vi.fn(); contexts[0].onDataRefreshed(reload);
      build = 'B'; hosts[0].emit('session', { id: 'new', remotePort: 123 }); await vi.advanceTimersByTimeAsync(0);
      expect(controller.state().data).toMatchObject({ state: 'failed', catalogBuild: kind === 'missing' ? null : kind === 'old' ? 'A' : 'B', lastResult: null });
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(240_000); expect(deps.refreshCatalogs).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000); expect(deps.refreshCatalogs).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it.each(['shutdown', 'stopProxy'] as const)('%s cancels refresh promptly without waiting for extraction or accepting late results', async stop => {
    await controller.shutdown();
    deps.readGameBuild = async () => 'A'; deps.catalogBuilds = () => ({ consumables: 'A', safety: 'A' });
    let finish!: (result: import('../refreshData.ts').RefreshResult) => void, signal: AbortSignal | undefined;
    deps.refreshCatalogs = vi.fn((_game, _out, input) => { signal = input; return new Promise<import('../refreshData.ts').RefreshResult>(resolve => { finish = resolve; }); });
    controller = make(); await controller.startProxy(); await drain();
    const reload = vi.fn(); contexts[0].onDataRefreshed(reload);
    const refresh = controller.refreshData().catch(error => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    let completed = false; const stopping = controller[stop]().then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    const prompt = completed, aborted = signal?.aborted;
    // Release the fake even on RED so teardown never hangs.
    finish({ gameBuild: 'A', items: 1, projectiles: 2, tiles: 3, ms: 4 });
    await stopping; await refresh;
    expect(prompt).toBe(true); expect(aborted).toBe(true); expect(reload).not.toHaveBeenCalled();
    expect(controller.state().data.lastResult).toBeNull();
  });

  it('fails native preflight before stale cleanup or game-folder mutation', async () => {
    await controller.shutdown();
    writeFileSync(join(root, 'realmtool_target_123.txt'), '54.86.47.176');
    deps.nativeModuleError = () => 'unavailable'; controller = make();
    await expect(controller.startProxy()).rejects.toThrow('native module');
    expect(controller.state().proxy).toMatchObject({ state: 'failed', port: null });
    expect(existsSync(join(root, 'realmtool_target_123.txt'))).toBe(true);
    expect(existsSync(join(game, HELPER_FILE))).toBe(false);
    expect(deps.createHost).not.toHaveBeenCalled();
  });

  it('saves the discovered first-run folder before installing the helper', async () => {
    await controller.shutdown();
    config = new AppConfigStore(join(root, 'first-run'));
    const save = vi.spyOn(config, 'addHelperDir');
    const install = vi.mocked(deps.installHelper!);
    install.mockImplementation((dir, path) => {
      expect(JSON.parse(readFileSync(join(config.dir, 'config.json'), 'utf8')))
        .toMatchObject({ gameDir: game, helperDirs: [game] });
      return installHelper(dir, path);
    });
    controller = make();
    await controller.startProxy(); await drain();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]);
    expect(new AppConfigStore(config.dir).get()).toMatchObject({ gameDir: game, helperDirs: [game] });
  });

  it.each(['disabled', 'write error'])('cleans up and never installs when saving fails: %s', async failure => {
    await controller.shutdown();
    if (failure === 'disabled') {
      writeFileSync(join(config.dir, 'config.json'), JSON.stringify({ schemaVersion: 2 }));
      config = new AppConfigStore(config.dir);
    } else {
      rmSync(join(config.dir, 'config.json'));
      mkdirSync(join(config.dir, 'config.json'));
    }
    controller = make();
    await expect(controller.startProxy()).rejects.toThrow('Could not save the game folder; the helper was not installed');
    expect(deps.installHelper).not.toHaveBeenCalled();
    expect(existsSync(join(game, HELPER_FILE))).toBe(false);
    expect(controller.state().proxy).toMatchObject({ state: 'failed', port: null });
    expect(hosts[0].stop).toHaveBeenCalledOnce();
    expect(hosts[0].configured.at(-1)).toEqual({ fixture: { enabled: false } });
    expect(controller.plugins()).toEqual([]);
    expect(hosts[0].listenerCount('session')).toBe(0);
  });

  it('records explicit helper installation before modifying the game folder', async () => {
    await controller.shutdown();
    config = new AppConfigStore(join(root, 'manual-install'));
    deps.installHelper = vi.fn((dir, path) => {
      expect(new AppConfigStore(config.dir).get()).toMatchObject({ gameDir: game, helperDirs: [game] });
      return installHelper(dir, path);
    });
    controller = make();
    await controller.installHelper();
    expect(deps.installHelper).toHaveBeenCalledOnce();
  });

  it('does not install explicitly when config saving is disabled', async () => {
    await controller.shutdown();
    writeFileSync(join(config.dir, 'config.json'), JSON.stringify({ schemaVersion: 2 }));
    config = new AppConfigStore(config.dir); controller = make();
    await expect(controller.installHelper()).rejects.toThrow('Could not save the game folder; the helper was not installed');
    expect(deps.installHelper).not.toHaveBeenCalled();
  });

  it('retains previously installed folders when switching game folders', async () => {
    const other = join(root, 'other'); mkdirSync(other);
    writeFileSync(join(other, 'RotMG Exalt.exe'), 'fixture');
    await controller.startProxy(); await drain(); await controller.stopProxy();
    await controller.setGameDir(other);
    expect(config.get().helperDirs).toEqual([game]);
    expect(existsSync(join(game, HELPER_FILE))).toBe(true);
    await controller.startProxy(); await drain();
    expect(new AppConfigStore(config.dir).get().helperDirs).toEqual([game, other]);
  });

  it('preserves a target recorded by another store when restarting the proxy', async () => {
    const other = join(root, 'other');
    await controller.startProxy(); await drain(); await controller.stopProxy();
    new AppConfigStore(config.dir).addHelperDir(other);
    await controller.startProxy(); await drain();
    expect(new AppConfigStore(config.dir).get().helperDirs).toEqual([game, other]);
  });

  it.each(['removed', 'restored', 'not-installed', 'foreign'] as const)('forgets the target after uninstall returns %s', async status => {
    await controller.shutdown();
    const other = join(root, 'other');
    config.update({ helperDirs: [game.toUpperCase(), other] });
    deps.uninstallHelper = vi.fn(() => status); controller = make();
    expect(await controller.uninstallHelper()).toBe(status);
    expect(new AppConfigStore(config.dir).get().helperDirs).toEqual([other]);
  });

  it('retains the target when helper uninstall throws', async () => {
    await controller.shutdown();
    config.update({ helperDirs: [game] });
    deps.uninstallHelper = () => { throw new Error('locked'); }; controller = make();
    await expect(controller.uninstallHelper()).rejects.toThrow('locked');
    expect(config.get().helperDirs).toEqual([game]);
  });

  it('installs only after listen and rejects concurrent operations', async () => {
    let listen!: (port: number) => void;
    deps.createHost = () => {
      const host = new FakeHost(); hosts.push(host);
      host.start.mockImplementation(() => new Promise(resolve => { listen = resolve; }));
      return host as unknown as ReturnType<ControllerDeps['createHost']>;
    };
    await controller.shutdown(); controller = make();
    const starting = controller.startProxy();
    await expect(controller.stopProxy()).rejects.toBeInstanceOf(OperationBusyError);
    expect(deps.installHelper).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(listen).toBeTypeOf('function'));
    listen(2050); await starting;
    expect(deps.installHelper).toHaveBeenCalledOnce();
    expect(controller.state().proxy.state).toBe('running');
  });

  it('disables modules, flushes settings before worker stop, and starts a fresh plugin host', async () => {
    await controller.startProxy(); await drain();
    expect(controller.updatePluginSetting('fixture', 'value', 9)).toEqual({ ok: true });
    const path = new ProfileStore({ dir: config.dir }).path;
    hosts[0].stop.mockImplementation(async () => {
      expect(hosts[0].configured.at(-1)).toEqual({ fixture: { enabled: false } });
      expect(JSON.parse(readFileSync(path, 'utf8')).plugins.fixture.settings.value).toBe(9);
    });
    await controller.stopProxy(); expect(controller.state().proxy.state).toBe('stopped');
    await controller.startProxy(); await drain();
    expect(contexts).toHaveLength(2); expect(contexts[1]).not.toBe(contexts[0]);
    expect(contexts[1].getSetting('value')).toBe(9);
  });

  it('saves stopped profile selection and restarts running selection with new settings', async () => {
    await controller.createProfile('second');
    const profile = new ProfileStore({ dir: config.dir, name: 'second' });
    profile.scheduleSave({ schemaVersion: 1, plugins: { fixture: { settings: { value: 7 } } } }); profile.flush();
    await controller.selectProfile('second'); expect(hosts).toHaveLength(0);
    expect(config.get().activeProfile).toBe('second');
    await controller.selectProfile('default'); await controller.startProxy(); await drain();
    controller.updatePluginSetting('fixture', 'value', 3);
    await controller.selectProfile('second');
    expect(hosts[0].stop).toHaveBeenCalledOnce(); expect(hosts).toHaveLength(2);
    expect(contexts[1].getSetting('value')).toBe(7);
    expect(new ProfileStore({ dir: config.dir }).load().plugins.fixture.settings?.value).toBe(3);
  });

  it.each(['default', 'DEFAULT'])('copies pending settings from active profile %s before its debounce expires', async from => {
    const profile = new ProfileStore({ dir: config.dir });
    profile.scheduleSave({ schemaVersion: 1, plugins: { fixture: { settings: { value: 1 } } } }); profile.flush();
    await controller.startProxy(); await drain();
    expect(controller.updatePluginSetting('fixture', 'value', 9)).toEqual({ ok: true });
    expect(profile.load().plugins.fixture.settings?.value).toBe(1);
    await controller.createProfile('copy', from);
    expect(new ProfileStore({ dir: config.dir, name: 'copy' }).load().plugins.fixture.settings?.value).toBe(9);
    expect(hosts[0].stop).not.toHaveBeenCalled();
    await controller.selectProfile('copy');
    expect(contexts[1].getSetting('value')).toBe(9);
  });

  it.each(['missing', '../bad'])('rejects invalid/unknown profile %s without change', async name => {
    const before = controller.state();
    await expect(controller.selectProfile(name)).rejects.toThrow();
    expect(controller.state().profile).toEqual(before.profile);
    expect(config.get().activeProfile).toBe('default'); expect(hosts).toHaveLength(0);
  });

  it('rejects uninstall while running and leaves installed helper on stop', async () => {
    await controller.startProxy(); await drain(); await expect(controller.uninstallHelper()).rejects.toThrow();
    await controller.stopProxy(); expect(inspectHelper(game, helper).state).toBe('installed');
    expect(await controller.uninstallHelper()).toBe('removed');
  });

  it('tracks sessions honestly and reports worker exit with increasing revisions', async () => {
    const states: AppState[] = []; controller.on('state', state => states.push(state));
    await controller.startProxy(); await drain();
    hosts[0].emit('session', { id: 'c', remotePort: 50 });
    expect(controller.state().sessions).toEqual({ open: 1, connected: 0 });
    hosts[0].emit('connected', { id: 'c', generation: 1 });
    hosts[0].emit('connected', { id: 'c', generation: 2 });
    expect(controller.state().sessions).toEqual({ open: 1, connected: 1 });
    hosts[0].emit('exit', { code: 7, expected: false });
    await vi.waitFor(() => expect(hosts[0].stop).toHaveBeenCalledOnce());
    expect(controller.state().proxy).toMatchObject({ state: 'failed', error: expect.stringContaining('7') });
    expect(controller.state().sessions).toEqual({ open: 0, connected: 0 });
    expect(states.every((s, i) => i === 0 || s.revision > states[i - 1].revision)).toBe(true);
  });

  it('emits plugin snapshots and sanitized data', async () => {
    const snapshots = vi.fn(), data = vi.fn(); controller.on('plugins', snapshots); controller.on('data', data);
    await controller.startProxy(); await drain(); controller.setPluginEnabled('fixture', false);
    contexts[0].setData('status', 'ready'); contexts[0].broadcastData('status', { ready: true });
    expect(snapshots).toHaveBeenCalled();
    expect(data).toHaveBeenCalledWith({ pluginId: 'fixture', type: 'status', data: { ready: true } });
  });

  it('fully stops after an asynchronous launcher failure', async () => {
    await controller.shutdown();
    let report!: (error: Error) => void;
    deps.launch = onError => { report = onError; return { kind: 'deca', exe: 'launcher.exe' }; };
    controller = make(); await controller.launchGame();
    report(new Error('spawn failed'));
    await vi.waitFor(() => expect(hosts[0].stop).toHaveBeenCalledOnce());
    expect(controller.state().proxy).toMatchObject({ state: 'failed', port: null, error: expect.stringContaining('spawn failed') });
  });

  it.each([false, true])('rejects a saved game executable before launching (already running=%s)', async running => {
    await controller.shutdown();
    config.update({ launcher: join(game, 'RotMG Exalt.exe') });
    deps.launch = vi.fn(); controller = make();
    if (running) await controller.startProxy(); await drain();
    await expect(controller.launchGame()).rejects.toThrow('Select the RotMG Exalt Launcher');
    expect(controller.state().proxy).toMatchObject({ state: 'failed', port: null, error: expect.stringContaining('Select the RotMG Exalt Launcher') });
    expect(deps.launch).not.toHaveBeenCalled();
    if (running) expect(hosts[0].stop).toHaveBeenCalledOnce();
    else expect(deps.createHost).not.toHaveBeenCalled();
    expect(controller.plugins()).toEqual([]);
  });

  it.each(['validation', 'discovery', 'open'])('cleans up a %s failure after starting for a launch', async failure => {
    await controller.shutdown();
    deps.findLauncher = () => {
      if (failure === 'discovery') throw new Error('discovery failed');
      return { kind: 'deca', exe: join(game, failure === 'validation' ? 'RotMG Exalt.exe' : 'launcher.exe') };
    };
    deps.openLauncher = (_target, onError) => onError(new Error('open failed'));
    controller = make();
    await expect(controller.launchGame()).rejects.toThrow();
    expect(hosts[0].stop).toHaveBeenCalledOnce();
    expect(hosts[0].configured.at(-1)).toEqual({ fixture: { enabled: false } });
    expect(controller.state().proxy).toMatchObject({ state: 'failed', port: null, error: expect.any(String) });
    expect(controller.plugins()).toEqual([]);
  });

  it('shutdown during listen cancels helper installation and is idempotent', async () => {
    await controller.shutdown();
    let listen!: (port: number) => void;
    deps.createHost = () => {
      const host = new FakeHost(); hosts.push(host);
      host.start.mockImplementation(() => new Promise(resolve => { listen = resolve; }));
      return host as unknown as ReturnType<ControllerDeps['createHost']>;
    };
    controller = make(); const starting = controller.startProxy();
    await vi.waitFor(() => expect(listen).toBeTypeOf('function'));
    const shutdown = controller.shutdown(); expect(controller.shutdown()).toBe(shutdown);
    await vi.waitFor(() => expect(listen).toBeTypeOf('function'));
    listen(2050); await starting; await shutdown;
    expect(deps.installHelper).not.toHaveBeenCalled(); expect(hosts[0].stop).toHaveBeenCalledOnce();
    expect(controller.state().proxy.state).toBe('stopped');
  });

  it('keeps a failed profile restart fully stopped with the new selection saved', async () => {
    await controller.createProfile('second'); await controller.startProxy(); await drain();
    vi.mocked(deps.installHelper!).mockImplementationOnce(() => { throw new Error('helper locked'); });
    await expect(controller.selectProfile('second')).rejects.toThrow('helper locked');
    expect(config.get().activeProfile).toBe('second');
    expect(controller.state().proxy.state).toBe('failed');
    expect(hosts.every(host => host.stop.mock.calls.length === 1)).toBe(true);
    expect(controller.plugins()).toEqual([]);
  });
});

describe('inspectHelper', () => {
  it.each([false, true])('reports all four states with backup=%s', backup => {
    const root = mkdtempSync(join(tmpdir(), 'realmtool-inspect-'));
    try {
      const helper = join(root, 'source.dll'); writeFileSync(helper, 'RealmTool-Helper/current');
      if (backup) writeFileSync(join(root, BACKUP_FILE), 'original');
      expect(inspectHelper(root, helper)).toEqual({ state: 'absent', backup });
      for (const [bytes, state] of [['RealmTool-Helper/current', 'installed'], ['RealmTool-Helper/old', 'outdated'], ['foreign', 'foreign']]) {
        writeFileSync(join(root, HELPER_FILE), bytes);
        expect(inspectHelper(root, helper)).toEqual({ state, backup });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
