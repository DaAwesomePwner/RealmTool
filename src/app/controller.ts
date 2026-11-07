import { LoopLagSampler, type LoopLag } from '../transport/latency.ts';
import { computeProtection, type Protection, type ModuleProtection } from './protection.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gameProcessIds } from '../game/gameProcess.ts';
import { readGameFileStamps, readCatalogSourceSync, sameGameFiles, type CatalogSource } from '../data/catalogSource.ts';
import { readGameBuildAsync } from '../game/gameBuild.ts';
import { loadConsumables } from '../data/consumables.ts';
import { loadSafetyCatalog } from '../data/safety.ts';
import { abortable, refreshCatalogs, type RefreshResult, type DataState } from './refreshData.ts';
import { EventEmitter } from 'node:events';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_PLUGINS } from '../../plugins/index.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import { ProfileStore } from '../config/store.ts';
import { createProfile, deleteProfile, listProfiles, validProfileName } from '../config/profiles.ts';
import { findExaltDirs, isExaltDir } from '../game/exaltFinder.ts';
import { BACKUP_FILE, HELPER_FILE, HELPER_MARKER, installHelper, uninstallHelper, inspectHelper, type HelperState, type InstallResult, type UninstallStatus } from '../game/helperInstaller.ts';
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
  /** Always present in controller output; optional for older API state producers. */
  loopLag?: { worker?: LoopLag; main?: LoopLag };
  protection?: Protection & { since: number };
  data: DataState;
  proxy: { state: ProxyState; port: number | null; error: string | null };
  game: { dir: string | null; candidates: string[]; launcher: string | null;
    /** Observed proxy participation, not a protection guarantee. Always emitted by the controller; optional for older state producers. */
    routing?: 'unknown' | 'routed' | 'not-routed';
    /** Explanation of the current routing observation. */
    routingReason?: string;
    /** Unix milliseconds when routing state/reason last changed. */
    routingUpdatedAt?: number;
    helper: { state: HelperState | 'unknown'; backup: boolean } };
  /** Sessions with an upstream connection; never implies the helper DLL is loaded. */
  sessions: { open: number; connected: number };
  profile: { active: string; available: string[] };
  operation: string | null;
  revision: number;
}
export interface ControllerEvents { state: [AppState]; plugins: [PluginSnapshot[]]; data: [{ pluginId: string; type: string; data: unknown }] }
interface CatalogSelection {
  consumables: string | null;
  safety: string | null;
  usesAppData?: boolean;
  source?: CatalogSource | null;
}
export interface ControllerDeps {
  gameProcessIds(): Promise<number[] | null>;
  readGameBuild: typeof readGameBuildAsync;
  catalogBuilds(gameBuild: string): CatalogSelection;
  readGameFileStamps: typeof readGameFileStamps;
  refreshCatalogs: typeof refreshCatalogs;
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

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** One inspector per controller: the bundled helper is immutable during its lifetime. */
function cachedHelperInspector(): typeof inspectHelper {
  let bundled: { path: string; hash: string } | undefined;
  return (gameDir, helperPath) => {
    const backup = existsSync(join(gameDir, BACKUP_FILE));
    const target = join(gameDir, HELPER_FILE);
    if (!existsSync(target)) return { state: 'absent', backup };
    const bytes = readFileSync(target);
    if (!bytes.includes(HELPER_MARKER, 0, 'latin1')) return { state: 'foreign', backup };
    if (bundled?.path !== helperPath) bundled = { path: helperPath, hash: hash(readFileSync(helperPath)) };
    return { state: hash(bytes) === bundled.hash ? 'installed' : 'outdated', backup };
  };
}

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
  private moduleProtection: Record<string, ModuleProtection> = {};
  private sessions = new Set<string>();
  private connected = new Set<string>();
  private pending: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartEpoch = 0;
  private restartAttempts: number[] = [];
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private dataAbort: AbortController | null = null;
  private dataFlight: Promise<RefreshResult | null> | null = null;
  private dataTimer: ReturnType<typeof setInterval> | null = null;
  private routingTimer: ReturnType<typeof setInterval> | null = null;
  private routingFlight: Promise<void> | null = null;
  private observedPids: number[] = [];
  private gameDetected = false;
  private processEpoch = 0;
  private stoppedFlight: Promise<void> | null = null;
  private stoppedTimer: ReturnType<typeof setInterval>;
  private lagTimer: ReturnType<typeof setInterval>;
  private freshnessTimer: ReturnType<typeof setInterval>;
  private nexusStatuses = new Map<string, { status: Record<string, unknown>; at: number }>();
  private connectedAt = new Map<string, number>();
  private routedPids = new Set<number>();
  private unboundSession = false;
  private unroutedSince: number | null = null;
  private catalogBuilds: CatalogSelection | null = null;
  private catalogsInvalidated = false;
  private waitingBuilds = new Set<string>();
  private failures = new Map<string, { retryAt: number; warnAt: number }>();

