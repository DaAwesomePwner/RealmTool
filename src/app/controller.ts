import { EventEmitter } from 'node:events';
import { basename, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_PLUGINS } from '../../plugins/index.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import { ProfileStore } from '../config/store.ts';
import { createProfile, deleteProfile, listProfiles, validProfileName } from '../config/profiles.ts';
import { findExaltDirs, isExaltDir } from '../game/exaltFinder.ts';
import { installHelper, uninstallHelper, inspectHelper, type HelperState, type InstallResult, type UninstallStatus } from '../game/helperInstaller.ts';
import { describeLaunchTarget, findLaunchTarget, openLaunchTarget, type LaunchTarget } from '../game/gameLauncher.ts';
import type { PluginDefinition } from '../plugins/api.ts';
import { PluginHost, type ProxyLike } from '../plugins/host.ts';
import { toJsonSafe, type PluginSnapshot } from '../plugins/snapshot.ts';
import { GAME_PORT } from '../protocol/constants.ts';
import { createFactory, loadSchema } from '../protocol/schema.ts';
import { createTargetResolver, removeStaleTargetFiles } from '../routing/targetResolver.ts';
import { tcpOwnerSourceError } from '../routing/tcpProcessIdentity.ts';
import { ProxyHost, type ProxyHostOptions } from '../transport/host.ts';
import { log } from '../util/log.ts';
import type { LogRing } from '../util/logStore.ts';
import type { ResourcePaths } from './resources.ts';

