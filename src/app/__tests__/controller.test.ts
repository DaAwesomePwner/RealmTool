import { setImmediate as nextTurn } from 'node:timers/promises';
import { setTcpOwnerSource } from '../../routing/tcpProcessIdentity.ts';
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
import autoNexus, { register as registerAutoNexus } from '../../../plugins/auto-nexus/index.ts';
import { SafetyEngine } from '../../safety/SafetyEngine.ts';
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
      gameProcessIds: vi.fn(async () => []),
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
    await controller.shutdown(); setTcpOwnerSource(undefined); detach(); log.setConsole(true); vi.unstubAllEnvs();
    expect(root.startsWith(join(tmpdir(), 'realmtool-controller-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('clears worker lag on stop, crash and automatic restart, ignoring retired hosts', async () => {
    vi.useFakeTimers();
    const lag = { p99: 90, max: 120, degraded: true };
    try {
      await controller.startProxy(); await drain();
      hosts[0].emit('loopLag', lag);
      expect(controller.state().loopLag?.worker).toEqual(lag);
      await controller.stopProxy();
      expect(controller.state().loopLag?.worker).toBeUndefined();
      await controller.startProxy(); await drain();
      expect(controller.state().loopLag?.worker).toBeUndefined();
      const crashed = hosts.at(-1)!;
      crashed.emit('loopLag', lag);
      crashed.emit('exit', { code: 7, expected: false });
      expect(controller.state().loopLag?.worker).toBeUndefined();
      await drain(); await vi.advanceTimersByTimeAsync(0);
      expect(controller.state().proxy.state).toBe('running');
      expect(hosts.at(-1)).not.toBe(crashed);
      expect(controller.state().loopLag?.worker).toBeUndefined();
      crashed.emit('loopLag', lag);
      expect(controller.state().loopLag?.worker).toBeUndefined();
      hosts.at(-1)!.emit('loopLag', lag);
      expect(controller.state().loopLag?.worker).toEqual(lag);
    } finally { vi.useRealTimers(); }
  });

  it('automatically rebuilds after crashes with bounded backoff and a crash-loop cap', async () => {
    vi.useFakeTimers();
    try {
      await controller.startProxy(); await drain();
      for (const [index, delay] of [0, 1000, 5000].entries()) {
        hosts.at(-1)!.emit('exit', { code: 7, expected: false }); await drain();
        expect(controller.state().proxy).toMatchObject({ state: 'failed', error: expect.stringContaining('restart') });
        expect(controller.state().protection?.state).toBe('unprotected');
        if (delay) {
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(hosts).toHaveLength(index + 1);
        }
        await vi.advanceTimersByTimeAsync(delay ? 1 : 0);
        expect(hosts).toHaveLength(index + 2);
        expect(controller.state().proxy.state).toBe('running');
        expect(contexts).toHaveLength(index + 2);
      }
      hosts.at(-1)!.emit('exit', { code: 7, expected: false }); await drain();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hosts).toHaveLength(4);
      expect(controller.state().proxy).toMatchObject({ state: 'failed', error: expect.stringContaining('Automatic restarts exhausted') });
    } finally { vi.useRealTimers(); }
  });
  it.each(['stop', 'profile', 'shutdown', 'start', 'uninstall', 'install', 'game-dir'] as const)('%s cancels a pending automatic restart', async action => {
    vi.useFakeTimers();
    try {
      await controller.createProfile('other');
      await controller.startProxy(); await drain();
      hosts[0].emit('exit', { code: 1, expected: false }); await drain();
      await vi.advanceTimersByTimeAsync(0);
      hosts[1].emit('exit', { code: 1, expected: false }); await drain();
      if (action === 'stop') await controller.stopProxy();
      if (action === 'profile') await controller.selectProfile('other');
      if (action === 'shutdown') await controller.shutdown();
      if (action === 'start') await controller.startProxy();
      if (action === 'uninstall') await controller.uninstallHelper();
      if (action === 'install') await controller.installHelper();
      if (action === 'game-dir') await controller.setGameDir(game);
      const installs = vi.mocked(deps.installHelper!).mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(hosts).toHaveLength(action === 'start' ? 3 : 2);
      expect(controller.state().proxy.error ?? '').not.toContain('pending');
      expect(deps.installHelper).toHaveBeenCalledTimes(installs);
      if (action === 'uninstall') {
        expect(inspectHelper(game, helper).state).toBe('absent');
        expect(controller.state().proxy.state).toBe('failed');
      }
    } finally { vi.useRealTimers(); }
  });
  it.each(['cleanup', 'restart'] as const)('honors Stop while crash %s holds the operation lock', async phase => {
    vi.useFakeTimers();
    let release!: () => void;
    try {
      await controller.startProxy(); await drain();
      if (phase === 'cleanup') hosts[0].stop.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      else {
        const create = deps.createHost!;
        // The dependency object is copied by the controller; configure the next host through the existing mock.
        vi.mocked(create).mockImplementationOnce(() => {
          const host = new FakeHost(); hosts.push(host);
          host.start.mockImplementation(() => new Promise(resolve => { release = () => resolve(2050); }));
          return host as unknown as ReturnType<ControllerDeps['createHost']>;
        });
      }
      hosts[0].emit('exit', { code: 1, expected: false }); await drain();
      if (phase === 'restart') await vi.advanceTimersByTimeAsync(0);
      expect(release).toBeTypeOf('function');
      const states: AppState[] = []; controller.on('state', state => states.push(state));
      const stopping = controller.stopProxy();
      if (phase === 'cleanup') expect(states.some(s => s.proxy.error?.includes('cancelled'))).toBe(true);
      release(); await stopping;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.state().proxy.state).toBe('stopped');
      expect(hosts).toHaveLength(phase === 'cleanup' ? 1 : 2);
    } finally { release?.(); vi.useRealTimers(); }
  });
  it('chains crash cleanup after an unrelated operation, then restarts', async () => {
    vi.useFakeTimers();
    try {
      await controller.startProxy(); await drain();
      const creating = controller.createProfile('other');
      expect(controller.state().operation).toBe('creating profile');
      hosts[0].emit('exit', { code: 1, expected: false });
      expect(hosts[0].stop).not.toHaveBeenCalled();
      await creating; await drain();
      expect(hosts[0].stop).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(hosts).toHaveLength(2);
      expect(controller.state().proxy.state).toBe('running');
    } finally { vi.useRealTimers(); }
  });
  it('does not log cleanup failure when Stop queues before crash cleanup', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(log, 'error');
    try {
      await controller.startProxy(); await drain();
      const creating = controller.createProfile('other');
      const stopping = controller.stopProxy();
      hosts[0].emit('exit', { code: 1, expected: false });
      await creating; await stopping; await drain();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.state().proxy.state).toBe('stopped');
      expect(hosts).toHaveLength(1);
      expect(hosts[0].stop).toHaveBeenCalledOnce();
      expect(errors.mock.calls.filter(([, text]) => String(text).includes('Cleanup failed'))).toEqual([]);
    } finally { errors.mockRestore(); vi.useRealTimers(); }
  });

  it('still logs genuine crash cleanup failures after the host is cleared', async () => {
    const errors = vi.spyOn(log, 'error');
    try {
      await controller.startProxy(); await drain();
      hosts[0].stop.mockRejectedValueOnce(new Error('fixture stop failure'));
      hosts[0].emit('exit', { code: 1, expected: false }); await drain();
      expect(errors).toHaveBeenCalledWith('Proxy', 'Cleanup failed: fixture stop failure');
    } finally { errors.mockRestore(); }
  });

  it('logs a failed automatic start and leaves it failed without looping', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(log, 'error');
    try {
      await controller.startProxy(); await drain();
      vi.mocked(deps.createHost!).mockImplementationOnce(() => {
        const host = new FakeHost(); hosts.push(host);
        host.start.mockRejectedValue(new Error('restart listen failed'));
        return host as unknown as ReturnType<ControllerDeps['createHost']>;
      });
      hosts[0].emit('exit', { code: 1, expected: false }); await drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.state().proxy).toMatchObject({ state: 'failed', error: 'restart listen failed' });
      expect(errors).toHaveBeenCalledWith('Proxy', 'Automatic restart failed: restart listen failed');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(hosts).toHaveLength(2);
    } finally { errors.mockRestore(); vi.useRealTimers(); }
  });
  it('resets the automatic restart budget after a stable minute', async () => {
    vi.useFakeTimers();
    try {
      await controller.startProxy(); await drain();
      hosts[0].emit('exit', { code: 1, expected: false }); await drain();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      hosts[1].emit('exit', { code: 1, expected: false }); await drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(hosts).toHaveLength(3);
      expect(controller.state().proxy.state).toBe('running');
    } finally { vi.useRealTimers(); }
  });
  it('expires only old restart attempts at the rolling window boundary', async () => {
    vi.useFakeTimers();
    try {
      await controller.startProxy(); await drain();
      hosts[0].emit('exit', { code: 1, expected: false }); await drain();
      await vi.advanceTimersByTimeAsync(0); // First attempt at t=0.
      await vi.advanceTimersByTimeAsync(1000);
      hosts[1].emit('exit', { code: 1, expected: false }); await drain();
      await vi.advanceTimersByTimeAsync(1000); // Second attempt at t=2000.
      await vi.advanceTimersByTimeAsync(58_000);
      hosts[2].emit('exit', { code: 1, expected: false }); await drain();
      // At t=60000 only the first attempt expires: the next delay is 1s, not 0 or 5s.
      await vi.advanceTimersByTimeAsync(999);
      expect(hosts).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(hosts).toHaveLength(4);
      expect(controller.state().proxy.state).toBe('running');
    } finally { vi.useRealTimers(); }
  });
  it.each(['expected', 'startup'] as const)('does not restart an %s exit', async kind => {
    vi.useFakeTimers();
    try {
      if (kind === 'startup') {
        deps.createHost = () => {
          const host = new FakeHost(); hosts.push(host);
          host.start.mockImplementation(async () => {
            host.emit('exit', { code: 1, expected: false });
            throw new Error('startup failed');
          });
          return host as unknown as ReturnType<ControllerDeps['createHost']>;
        };
        await controller.shutdown(); controller = make();
        await expect(controller.startProxy()).rejects.toThrow('startup failed');
      } else {
        await controller.startProxy(); await drain();
        hosts[0].stop.mockImplementation(async () => { hosts[0].emit('exit', { code: 0, expected: true }); });
        await controller.stopProxy();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hosts).toHaveLength(1);
      expect(controller.state().proxy.state).toBe(kind === 'startup' ? 'failed' : 'stopped');
    } finally { vi.useRealTimers(); }
  });

  async function settleOwnership() {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await nextTurn();
  }
  async function protectedSession() {
    await controller.shutdown();
    deps.readGameBuild = async () => 'A'; deps.catalogBuilds = () => selection('A');
    deps.plugins = ['auto-nexus', 'auto-drink'].map(id => ({ id, name: id, apiVersion: PLUGIN_API_VERSION,
      capabilities: [], register(ctx: PluginContext) { contexts.push(ctx); ctx.enabled = true;
        ctx.setData('status', { protectionState: 'monitoring', collisionHp: 'on' }); } }));
    controller = make(); await controller.startProxy(); await drain();
    const host = hosts.at(-1)!;
    host.emit('session', { id: 'game', remotePort: 123 });
    host.emit('connected', { id: 'game', generation: 1 });
    publishStatus('game'); await drain(); await settleOwnership();
    expect(controller.state().protection?.state).toBe('protected');
    return host;
  }
  function publishStatus(clientId: string, protectionState = 'monitoring') {
    const data = { clientId, protectionState, collisionHp: 'on', degraded: 'server-hp-stale' };
    contexts.at(-2)!.setData('status', data); contexts.at(-2)!.broadcastData('status', data);
  }
  it.each([
    { name: 'low HP', expected: false, override: {}, warn: true },
    { name: 'safe map', expected: false, override: { protectionState: 'safe' }, warn: false },
    { name: 'nexus', expected: false, override: { phase: 'nexus' }, warn: false },
    { name: 'dead', expected: false, override: { phase: 'dead' }, warn: false },
    { name: 'transfer', expected: false, override: { phase: 'transition' }, warn: false },
    { name: 'disabled', expected: false, override: { enabled: false }, warn: false },
    { name: 'unknown HP', expected: false, override: { confirmedHp: null }, warn: false },
    { name: 'high HP', expected: false, override: { confirmedHp: 800, lowerHp: 800 }, warn: false },
    { name: 'expected exit', expected: true, override: {}, warn: false },
  ])('handles worker exit at $name', async ({ expected, override, warn }) => {
    const host = await protectedSession();
    contexts.at(-2)!.broadcastData('status', { clientId: 'game', enabled: true, phase: 'armed',
      protectionState: 'monitoring', confirmedHp: 250, lowerHp: 180, maxHp: 1000, thresholdPct: 25, ...override });
    host.emit('exit', { code: 1, expected });
    expect(controller.state().safetyWarning?.message).toBe(warn
      ? 'Network worker crashed at 18% HP (threshold 25%) — Auto Nexus could not act' : undefined);
    await drain();
  });

  it.each([5000, 12000])('qualifies crash HP when the snapshot is %i ms old', async ageMs => {
    const host = await protectedSession();
    const reportedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(reportedAt);
    contexts.at(-2)!.broadcastData('status', { clientId: 'game', enabled: true, phase: 'armed',
      protectionState: 'monitoring', confirmedHp: 250, lowerHp: 180, maxHp: 1000, thresholdPct: 25 });
    clock.mockReturnValue(reportedAt + ageMs);
    const warn = vi.spyOn(log, 'warn');
    host.emit('exit', { code: 1, expected: false });
    const text = 'Network worker crashed at 18% HP (threshold 25%) — Auto Nexus could not act'
      + (ageMs > 5000 ? ' (last reported 12 s before the crash)' : '');
    expect(controller.state().safetyWarning?.message).toBe(text);
    expect(warn).toHaveBeenCalledWith('Auto Nexus', text);
    clock.mockRestore();
    await drain();
  });

  it('uses each connected client snapshot on crash and excludes disconnected clients', async () => {
    const host = await protectedSession();
    const notice = vi.fn(); controller.on('state', notice);
    for (const id of ['other', 'gone']) {
      host.emit('session', { id, remotePort: 124 });
      host.emit('connected', { id, generation: 1 });
      contexts.at(-2)!.broadcastData('status', { clientId: id, enabled: true, phase: 'armed',
        protectionState: 'monitoring', confirmedHp: 240, lowerHp: 200, maxHp: 1000, thresholdPct: 25 });
    }
    host.emit('closed', { id: 'gone', by: 'game' });
    contexts.at(-2)!.broadcastData('status', { clientId: 'game', enabled: true, phase: 'armed',
      protectionState: 'monitoring', confirmedHp: 250, lowerHp: 180, maxHp: 1000, thresholdPct: 25 });
    notice.mockClear();
    host.emit('exit', { code: 1, expected: false });
    const warnings = notice.mock.calls.map(([state]) => state.safetyWarning?.message);
    expect(warnings.some(text => text?.includes('18% HP'))).toBe(true);
    expect(warnings.some(text => text?.includes('20% HP'))).toBe(true);
    await drain();
  });

  it('emits only changed protection and retains since when only reasons change', async () => {
    const host = await protectedSession();
    const changes = vi.fn(); controller.on('state', changes);
    host.emit('moduleStatus', { moduleId: 'auto-nexus', state: 'failing', since: 1 });
    expect(controller.state().protection?.state).toBe('unprotected');
    const since = controller.state().protection?.since;
    changes.mockClear(); host.emit('moduleStatus', { moduleId: 'auto-nexus', state: 'failing', since: 2 });
    expect(changes).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 5));
    host.emit('moduleConfig', { type: 'moduleConfig', moduleId: 'auto-nexus', ok: false, error: 'bad' });
    expect(changes).toHaveBeenCalledOnce(); expect(controller.state().protection?.since).toBe(since);
  });
  it('logs a throwing state listener and delivers to later and once listeners', async () => {
    const host = await protectedSession(), errors = vi.spyOn(log, 'error');
    const throwing = () => { throw new Error('consumer failed'); }; controller.on('state', throwing);
    const later = vi.fn(), once = vi.fn(); controller.on('state', later); controller.once('state', once);
    expect(() => host.emit('moduleStatus', { moduleId: 'auto-nexus', state: 'failing', since: 1 })).not.toThrow();
    expect(() => host.emit('moduleConfig', { type: 'moduleConfig', moduleId: 'auto-nexus', ok: false, error: 'bad' })).not.toThrow();
    expect(later).toHaveBeenCalledTimes(2); expect(once).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith('Protection', 'State listener failed', expect.any(Error));
    controller.off('state', throwing); errors.mockRestore();
  });
  it('recomputes plugin enabled and monitoring changes', async () => {
    await protectedSession(); publishStatus('game', 'monitoring-degraded');
    expect(controller.state().protection?.state).toBe('degraded');
    contexts[0].enabled = false; expect(controller.state().protection?.reasons.some(r => r.code === 'nexus-disabled')).toBe(true);
  });
  it('resets modules on exit, restart and stop and detaches old listeners', async () => {
    const host = await protectedSession();
    host.emit('moduleStatus', { moduleId: 'auto-nexus', state: 'failing', since: 4 });
    host.emit('exit', { code: 1, expected: false }); await drain();
    expect(controller.state().protection?.state).toBe('unprotected');
    expect(controller.state().protection?.reasons.some(r => r.code === 'auto-nexus-failing')).toBe(false);
    await controller.startProxy(); await drain();
    hosts.at(-1)!.emit('session', { id: 'new', remotePort: 124 });
    hosts.at(-1)!.emit('connected', { id: 'new', generation: 1 }); publishStatus('new'); await drain(); await settleOwnership();
    expect(controller.state().protection?.state).toBe('protected');
    host.emit('moduleStatus', { moduleId: 'auto-nexus', state: 'failing', since: 5 });
    expect(controller.state().protection?.state).toBe('protected');
    await controller.stopProxy(); expect(controller.state().protection?.state).toBe('idle');
    expect(host.listenerCount('moduleStatus')).toBe(0); expect(host.listenerCount('moduleConfig')).toBe(0);
  });
  it('detects a running game at startup and polls while stopped until it closes', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let pids = [123]; deps.gameProcessIds = vi.fn(async () => pids);
      controller = make(); await drain();
      expect(controller.state().protection?.state).toBe('unprotected');
      expect(controller.state().protection?.reasons[0].message).toBe('Game is running but the proxy is stopped');
      pids = []; await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.state().protection?.state).toBe('idle');
    } finally { vi.useRealTimers(); }
  });
  it('checks immediately after stop and then detects game exit without restarting', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let pids = [123]; deps.gameProcessIds = vi.fn(async () => pids);
      controller = make(); await controller.startProxy(); await drain();
      await controller.stopProxy(); expect(controller.state().protection?.state).toBe('unprotected');
      pids = []; await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.state().protection?.state).toBe('idle');
    } finally { vi.useRealTimers(); }
  });
  it('expires status per connected client and recovers on a fresh publication', async () => {
    vi.useFakeTimers();
    try {
      const host = await protectedSession();
      host.emit('session', { id: 'other', remotePort: 124 }); host.emit('connected', { id: 'other', generation: 1 });
      publishStatus('other'); await vi.advanceTimersByTimeAsync(4_000); publishStatus('other');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(controller.state().protection?.reasons.some(r => r.message === 'Auto Nexus status is stale')).toBe(true);
      publishStatus('game'); expect(controller.state().protection?.state).toBe('protected');
      publishStatus('game', 'monitoring-degraded'); publishStatus('other');
      expect(controller.state().protection?.state).toBe('degraded');
      host.emit('closed', { id: 'other', by: 'game' });
      expect(controller.state().protection?.state).toBe('degraded');
      publishStatus('other'); // Late status for a disconnected client cannot replace the remaining client.
      expect(controller.state().protection?.state).toBe('degraded');
      publishStatus('game'); expect(controller.state().protection?.state).toBe('protected');
      host.emit('connected', { id: 'game', generation: 2 });
      expect(controller.state().protection?.state).toBe('protected');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(controller.state().protection?.state).toBe('degraded');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(controller.state().protection?.reasons.some(r => r.code === 'nexus-status-stale')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  async function realNexusSession() {
    await controller.shutdown();
    deps.readGameBuild = async () => 'A'; deps.catalogBuilds = () => selection('A');
    deps.plugins = [{ ...autoNexus, register: ctx => registerAutoNexus(ctx, () => ({ ok: true, path: 'fixture',
      catalog: { schemaVersion: 1, gameBuild: 'A', source: { objectsSha256: 'a'.repeat(64), tilesSha256: 'b'.repeat(64) }, projectiles: [], tiles: [] } }), () => 'A') }];
    controller = make(); await controller.startProxy(); await drain();
    const host = hosts.at(-1)!;
    const connect = (id: string) => { host.emit('session', { id, remotePort: 123 }); host.emit('connected', { id, generation: 1 }); };
    const send = (id: string, generation = 1) => host.emit('module', { id, moduleId: 'auto-nexus', message: {
      type: 'status', generation, sampledAt: performance.now(), collisionHp: 'on',
      catalog: { state: 'ready', gameBuild: 'A', projectiles: 0, tiles: 0 },
      status: { ...new SafetyEngine(() => {}).status(), enabled: true, protectionState: 'monitoring' },
    } });
    return { host, connect, send };
  }
  it('keeps two clients fresh through the real plugin coalescer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const f = await realNexusSession(); f.connect('one'); f.connect('two'); await drain(); await settleOwnership();
      f.send('one'); f.send('two');
      const states: string[] = []; controller.on('state', state => states.push(state.protection!.state));
      // Match worker tick batches: both clients publish back to back every 50ms.
      for (let tick = 0; tick < 140; tick++) {
        await vi.advanceTimersByTimeAsync(50); f.send('one'); f.send('two');
        expect(controller.state().protection?.state).toBe('protected');
      }
      expect(states).not.toContain('degraded');
      f.host.emit('closed', { id: 'two', by: 'game' });
      expect(controller.state().protection?.state).toBe('protected');
      // A genuinely silent remaining client still expires.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(controller.state().protection?.reasons.some(r => r.code === 'nexus-status-stale')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('does not transition or log during a normal reconnect awaiting throttled plugin status', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const records: string[] = [], remove = log.addSink(record => { if (record.module === 'Protection') records.push(record.message); });
    try {
      const f = await realNexusSession(); f.connect('one'); await drain(); await settleOwnership(); f.send('one');
      expect(controller.state().protection?.state).toBe('protected');
      const since = controller.state().protection?.since;
      const states: string[] = []; controller.on('state', state => states.push(state.protection!.state)); records.length = 0;
      await vi.advanceTimersByTimeAsync(50);
      f.host.emit('connected', { id: 'one', generation: 2 }); f.send('one', 2);
      expect(controller.state().protection?.state).toBe('protected');
      await vi.advanceTimersByTimeAsync(250);
      expect(controller.state().protection?.state).toBe('protected');
      expect(controller.state().protection?.since).toBe(since);
      expect(states.every(state => state === 'protected')).toBe(true); expect(records).toEqual([]);
    } finally { remove(); vi.useRealTimers(); }
  });

  it.each(['open', 'closed', 'retired'] as const)('defers ownership lookup and ignores a %s session when appropriate', async disposition => {
    await controller.shutdown(); vi.useFakeTimers();
    const tcpRows = vi.fn(() => null);
    setTcpOwnerSource({ tcpRows, processCreationTime: () => 100n });
    try {
      deps.gameProcessIds = async () => [123];
      controller = make(); await controller.startProxy(); await drain();
      hosts[0].emit('session', { id: 'deferred', remotePort: 32123 });
      expect(tcpRows).not.toHaveBeenCalled();
      if (disposition === 'closed') hosts[0].emit('closed', { id: 'deferred', by: 'game' });
      if (disposition === 'retired') {
        await controller.stopProxy();
        await controller.startProxy(); await drain();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(tcpRows).toHaveBeenCalledTimes(disposition === 'open' ? 1 : 0);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.routing).toBe(disposition === 'open' ? 'routed' : 'not-routed');
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('ignores deferred ownership while stop awaits a data flight (lookup succeeds=%s)', async resolves => {
    await controller.shutdown(); vi.useFakeTimers();
    const tcpRows = vi.fn(() => resolves ? [{
      state: 5, localAddr: 0x0100007f, remoteAddr: 0x0100007f,
      localPort: 32123, remotePort: 2050, pid: 123,
    }] : null);
    setTcpOwnerSource({ tcpRows, processCreationTime: () => 100n });
    let finish!: (result: import('../refreshData.ts').RefreshResult) => void;
    let stopping: Promise<void> | undefined;
    try {
      deps.gameProcessIds = async () => [123, 456];
      deps.readGameBuild = async () => 'A';
      let published = 'old';
      deps.catalogBuilds = () => selection(published);
      deps.refreshCatalogs = vi.fn(() => new Promise<import('../refreshData.ts').RefreshResult>(resolve => { finish = resolve; }));
      controller = make(); await controller.startProxy(); await drain();
      expect(controller.state().data.state).toBe('refreshing');
      hosts[0].emit('session', { id: 'stopping', remotePort: 32123 });
      stopping = controller.stopProxy();
      expect(controller.state().proxy.state).toBe('stopping');
      expect(hosts[0].stop).not.toHaveBeenCalled();
      // Run the immediate before the aborted data flight's promise reactions:
      // cleanup has cleared routing but still retains the host and session.
      vi.advanceTimersByTime(0);
      const duringStop = controller.state().game.routing;
      await stopping;
      expect(tcpRows).not.toHaveBeenCalled();
      expect(duringStop).toBe('unknown');
      expect(controller.state().game.routing).toBe('unknown');
      published = 'A';
      finish({ gameBuild: 'A', items: 1, projectiles: 2, tiles: 3, ms: 4 });
      await controller.startProxy(); await drain();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.routing).toBe('not-routed');
    } finally {
      finish?.({ gameBuild: 'A', items: 1, projectiles: 2, tiles: 3, ms: 4 });
      await stopping;
      vi.useRealTimers();
    }
  });

  it('preserves a routed live PID through transient identity-read failures', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    let created: bigint | null = 100n;
    setTcpOwnerSource({
      tcpRows: () => [{ state: 5, localAddr: 0x0100007f, remoteAddr: 0x0100007f,
        localPort: 32123, remotePort: 2050, pid: 123 }],
      processCreationTime: () => created,
    });
    try {
      deps.gameProcessIds = async () => [123];
      controller = make(); await controller.startProxy(); await drain();
      hosts[0].emit('session', { id: 'game', remotePort: 32123 });
      await vi.advanceTimersByTimeAsync(0);
      hosts[0].emit('closed', { id: 'game', by: 'game' });
      created = null;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.routing).toBe('routed');
      created = 200n;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.routing).toBe('not-routed');
    } finally { vi.useRealTimers(); }
  });

  it('keeps an exact identity received during a stale process enumeration', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    setTcpOwnerSource({
      tcpRows: () => [{ state: 5, localAddr: 0x0100007f, remoteAddr: 0x0100007f,
        localPort: 32123, remotePort: 2050, pid: 456 }],
      processCreationTime: () => 100n,
    });
    try {
      const enumerate = vi.fn(async () => [123]);
      deps.gameProcessIds = enumerate;
      controller = make(); await controller.startProxy(); await drain();
      let finish!: (pids: number[]) => void;
      enumerate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await vi.advanceTimersByTimeAsync(10_000);
      hosts[0].emit('session', { id: 'new', remotePort: 32123 });
      await vi.advanceTimersByTimeAsync(0);
      finish([]); await drain();
      hosts[0].emit('closed', { id: 'new', by: 'game' });
      enumerate.mockResolvedValue([456]);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.routing).toBe('routed');
    } finally { vi.useRealTimers(); }
  });

  for (const scenario of ['two clients', 'proxy restart', 'PID reuse', 'live PID reuse', 'process exit', 'lookup failure'] as const) {
    it(`tracks exact socket ownership: ${scenario}`, async () => {
      await controller.shutdown(); vi.useFakeTimers();
      let pids = scenario === 'two clients' ? [123, 456] : [123];
      let created = 100n;
      setTcpOwnerSource({
        tcpRows: () => {
          if (scenario === 'lookup failure') throw new Error('unavailable');
          return [{ state: 5, localAddr: 0x0100007f, remoteAddr: 0x0100007f,
            localPort: 32123, remotePort: 2050, pid: 123 }];
        },
        processCreationTime: pid => pid === 123 ? created : 200n,
      });
      try {
        deps.gameProcessIds = async () => pids;
        controller = make(); await controller.startProxy(); await drain();
        hosts[0].emit('session', { id: 'game', remotePort: 32123 });
        await vi.advanceTimersByTimeAsync(0);
        if (scenario !== 'two clients' && scenario !== 'lookup failure')
          hosts[0].emit('closed', { id: 'game', by: 'game' });
        if (scenario === 'proxy restart' || scenario === 'PID reuse') {
          await controller.stopProxy();
          if (scenario === 'PID reuse') created = 300n;
          await controller.startProxy(); await drain();
        }
        if (scenario === 'live PID reuse') created = 300n;
        if (scenario === 'process exit') pids = [];
        await vi.advanceTimersByTimeAsync(40_000);
        expect(controller.state().game.routing).toBe(
          scenario === 'two clients' || scenario === 'PID reuse' || scenario === 'live PID reuse' ? 'not-routed'
            : scenario === 'process exit' ? 'unknown' : 'routed');
        if (scenario === 'two clients') {
          pids = [123];
          await vi.advanceTimersByTimeAsync(10_000);
          expect(controller.state().game.routing).toBe('routed');
        }
      } finally { vi.useRealTimers(); }
    });
  }

  it('re-inspects helper on polls and sessions and detects missing routing with a grace period', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let pids = [123];
      deps.gameProcessIds = vi.fn(async () => pids);
      controller = make(); await controller.startProxy(); await drain();
      expect(controller.state().game.routing).toBe('unknown');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(controller.state().game.routing).toBe('not-routed');
      rmSync(join(game, HELPER_FILE));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.helper.state).toBe('absent');
      expect(deps.gameProcessIds).toHaveBeenCalledTimes(8); // Includes startup while stopped.
      writeFileSync(join(game, HELPER_FILE), 'RealmTool-Helper/current');
      hosts[0].emit('session', { id: 'game', remotePort: 123 });
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.state().game).toMatchObject({ routing: 'routed', helper: { state: 'installed' } });
      hosts[0].emit('closed', { id: 'game', by: 'game' });
      pids = []; await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.state().game.routing).toBe('unknown');
      pids = [456]; await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.state().game.routing).toBe('not-routed');
      await controller.stopProxy();
      const count = vi.mocked(deps.gameProcessIds!).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.state().game.routing).toBe('unknown');
      expect(deps.gameProcessIds).toHaveBeenCalledTimes(count + 2); // Stopped polling every 30 seconds.
    } finally { vi.useRealTimers(); }
  });

  it('retains routing at character select, but a new game PID needs a new session', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let pids = [123];
      deps.gameProcessIds = vi.fn(async () => pids);
      controller = make(); await controller.startProxy(); await drain();
      hosts[0].emit('session', { id: 'game', remotePort: 123 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deps.gameProcessIds).toHaveBeenCalledTimes(2); // Startup and proxy start, none with open sessions.
      hosts[0].emit('closed', { id: 'game', by: 'game' });
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.routing).toBe('routed');
      pids = [456]; // Restart between polls, without observing an empty list.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.state().game.routing).toBe('not-routed');
      expect(controller.state().game.routingReason).toContain("if you're in game");
    } finally { vi.useRealTimers(); }
  });

  it('binds fresh PIDs when a restarted game connects during enumeration', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      const enumerate = vi.fn(async () => [123]);
      deps.gameProcessIds = enumerate;
      controller = make(); await controller.startProxy(); await drain();
      let finish!: (pids: number[]) => void;
      enumerate.mockImplementationOnce(() => new Promise<number[]>(resolve => { finish = resolve; }));
      await vi.advanceTimersByTimeAsync(10_000);
      hosts[0].emit('session', { id: 'restarted', remotePort: 123 });
      await vi.advanceTimersByTimeAsync(0);
      finish([456]); await drain();
      enumerate.mockResolvedValue([456]);
      hosts[0].emit('closed', { id: 'restarted', by: 'game' });
      await vi.advanceTimersByTimeAsync(40_000);
      expect(controller.state().game.routing).toBe('routed');
    } finally { vi.useRealTimers(); }
  });

  it('prioritizes an open session over a late empty process result', async () => {
    await controller.shutdown(); vi.useFakeTimers();
    try {
      let finish!: (pids: number[]) => void;
      deps.gameProcessIds = vi.fn(() => new Promise<number[]>(resolve => { finish = resolve; }));
      controller = make(); await controller.startProxy(); await drain();
      hosts[0].emit('session', { id: 'game', remotePort: 123 });
      await vi.advanceTimersByTimeAsync(0);
      finish([]); await drain();
      expect(controller.state().game.routing).toBe('routed');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.state().game.routing).toBe('routed');
      expect(deps.gameProcessIds).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('caches the bundled helper hash while re-reading installed bytes on sessions', async () => {
    await controller.startProxy(); await drain();
    expect(controller.state().game.helper.state).toBe('installed');
    rmSync(helper);
    hosts[0].emit('session', { id: 'one', remotePort: 123 });
    expect(controller.state().game.helper.state).toBe('installed');
    writeFileSync(join(game, HELPER_FILE), 'RealmTool-Helper/old');
    writeFileSync(join(game, BACKUP_FILE), 'backup');
    hosts[0].emit('session', { id: 'two', remotePort: 124 });
    expect(controller.state().game.helper).toEqual({ state: 'outdated', backup: true });
    writeFileSync(join(game, HELPER_FILE), 'foreign');
    hosts[0].emit('session', { id: 'three', remotePort: 125 });
    expect(controller.state().game.helper.state).toBe('foreign');
    rmSync(join(game, HELPER_FILE));
    hosts[0].emit('session', { id: 'four', remotePort: 126 });
    expect(controller.state().game.helper.state).toBe('absent');
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

  it('installs only after listen, rejects other concurrent operations and queues Stop', async () => {
    let listen!: (port: number) => void;
    deps.createHost = () => {
      const host = new FakeHost(); hosts.push(host);
      host.start.mockImplementation(() => new Promise(resolve => { listen = resolve; }));
      return host as unknown as ReturnType<ControllerDeps['createHost']>;
    };
    await controller.shutdown(); controller = make();
    const starting = controller.startProxy();
    await expect(controller.installHelper()).rejects.toBeInstanceOf(OperationBusyError);
    const stopping = controller.stopProxy();
    expect(deps.installHelper).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(listen).toBeTypeOf('function'));
    listen(2050); await starting; await stopping;
    expect(deps.installHelper).toHaveBeenCalledOnce();
    expect(controller.state().proxy.state).toBe('stopped');
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
    expect(controller.state().proxy).toMatchObject({ state: 'failed', error: expect.stringContaining('7') });
    await vi.waitFor(() => expect(controller.state().proxy.state).toBe('running'));
    expect(hosts[0].stop).toHaveBeenCalledOnce();
    expect(controller.state().sessions).toEqual({ open: 0, connected: 0 });
    expect(states.every((s, i) => i === 0 || s.revision > states[i - 1].revision)).toBe(true);
  });

  it('publishes a transient low HP close warning', async () => {
    await controller.startProxy(); await drain();
    hosts[0].emit('module', { moduleId: 'auto-nexus', id: 's1',
      message: { type: 'lowHpClose', hpPct: 18, thresholdPct: 25 } });
    expect(controller.state().safetyWarning).toEqual({
      message: 'Connection closed at 18% HP (threshold 25%) — Auto Nexus could not act',
      expiresAt: expect.any(Number),
    });
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