  constructor(options: { config: AppConfigStore; resources: ResourcePaths; logs: LogRing; fallback?: string }, deps?: Partial<ControllerDeps>) {
    super();
    this.config = options.config; this.resources = options.resources; this.fallback = options.fallback;
    this.deps = {
      gameProcessIds, readGameBuild: readGameBuildAsync, readGameFileStamps, refreshCatalogs,
      catalogBuilds: gameBuild => {
        const options = { appDataDir: this.config.dir, gameBuild };
        const consumables = loadConsumables({ ...options, bundledPath: join(this.resources.dataDir, 'catalogs/consumables.json') });
        const safety = loadSafetyCatalog({ ...options, bundledPath: join(this.resources.dataDir, 'catalogs/safety.json') });
        const out = join(this.config.dir, 'data', 'catalogs');
        const usesAppData = (consumables.ok && consumables.path === join(out, 'consumables.json'))
          || (safety.ok && safety.path === join(out, 'safety.json'));
        return { consumables: consumables.ok ? consumables.catalog.gameBuild : null, safety: safety.ok ? safety.catalog.gameBuild : null,
          usesAppData, source: usesAppData ? readCatalogSourceSync(out) : null };
      },
      createHost: options => new ProxyHost(options), plugins: BUILTIN_PLUGINS,
      nativeModuleError: tcpOwnerSourceError, findGameDirs: findExaltDirs, isGameDir: isExaltDir,
      installHelper, uninstallHelper, inspectHelper: cachedHelperInspector(),
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
      data: { state: 'idle', gameBuild: null, catalogBuild: null, lastResult: null, error: null },
      proxy: { state: 'stopped', port: null, error: null },
      game: { dir: config.gameDir ?? candidates[0] ?? null, candidates, launcher: config.launcher, routing: 'unknown', routingReason: 'Proxy is stopped', routingUpdatedAt: Date.now(), helper: { state: 'unknown', backup: false } },
      sessions: { open: 0, connected: 0 }, profile: { active: config.activeProfile, available: listProfiles(this.config.dir) },
      operation: null, revision: 0,
    };
    this.refreshHelper();
    this.updateProtection();
    this.detachLog = log.addSink(record => options.logs.push(record));
    void this.checkStoppedGame();
    this.stoppedTimer = setInterval(() => { void this.checkStoppedGame(); }, 30_000);
    this.freshnessTimer = setInterval(() => { if (this.connected.size) this.protectionChanged(); }, 1_000);
    const lag = new LoopLagSampler(performance.now());
    this.lagTimer = setInterval(() => {
      const sample = lag.sample(performance.now());
      if (!sample) return;
      this.current.loopLag = { ...this.current.loopLag, main: sample };
      if (sample.max > 50) log.info('Main loop', `Timer drift p99=${sample.p99.toFixed(1)}ms max=${sample.max.toFixed(1)}ms (informational)`);
      this.changed();
    }, 100);
    this.lagTimer.unref();
    this.stoppedTimer.unref(); this.freshnessTimer.unref();
  }