export type ProxyState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export interface AppState {
  proxy: { state: ProxyState; port: number | null; error: string | null };
  game: { dir: string | null; candidates: string[]; launcher: string | null;
    helper: { state: HelperState | 'unknown'; backup: boolean } };
  /** Sessions with an upstream connection; never implies the helper DLL is loaded. */
  sessions: { open: number; connected: number };
  profile: { active: string; available: string[] };
  operation: string | null;
  revision: number;
}
export interface ControllerEvents { state: [AppState]; plugins: [PluginSnapshot[]]; data: [{ pluginId: string; type: string; data: unknown }] }
export interface ControllerDeps {
  createHost(options: ProxyHostOptions): ProxyLike & Pick<ProxyHost, 'start' | 'stop'>;
  plugins: readonly PluginDefinition[];
  nativeModuleError(): string | null;
  findGameDirs(): string[];
  isGameDir(dir: string): boolean;
  installHelper: typeof installHelper;
  uninstallHelper: typeof uninstallHelper;
  inspectHelper: typeof inspectHelper;
  findLauncher(override?: string): LaunchTarget | null;
  openLauncher: typeof openLaunchTarget;
  /** Same combined discovery/open hook as the headless CLI. */
  launch(onError: (error: Error) => void, override?: string): LaunchTarget | null;
}
export class OperationBusyError extends Error {
  constructor() { super('Another operation is in progress'); this.name = 'OperationBusyError'; }
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class AppController extends EventEmitter<ControllerEvents> {
  private readonly config: AppConfigStore;
  private readonly resources: ResourcePaths;
  private readonly fallback?: string;
  private readonly deps: ControllerDeps;
  private readonly detachLog: () => void;
  private current: AppState;
  private host: ReturnType<ControllerDeps['createHost']> | null = null;
  private pluginHost: PluginHost | null = null;
  private detachHost: (() => void)[] = [];
  private sessions = new Set<string>();
  private connected = new Set<string>();
  private pending: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(options: { config: AppConfigStore; resources: ResourcePaths; logs: LogRing; fallback?: string }, deps?: Partial<ControllerDeps>) {
    super();
    this.config = options.config; this.resources = options.resources; this.fallback = options.fallback;
    this.deps = {
      createHost: options => new ProxyHost(options), plugins: BUILTIN_PLUGINS,
      nativeModuleError: tcpOwnerSourceError, findGameDirs: findExaltDirs, isGameDir: isExaltDir,
      installHelper, uninstallHelper, inspectHelper,
      findLauncher: override => findLaunchTarget(undefined, override), openLauncher: openLaunchTarget,
      launch: (onError, override) => {
        const target = this.deps.findLauncher(override);
        if (target) {
          if (target.kind === 'deca') this.validateLauncher(target.exe);
          this.deps.openLauncher(target, onError);
        }
        return target;
      }, ...deps,
    };
    const config = this.config.get();
    const candidates = this.deps.findGameDirs();
    this.current = {
      proxy: { state: 'stopped', port: null, error: null },
      game: { dir: config.gameDir ?? candidates[0] ?? null, candidates, launcher: config.launcher, helper: { state: 'unknown', backup: false } },
      sessions: { open: 0, connected: 0 }, profile: { active: config.activeProfile, available: listProfiles(this.config.dir) },
      operation: null, revision: 0,
    };
    this.refreshHelper();
    this.detachLog = log.addSink(record => options.logs.push(record));
  }

  state(): AppState { return structuredClone(this.current); }
  plugins(): PluginSnapshot[] { return this.pluginHost?.snapshot() ?? []; }
  private changed(): void { this.current.revision++; this.emit('state', this.state()); }
  private refreshHelper(): void {
    try { this.current.game.helper = this.current.game.dir ? this.deps.inspectHelper(this.current.game.dir, this.resources.helperDll) : { state: 'unknown', backup: false }; }
    catch { this.current.game.helper = { state: 'unknown', backup: false }; }
  }
  private refreshProfiles(): void {
    this.current.profile = { active: this.config.get().activeProfile, available: listProfiles(this.config.dir) };
  }
  private gameDir(): string {
    const dir = this.current.game.dir;
    if (!dir || !this.deps.isGameDir(dir)) throw new Error(dir ? `"${dir}" does not contain RotMG Exalt.exe` : 'No Exalt install found. Pass --game-dir or set ROTMG_PATH.');
    return resolve(dir);
  }
  private validateLauncher(path: string): void {
    if (!path.trim() || basename(path).toLowerCase() === 'rotmg exalt.exe') throw new Error('Select the RotMG Exalt Launcher, not the game executable');
  }
  private async operation<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.pending || this.shuttingDown) throw new OperationBusyError();
    let done!: () => void;
    this.pending = new Promise(resolve => { done = resolve; });
    this.current.operation = name; this.changed();
    try { return await action(); }
    finally { this.current.operation = null; this.pending = null; done(); this.changed(); }
  }

  startProxy(): Promise<void> { return this.operation('starting proxy', () => this.start()); }
  private async start(): Promise<void> {
    if (this.current.proxy.state === 'running') return;
    this.current.proxy = { state: 'starting', port: null, error: null }; this.changed();
    let stage = 'Game';
    try {
      // A failed worker may still be awaiting cleanup when a restart is requested.
      if (this.host) await this.cleanup();
      const gameDir = this.gameDir();
      this.current.game.dir = gameDir;
      stage = 'RealmTool';
      if (this.deps.nativeModuleError()) {
        if (!this.fallback) throw new Error(this.resources.packaged
          ? "RealmTool can't load its native module (koffi). Repair or reinstall RealmTool."
          : `RealmTool can't load its native module (koffi): run "npm install" in ${this.resources.root} and try again`);
        log.warn('Routing', `Native module unavailable; new connections will use the fallback server ${this.fallback}`);
      }
      const stale = removeStaleTargetFiles();
      if (stale) log.info('Helper', `Removed ${stale} stale target file(s)`);
      stage = 'Proxy';
      const schema = loadSchema(pathToFileURL(this.resources.dataDir + sep));
      const host = this.host = this.deps.createHost({ schema, workerUrl: this.resources.workerUrl, listenPort: GAME_PORT,
        fallbackDestination: this.fallback ? { host: this.fallback, port: GAME_PORT } : null,
        resolveTarget: createTargetResolver({ proxyPort: GAME_PORT }) });
      const plugins = this.pluginHost = new PluginHost({ proxy: host, factory: createFactory(schema), definitions: this.deps.plugins,
        profile: new ProfileStore({ dir: this.config.dir, name: this.current.profile.active }), gameDir,
        onChange: () => this.emit('plugins', this.plugins()),
        onData: (pluginId, type, data) => this.emit('data', { pluginId, type, data: toJsonSafe(data) }),
      });
      plugins.start(); this.emit('plugins', this.plugins());
      log.info('Plugins', `Loaded ${plugins.loaded().join(', ') || 'no plugins'}`);
      this.watchHost(host);
      const port = await host.start();
      if (this.current.proxy.error) throw new Error(this.current.proxy.error);
      if (this.shuttingDown) return;
      log.info('Proxy', `Listening on 127.0.0.1:${port}`);
      stage = 'Helper'; this.install(gameDir);
      this.current.proxy = { state: 'running', port, error: null }; this.changed();
    } catch (error) {
      log.error(stage, message(error));
      this.current.proxy = { state: 'failed', port: null, error: message(error) }; this.changed();
      try { await this.cleanup(); } catch (cleanupError) { log.error('Proxy', `Cleanup failed: ${message(cleanupError)}`); }
      throw error;
    }
  }

  private watchHost(host: ReturnType<ControllerDeps['createHost']>): void {
    // Retain exact listener references so an old worker cannot affect a subsequent start.
    const onSession = ({ id, remotePort }: { id: string; remotePort: number }) => {
      this.sessions.add(id); this.sessionState(); log.info('Proxy', `Game connected (${id.slice(0, 8)}, port ${remotePort})`);
    };
    const onConnected = ({ id }: { id: string }) => { if (this.sessions.has(id)) { this.connected.add(id); this.sessionState(); } };
    const onClosed = ({ id, by }: { id: string; by: string }) => {
      this.sessions.delete(id); this.connected.delete(id); this.sessionState(); log.info('Proxy', `${id.slice(0, 8)} closed by ${by}`);
    };
    const onRouted = ({ id, host: server, port, restored }: { id: string; host: string; port: number; restored: boolean }) =>
      log.info('Proxy', `${id.slice(0, 8)} → ${server}:${port}${restored ? ' (transfer)' : ''}`);
    const diagnostic = ({ id, message }: { id?: string; message: string }) => log.warn('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`);
    const fault = ({ id, message }: { id?: string; message: string }) => log.error('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`);
    const exit = ({ code, expected }: { code: number; expected: boolean }) => {
      if (expected || this.host !== host) return;
      const error = `Network worker stopped unexpectedly (code ${code})`;
      log.error('Proxy', error); this.failHost(host, error);
    };
    host.on('session', onSession); host.on('connected', onConnected); host.on('closed', onClosed);
    host.on('routed', onRouted); host.on('diagnostic', diagnostic); host.on('fault', fault); host.on('exit', exit);
    this.detachHost.push(() => {
      host.off('session', onSession); host.off('connected', onConnected); host.off('closed', onClosed);
      host.off('routed', onRouted); host.off('diagnostic', diagnostic); host.off('fault', fault); host.off('exit', exit);
    });
  }
  private failHost(host: ReturnType<ControllerDeps['createHost']>, error: string): void {
    if (this.host !== host || this.shuttingDown) return;
    this.current.proxy = { state: 'failed', port: null, error };
    const cleanup = () => this.host === host && !this.shuttingDown
      ? this.operation('stopping proxy', () => this.cleanup()) : Promise.resolve();
    // Acquire the operation before emitting when idle, so listeners cannot restart
    // over a worker that has not finished stopping. Startup handles its own failure.
    const task = this.pending ? this.pending.then(cleanup) : cleanup();
    this.changed();
    void task.catch(error => log.error('Proxy', `Cleanup failed: ${message(error)}`));
  }
  private sessionState(): void {
    this.current.sessions = { open: this.sessions.size, connected: this.connected.size }; this.changed();
  }
  private async cleanup(): Promise<void> {
    const plugins = this.pluginHost, host = this.host;
    this.pluginHost = null; this.host = null;
    for (const detach of this.detachHost.splice(0)) detach();
    try { plugins?.stop(); }
    finally {
      try { if (host) await host.stop(); }
      finally {
        this.sessions.clear(); this.connected.clear(); this.sessionState();
        this.refreshHelper(); this.emit('plugins', this.plugins());
      }
    }
  }
  stopProxy(): Promise<void> { return this.operation('stopping proxy', () => this.stop()); }
  private async stop(): Promise<void> {
    this.current.proxy = { ...this.current.proxy, state: 'stopping' }; this.changed();
    log.info('Proxy', 'Stopping…');
    try { await this.cleanup(); this.current.proxy = { state: 'stopped', port: null, error: null }; }
    catch (error) { this.current.proxy = { state: 'failed', port: null, error: message(error) }; throw error; }
    finally { this.changed(); }
  }
  launchGame(): Promise<void> {
    return this.operation('opening launcher', async () => {
      const override = this.current.game.launcher ?? undefined;
      try { if (override !== undefined) this.validateLauncher(override); }
      catch (error) {
        const detail = `Could not open the launcher: ${message(error)}`;
        log.error('Game', detail);
        this.current.proxy = { state: 'failed', port: null, error: detail }; this.changed();
        try { await this.cleanup(); } catch (cleanupError) { log.error('Proxy', `Cleanup failed: ${message(cleanupError)}`); }
        throw error;
      }
      await this.start();
      if (this.shuttingDown) return;
      const host = this.host!;
      let launchError: Error | null = null;
      const onError = (error: Error) => {
        launchError = error; log.error('Game', `Could not open the launcher: ${error.message}`);
        this.failHost(host, `Could not open the launcher: ${error.message}`);
      };
      let target: LaunchTarget | null;
      try { target = this.deps.launch(onError, override); }
      catch (error) { onError(error instanceof Error ? error : new Error(message(error))); await this.cleanup(); throw error; }
      if (launchError) { await this.cleanup(); throw launchError; }
      if (target) log.info('Game', `Opened ${describeLaunchTarget(target)}. Click Play; RealmTool routes the game automatically.`);
      else log.warn('Game', 'Could not find the RotMG Exalt Launcher or Steam. Start the game the way you normally do; RealmTool is ready.');
    });
  }
  private install(dir: string): InstallResult {
    try {
      const result = this.deps.installHelper(dir, this.resources.helperDll);
      log.info('Helper', `${result.status} at ${result.target}${result.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
      return result;
    } finally { this.refreshHelper(); this.changed(); }
  }
  installHelper(): Promise<InstallResult> { return this.operation('installing helper', async () => this.install(this.gameDir())); }
  uninstallHelper(): Promise<UninstallStatus> {
    return this.operation('uninstalling helper', async () => {
      if (this.host) throw new Error('Stop the proxy before uninstalling the helper');
      try { return this.deps.uninstallHelper(this.gameDir()); }
      finally { this.refreshHelper(); this.changed(); }
    });
  }
  setGameDir(dir: string): Promise<void> {
    return this.operation('setting game folder', async () => {
      if (this.host) throw new Error('Stop the proxy before changing the game folder');
      if (!dir.trim() || !this.deps.isGameDir(resolve(dir))) throw new Error('Folder does not contain RotMG Exalt.exe');
      this.config.update({ gameDir: resolve(dir) }); this.current.game.dir = resolve(dir); this.refreshHelper(); this.changed();
    });
  }
  setLauncher(path: string | null): Promise<void> {
    return this.operation('setting launcher', async () => {
      if (path !== null) this.validateLauncher(path);
      this.config.update({ launcher: path }); this.current.game.launcher = path; this.changed();
    });
  }
  selectProfile(name: string): Promise<void> {
    return this.operation('selecting profile', async () => {
      if (!validProfileName(name)) throw new Error('Invalid profile name');
      const selected = listProfiles(this.config.dir).find(entry => entry.toLowerCase() === name.toLowerCase());
      if (!selected) throw new Error(`Profile does not exist: ${name}`);
      if (selected === this.current.profile.active) return;
      const running = this.current.proxy.state === 'running';
      this.config.update({ activeProfile: selected }); this.refreshProfiles(); this.changed();
      if (running) { await this.stop(); if (!this.shuttingDown) await this.start(); }
    });
  }
  createProfile(name: string, from?: string): Promise<void> {
    return this.operation('creating profile', async () => {
      if (this.current.proxy.state === 'running' && from?.toLowerCase() === this.current.profile.active.toLowerCase()) {
        this.pluginHost?.flush();
      }
      createProfile(name, from, this.config.dir); this.refreshProfiles(); this.changed();
    });
  }
  deleteProfile(name: string): Promise<void> {
    return this.operation('deleting profile', async () => {
      deleteProfile(name, this.current.profile.active, this.config.dir); this.refreshProfiles(); this.changed();
    });
  }
  setPluginEnabled(id: string, enabled: boolean): { ok: true } | { ok: false; error: string } {
    if (this.pending || this.shuttingDown) throw new OperationBusyError();
    return this.pluginHost?.setEnabled(id, enabled) ?? { ok: false, error: 'Proxy is stopped' };
  }
  updatePluginSetting(id: string, key: string, value: unknown): { ok: true } | { ok: false; error: string } {
    if (this.pending || this.shuttingDown) throw new OperationBusyError();
    return this.pluginHost?.updateSetting(id, key, value) ?? { ok: false, error: 'Proxy is stopped' };
  }
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true;
      this.shutdownPromise = (async () => {
        await this.pending;
        try { await this.stop(); } finally { this.detachLog(); }
      })();
    }
    return this.shutdownPromise;
  }
}