  state(): AppState { return structuredClone(this.current); }
  plugins(): PluginSnapshot[] { return this.pluginHost?.snapshot() ?? []; }
  private updateProtection(): boolean {
    const next = computeProtection({ workerLag: this.current.loopLag?.worker, mainLag: this.current.loopLag?.main, proxy: this.current.proxy.state,
      gameRunning: this.gameDetected || this.observedPids.length > 0 || this.sessions.size > 0,
      routing: this.current.game.routing, routingReason: this.current.game.routingReason,
      helper: this.current.game.helper.state, data: this.current.data, dataInvalidated: this.catalogsInvalidated,
      nexusStatuses: this.connected.size ? [...this.connected].sort().map(id => {
        const sample = this.nexusStatuses.get(id);
        return { status: sample?.status,
          pending: !sample && Date.now() - (this.connectedAt.get(id) ?? 0) < 1_500,
          stale: Date.now() - (sample?.at ?? this.connectedAt.get(id) ?? 0) >= 5_000 };
      }) : undefined,
      plugins: this.plugins(), modules: this.moduleProtection });
    const previous = this.current.protection;
    if (previous?.state === next.state && JSON.stringify(previous.reasons) === JSON.stringify(next.reasons)) return false;
    this.current.protection = { ...next, since: previous?.state === next.state ? previous.since : Date.now() };
    if (previous?.state !== next.state) log.info('Protection', `${previous?.state ?? 'unknown'} → ${next.state}: ${next.reasons.map(r => r.message).join('; ') || 'All readiness checks passed'}`);
    return true;
  }
  private protectionChanged(): void {
    if (this.updateProtection()) { this.current.revision++; this.emitState(); }
  }
  private changed(): void { this.updateProtection(); this.current.revision++; this.emitState(); }
  private emitState(): void {
    const state = this.state();
    // rawListeners preserves EventEmitter once semantics while isolating consumers.
    for (const listener of this.rawListeners('state')) {
      try { listener.call(this, state); }
      catch (error) { log.error('Protection', 'State listener failed', error); }
    }
  }
  private checkStoppedGame(): Promise<void> {
    if (this.shuttingDown || !['stopped', 'failed'].includes(this.current.proxy.state)) return Promise.resolve();
    if (this.stoppedFlight) return this.stoppedFlight;
    const epoch = this.processEpoch;
    this.stoppedFlight = (async () => {
      let pids: number[] | null;
      try { pids = await this.deps.gameProcessIds(); } catch { pids = null; }
      if (this.shuttingDown || this.processEpoch !== epoch || !['stopped', 'failed'].includes(this.current.proxy.state)) return;
      if (pids !== null) { this.observedPids = pids; this.gameDetected = pids.length > 0; this.protectionChanged(); }
    })().finally(() => { if (this.processEpoch === epoch) this.stoppedFlight = null; });
    return this.stoppedFlight;
  }
  private recordNexusStatus(pluginId: string, type: string, data: unknown): void {
    if (pluginId !== 'auto-nexus' || type !== 'status' || !data || typeof data !== 'object') return;
    const status = data as Record<string, unknown>;
    if (typeof status.clientId !== 'string' || status.state === 'disconnected' || !this.sessions.has(status.clientId)) return;
    this.nexusStatuses.set(status.clientId, { status: structuredClone(status), at: Date.now() });
    this.protectionChanged();
  }
  private refreshHelper(): void {
    try { this.current.game.helper = this.current.game.dir ? this.deps.inspectHelper(this.current.game.dir, this.resources.helperDll) : { state: 'unknown', backup: false }; }
    catch { this.current.game.helper = { state: 'unknown', backup: false }; }
  }
  private routing(state: NonNullable<AppState['game']['routing']>, reason: string): void {
    if (this.current.game.routing === state && this.current.game.routingReason === reason) return;
    Object.assign(this.current.game, { routing: state, routingReason: reason, routingUpdatedAt: Date.now() });
    this.changed();
  }
  private recordRoutedSession(): void {
    this.gameDetected = true;
    this.unroutedSince = null;
    if (this.observedPids.length) {
      for (const pid of this.observedPids) this.routedPids.add(pid);
    } else this.unboundSession = true;
    this.routing('routed', 'Game session observed through the proxy');
  }
  private checkRouting(): void {
    if (this.current.proxy.state !== 'running') return;
    // A live session is stronger evidence than process enumeration.
    if (this.sessions.size) { this.recordRoutedSession(); return; }
    if (this.routingFlight) return;
    const host = this.host;
    this.routingFlight = (async () => {
      let pids: number[] | null;
      try { pids = await this.deps.gameProcessIds(); } catch { pids = null; }
      if (this.host !== host || this.current.proxy.state !== 'running') return;
      if (this.sessions.size) {
        if (pids) this.observedPids = pids;
        this.recordRoutedSession();
        return;
      }
      if (pids === null) {
        // Failed enumeration cannot disprove a previously observed session.
        if (this.current.game.routing !== 'routed') this.routing('unknown', 'Game process could not be checked');
        return;
      }
      const changed = pids.length !== this.observedPids.length || pids.some(pid => !this.observedPids.includes(pid));
      this.observedPids = pids;
      this.gameDetected = pids.length > 0;
      this.protectionChanged();
      this.routedPids = new Set([...this.routedPids].filter(pid => pids.includes(pid)));
      if (this.unboundSession) {
        for (const pid of pids) this.routedPids.add(pid);
        this.unboundSession = false;
      }
      if (!pids.length) {
        this.unroutedSince = null;
        this.routing('unknown', 'Game is not running');
      } else if (this.routedPids.size) {
        this.unroutedSince = null;
        this.routing('routed', 'Game session observed through the proxy');
      } else {
        if (changed) this.unroutedSince = null;
        this.unroutedSince ??= Date.now();
        if (Date.now() - this.unroutedSince > 15_000) {
          this.routing('not-routed', "Game is running but has not connected through RealmTool; if you're in game, restart it so the helper loads.");
        } else this.routing('unknown', 'Waiting for a game session');
      }
    })().finally(() => { this.routingFlight = null; });
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

  /** Manual requests join any active refresh, bypassing automatic failure backoff. */
  async refreshData(): Promise<RefreshResult> {
    for (;;) {
      if (this.shuttingDown) throw new OperationBusyError();
      const result = await this.checkData(true);
      if (result) return result;
      // An automatic check may have found matching data without extracting.
      // Recheck shutdown before starting the manual extraction in that case.
    }
  }

  private invalidateData(reason: string): void {
    this.catalogsInvalidated = true;
    this.pluginHost?.notifyDataInvalidated(reason);
  }

  private checkData(manual = false): Promise<RefreshResult | null> {
    if (this.dataFlight) return this.dataFlight;
    const abort = this.dataAbort = new AbortController(), signal = abort.signal;
    this.dataFlight = Promise.resolve().then(async () => {
      let dir = this.current.game.dir ?? 'unknown';
      let build: string | null = null;
      let checkingBuild = true, checkingSource = true, checkingPublication = false;
      const failureKey = () => `${dir}:${build ?? 'unknown'}`;
      try {
        signal.throwIfAborted();
        dir = this.gameDir();
        build = await abortable(this.deps.readGameBuild(dir), signal);
        signal.throwIfAborted();
        checkingBuild = false;
        this.current.data.gameBuild = build;
        this.catalogBuilds ??= this.deps.catalogBuilds(build);
        const { consumables, safety } = this.catalogBuilds;
        this.current.data.catalogBuild = consumables === safety ? consumables : null;
        if (consumables !== build || safety !== build) {
          this.invalidateData('Game data is stale; waiting for verified catalogs');
        }
        const files = await abortable(this.deps.readGameFileStamps(dir), signal);
        signal.throwIfAborted();
        checkingSource = false;
        const { source, usesAppData } = this.catalogBuilds;
        const staleSource = usesAppData && (!source || source.gameBuild !== build || !sameGameFiles(source, files));
        if (!manual && consumables === build && safety === build && !staleSource) {
          this.current.data.state = 'idle'; this.current.data.error = null;
          this.failures.delete(failureKey());
          // Build-read failures cannot be keyed by the build that is now verified.
          this.failures.delete(`${dir}:unknown`);
          if (this.catalogsInvalidated) {
            this.catalogsInvalidated = false;
            if (!this.shuttingDown) this.pluginHost?.notifyDataRefreshed();
            log.info('Data', `Game data verified for build ${build}; catalogs re-enabled`);
          }
          this.changed(); return null;
        }
        if (staleSource || consumables !== build || safety !== build) {
          this.invalidateData('Game data is stale; waiting for verified catalogs');
        }
        if (!manual && (Date.now() - files.resourcesAssets.mtimeMs < 60_000 || Date.now() - files.bootConfig.mtimeMs < 60_000)) {
          if (!this.waitingBuilds.has(build)) {
            this.waitingBuilds.add(build);
            log.info('Data', 'Game files are still changing; waiting to refresh');
          }
          this.changed(); return null;
        }
        if (!manual && Date.now() < (this.failures.get(failureKey())?.retryAt ?? 0)) { this.changed(); return null; }
        this.current.data.state = 'refreshing'; this.current.data.error = null; this.changed();
        log.info('Data', this.current.data.catalogBuild === build ? `Refreshing catalogs for build ${build}…`
          : `Game build changed (${this.current.data.catalogBuild ?? 'unknown'} → ${build}); refreshing catalogs…`);
        signal.throwIfAborted();
        const result = await abortable(this.deps.refreshCatalogs(dir, join(this.config.dir, 'data', 'catalogs'), signal), signal);
        signal.throwIfAborted();
        checkingPublication = true;
        const published = this.catalogBuilds = this.deps.catalogBuilds(result.gameBuild);
        this.current.data.catalogBuild = published.consumables === published.safety ? published.consumables : null;
        if (published.consumables !== result.gameBuild || published.safety !== result.gameBuild) {
          throw new Error('Refreshed catalogs could not be verified after publication');
        }
        if (!published.source || published.source.gameBuild !== result.gameBuild
          || !sameGameFiles(published.source, await abortable(this.deps.readGameFileStamps(dir), signal))) {
          throw new Error('game files changed during refresh; retrying later');
        }
        signal.throwIfAborted();
        checkingPublication = false;
        this.catalogsInvalidated = false;
        this.current.data = { state: 'idle', gameBuild: result.gameBuild, catalogBuild: result.gameBuild, lastResult: result, error: null };
        this.failures.delete(failureKey());
        if (!this.shuttingDown) this.pluginHost?.notifyDataRefreshed();
        log.info('Data', `Catalogs refreshed for build ${result.gameBuild} (${result.items} items, ${result.projectiles} projectiles, ${result.tiles} tiles, ${result.ms} ms)`);
        this.changed(); return result;
      } catch (error) {
        if (signal.aborted) {
          this.current.data.state = 'idle'; this.current.data.error = null; this.changed();
          throw signal.reason;
        }
        if (checkingBuild || (checkingSource && this.catalogBuilds?.usesAppData) || checkingPublication) {
          this.invalidateData('Game data could not be verified; waiting for verified catalogs');
        }
        const key = failureKey(), now = Date.now();
        const warnAt = this.failures.get(key)?.warnAt ?? 0;
        this.failures.set(key, { retryAt: now + 300_000, warnAt: now >= warnAt ? now + 300_000 : warnAt });
        if (now >= warnAt) log.warn('Data', `Refresh failed: ${message(error)}`);
        this.current.data.state = 'failed'; this.current.data.error = message(error); this.changed();
        throw error;
      }
    }).finally(() => { this.dataFlight = null; if (this.dataAbort === abort) this.dataAbort = null; });
    return this.dataFlight;
  }

  private async automaticDataCheck(): Promise<void> {
    try { await this.checkData(); } catch { /* Retained in state and rate-limited above. */ }
  }

  startProxy(): Promise<void> {
    return this.operation('starting proxy', () => { this.cancelRestart(); this.restartAttempts = []; return this.start(); });
  }
  private cancelRestart(): void {
    this.restartEpoch++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.current.proxy.error?.includes('Automatic restart')) {
      const error = this.current.proxy.error.replace(/pending in \d+ ms\./, 'cancelled.');
      if (error !== this.current.proxy.error) { this.current.proxy.error = error; this.changed(); }
    }
  }
  private restartHost(host: ReturnType<ControllerDeps['createHost']>, error: string): void {
    const epoch = this.restartEpoch;
    const now = Date.now();
    // A stable minute naturally expires every attempt; no separate reset clock is needed.
    this.restartAttempts = this.restartAttempts.filter(at => now - at < 60_000);
    const delay = [0, 1000, 5000][this.restartAttempts.length];
    const detail = delay === undefined ? `${error}. Automatic restarts exhausted (3 within 60 seconds); press Start to retry.`
      : `${error}. Automatic restart ${this.restartAttempts.length + 1}/3 pending in ${delay} ms.`;
    log.warn('Proxy', detail);
    this.failHost(host, detail, () => {
      if (delay === undefined || epoch !== this.restartEpoch || this.shuttingDown) return;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void (async () => {
          // Wait for any user operation, then recheck cancellation before acquiring serialization.
          while (this.pending) await this.pending;
          if (epoch !== this.restartEpoch || this.shuttingDown) return;
          await this.operation('restarting proxy', async () => {
            this.restartAttempts.push(Date.now());
            log.warn('Proxy', 'Automatically restarting network proxy');
            await this.start();
          });
        })().catch(error => log.error('Proxy', `Automatic restart failed: ${message(error)}`));
      }, delay);
      this.restartTimer.unref();
    });
  }
  private async start(): Promise<void> {
    if (this.current.proxy.state === 'running') return;
    this.processEpoch++; this.stoppedFlight = null;
    this.moduleProtection = {};
    if (this.current.loopLag) delete this.current.loopLag.worker;
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
      this.catalogBuilds = null;
      if (this.shuttingDown) return;
      stage = 'Proxy';
      const schema = loadSchema(pathToFileURL(this.resources.dataDir + sep));
      const host = this.host = this.deps.createHost({ schema, workerUrl: this.resources.workerUrl, listenPort: GAME_PORT,
        fallbackDestination: this.fallback ? { host: this.fallback, port: GAME_PORT } : null,
        resolveTarget: createTargetResolver({ proxyPort: GAME_PORT }) });
      const plugins = this.pluginHost = new PluginHost({ proxy: host, factory: createFactory(schema), definitions: this.deps.plugins,
        profile: new ProfileStore({ dir: this.config.dir, name: this.current.profile.active }), gameDir,
        onChange: () => { this.protectionChanged(); this.emit('plugins', this.plugins()); },
        onData: (pluginId, type, data) => { this.recordNexusStatus(pluginId, type, data); this.emit('data', { pluginId, type, data: toJsonSafe(data) }); },
      });
      this.watchHost(host);
      plugins.start(); this.emit('plugins', this.plugins());
      log.info('Plugins', `Loaded ${plugins.loaded().join(', ') || 'no plugins'}`);
      const port = await host.start();
      if (this.current.proxy.error) throw new Error(this.current.proxy.error);
      if (this.shuttingDown) return;
      log.info('Proxy', `Listening on 127.0.0.1:${port}`);
      stage = 'Helper'; this.install(gameDir);
      this.current.proxy = { state: 'running', port, error: null }; this.changed();
      void this.automaticDataCheck();
      this.checkRouting();
      this.routingTimer = setInterval(() => this.checkRouting(), 10_000);
      this.routingTimer.unref();
      this.dataTimer = setInterval(() => { this.refreshHelper(); this.changed(); void this.automaticDataCheck(); }, 60_000);
      this.dataTimer.unref();
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
      this.refreshHelper();
      this.recordRoutedSession();
      void this.automaticDataCheck();
      this.sessions.add(id); this.sessionState(); log.info('Proxy', `Game connected (${id.slice(0, 8)}, port ${remotePort})`);
    };
    const onConnected = ({ id }: { id: string }) => { if (this.sessions.has(id)) { this.connected.add(id); this.connectedAt.set(id, Date.now()); this.nexusStatuses.delete(id); this.sessionState(); } };
    const onClosed = ({ id, by }: { id: string; by: string }) => {
      this.sessions.delete(id); this.connected.delete(id); this.connectedAt.delete(id); this.nexusStatuses.delete(id); this.sessionState(); log.info('Proxy', `${id.slice(0, 8)} closed by ${by}`);
    };
    const onRouted = ({ id, host: server, port, restored }: { id: string; host: string; port: number; restored: boolean }) =>
      log.info('Proxy', `${id.slice(0, 8)} → ${server}:${port}${restored ? ' (transfer)' : ''}`);
    const diagnostic = ({ id, message }: { id?: string; message: string }) => log.warn('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`);
    const note = ({ id, message }: { id: string; message: string }) => log.info('Proxy', `${id.slice(0, 8)}: ${message}`);
    const fault = ({ id, message }: { id?: string; message: string }) => log.error('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`);
    // Host recovery scheduling must survive exceptions from downstream state listeners.
    const guard = <T,>(fn: (event: T) => void) => (event: T) => { try { fn(event); } catch (error) { log.error('Protection', 'Module listener failed', error); } };
    const status = guard((event: { moduleId: string; state: string }) => {
      this.moduleProtection[event.moduleId] = { ...this.moduleProtection[event.moduleId], failing: event.state === 'failing' };
      this.protectionChanged();
    });
    const config = guard((event: { moduleId: string; ok: boolean }) => {
      this.moduleProtection[event.moduleId] = { ...this.moduleProtection[event.moduleId], rejected: !event.ok };
      this.protectionChanged();
    });
    const loopLag = guard((sample: LoopLag) => {
      this.current.loopLag = { ...this.current.loopLag, worker: sample };
      this.changed();
    });
    host.on('loopLag', loopLag);
    this.detachHost.push(() => host.off('loopLag', loopLag));
    host.on('moduleStatus', status); host.on('moduleConfig', config);
    this.detachHost.push(() => { host.off('moduleStatus', status); host.off('moduleConfig', config); });
    const exit = ({ code, expected }: { code: number; expected: boolean }) => {
      if (this.host !== host) return;
      this.moduleProtection = {};
      if (this.current.loopLag) delete this.current.loopLag.worker;
      if (expected) { this.protectionChanged(); return; }
      const error = `Network worker stopped unexpectedly (code ${code})`;
      log.error('Proxy', error);
      if (this.current.proxy.state === 'running' && !this.shuttingDown) this.restartHost(host, error);
      else this.failHost(host, error);
    };
    host.on('session', onSession); host.on('connected', onConnected); host.on('closed', onClosed);
    host.on('routed', onRouted); host.on('diagnostic', diagnostic); host.on('note', note); host.on('fault', fault); host.on('exit', exit);
    this.detachHost.push(() => {
      host.off('session', onSession); host.off('connected', onConnected); host.off('closed', onClosed);
      host.off('routed', onRouted); host.off('diagnostic', diagnostic); host.off('note', note); host.off('fault', fault); host.off('exit', exit);
    });
  }
  private failHost(host: ReturnType<ControllerDeps['createHost']>, error: string, afterCleanup?: () => void): void {
    if (this.host !== host || this.shuttingDown) return;
    this.current.proxy = { state: 'failed', port: null, error };
    const cleanup = () => this.host === host && !this.shuttingDown
      ? this.operation('stopping proxy', () => this.cleanup()) : Promise.resolve();
    // Acquire the operation before emitting when idle, so listeners cannot restart
    // over a worker that has not finished stopping. Startup handles its own failure.
    const task = this.pending ? this.pending.then(cleanup) : cleanup();
    this.changed();
    void task.then(() => afterCleanup?.()).catch(error => log.error('Proxy', `Cleanup failed: ${message(error)}`));
  }
  private sessionState(): void {
    this.current.sessions = { open: this.sessions.size, connected: this.connected.size }; this.changed();
  }
  private async cleanup(): Promise<void> {
    this.processEpoch++; this.stoppedFlight = null;
    this.moduleProtection = {};
    if (this.current.loopLag) delete this.current.loopLag.worker;
    this.nexusStatuses.clear(); this.connectedAt.clear();
    if (this.routingTimer) clearInterval(this.routingTimer);
    this.routingTimer = null;
    this.observedPids = []; this.routedPids.clear(); this.unboundSession = false;
    this.unroutedSince = null;
    this.routing('unknown', 'Proxy is stopped');
    this.dataAbort?.abort(new Error('Game data refresh cancelled'));
    await this.dataFlight?.catch(() => {});
    if (this.dataTimer) clearInterval(this.dataTimer);
    this.dataTimer = null;
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
  async stopProxy(): Promise<void> {
    this.cancelRestart();
    // Stop is authoritative even during crash cleanup or an in-flight restart.
    while (this.pending) await this.pending;
    if (this.shuttingDown) { await this.shutdownPromise; return; }
    return this.operation('stopping proxy', () => { this.cancelRestart(); return this.stop(); });
  }
  private async stop(): Promise<void> {
    this.current.proxy = { ...this.current.proxy, state: 'stopping' }; this.changed();
    log.info('Proxy', 'Stopping…');
    try { await this.cleanup(); this.current.proxy = { state: 'stopped', port: null, error: null }; await this.checkStoppedGame(); }
    catch (error) { this.current.proxy = { state: 'failed', port: null, error: message(error) }; throw error; }
    finally { this.changed(); }
  }
  launchGame(): Promise<void> {
    return this.operation('opening launcher', async () => {
      this.cancelRestart(); this.restartAttempts = [];
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
      // Persist recovery targets before the installer can back up or replace a DLL.
      try { this.config.addHelperDir(dir); }
      catch (cause) { throw new Error('Could not save the game folder; the helper was not installed', { cause }); }
      const result = this.deps.installHelper(dir, this.resources.helperDll);
      log.info('Helper', `${result.status} at ${result.target}${result.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
      return result;
    } finally { this.refreshHelper(); this.changed(); }
  }
  installHelper(): Promise<InstallResult> {
    return this.operation('installing helper', async () => { this.cancelRestart(); return this.install(this.gameDir()); });
  }
  uninstallHelper(): Promise<UninstallStatus> {
    return this.operation('uninstalling helper', async () => {
      if (this.host) throw new Error('Stop the proxy before uninstalling the helper');
      this.cancelRestart();
      try {
        const dir = this.gameDir();
        const status = this.deps.uninstallHelper(dir);
        this.config.removeHelperDirs([dir]);
        return status;
      }
      finally { this.refreshHelper(); this.changed(); }
    });
  }
  setGameDir(dir: string): Promise<void> {
    return this.operation('setting game folder', async () => {
      if (this.host) throw new Error('Stop the proxy before changing the game folder');
      if (this.dataFlight) throw new OperationBusyError();
      this.catalogBuilds = null;
      if (!dir.trim() || !this.deps.isGameDir(resolve(dir))) throw new Error('Folder does not contain RotMG Exalt.exe');
      this.cancelRestart();
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
      this.cancelRestart();
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
      this.cancelRestart();
      clearInterval(this.lagTimer); clearInterval(this.stoppedTimer); clearInterval(this.freshnessTimer);
      this.dataAbort?.abort(new Error('Game data refresh cancelled'));
      this.shutdownPromise = (async () => {
        await this.pending;
        await this.dataFlight?.catch(() => {});
        try { await this.stop(); } finally { this.detachLog(); }
      })();
    }
    return this.shutdownPromise;
  }
}
