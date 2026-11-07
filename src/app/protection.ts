import type { PluginSnapshot } from '../plugins/snapshot.ts';

export type ProtectionState = 'idle' | 'protected' | 'degraded' | 'unprotected';
export interface ProtectionReason { code: string; source: string; severity: 'error' | 'warning' | 'info'; message: string }
export interface Protection { state: ProtectionState; reasons: ProtectionReason[] }
export interface ModuleProtection { failing?: boolean; rejected?: boolean }
export interface ProtectionInputs {
  proxy: string; gameRunning: boolean; routing?: string; routingReason?: string; helper: string;
  data: { state: string; gameBuild: string | null; catalogBuild: string | null }; dataInvalidated?: boolean;
  plugins: readonly Pick<PluginSnapshot, 'id' | 'enabled' | 'failed' | 'data'>[];
  nexusStatuses?: { status?: Record<string, unknown>; stale: boolean }[];
  modules: Record<string, ModuleProtection>;
}

/** Errors win over warnings. A stopped proxy is idle only without an observed game.
 * Unknown routing/status/data never earns Protected; optional Auto Drink being off
 * does not disable Auto Nexus. Protected describes observed readiness, not survival.
 */
export function computeProtection(input: ProtectionInputs): Protection {
  const reasons: ProtectionReason[] = [];
  const add = (code: string, source: string, severity: ProtectionReason['severity'], message: string) => reasons.push({ code, source, severity, message });
  if (input.proxy === 'failed') add('proxy-failed', 'proxy', 'error', 'The network proxy failed');
  else if (input.proxy !== 'running') add('proxy-inactive', 'proxy', input.gameRunning ? 'error' : 'info', input.gameRunning ? 'Game is running but the proxy is stopped' : 'The network proxy is not running');
  if (input.gameRunning && input.routing === 'not-routed') add('not-routed', 'routing', 'error', input.routingReason || 'The game is not routed through RealmTool');
  if (input.helper !== 'installed') add('helper-unavailable', 'helper', input.gameRunning ? 'error' : input.helper === 'unknown' ? 'info' : 'warning', `Helper is ${input.helper}; restart the game after installing the current helper`);
  if (input.proxy === 'running') {
    if (!input.gameRunning) add('waiting-for-game', 'game', 'info', 'Waiting for the game');
    if (input.gameRunning && input.routing !== 'routed' && input.routing !== 'not-routed') add('routing-unknown', 'routing', 'warning', 'Game routing has not been verified');
    const nexus = input.plugins.find(p => p.id === 'auto-nexus');
    const drink = input.plugins.find(p => p.id === 'auto-drink');
    if (!nexus || nexus.failed) add('nexus-unavailable', 'auto-nexus', 'error', 'Auto Nexus is unavailable');
    else if (!nexus.enabled) add('nexus-disabled', 'auto-nexus', 'error', 'Auto Nexus is off');
    for (const id of ['auto-nexus', 'auto-drink']) {
      if (id === 'auto-drink' && !drink?.enabled) continue;
      const severity = id === 'auto-nexus' ? 'error' : 'warning';
      const name = id === 'auto-nexus' ? 'Auto Nexus' : 'Auto Drink';
      if (input.modules[id]?.failing) add(`${id}-failing`, id, severity, `${name} worker module is failing`);
      if (input.modules[id]?.rejected) add(`${id}-config-rejected`, id, severity, `${name} configuration was rejected`);
    }
    const statuses = input.nexusStatuses ?? [{ status: nexus?.data.status as Record<string, unknown> | undefined, stale: false }];
    if (nexus?.enabled && !nexus.failed && input.gameRunning) for (const sample of statuses) {
      if (sample.stale) { add('nexus-status-stale', 'auto-nexus', 'warning', 'Auto Nexus status is stale'); continue; }
      const status = sample.status;
      if (status?.protectionState === 'disabled' || status?.protectionState === 'dead') add('nexus-inactive', 'auto-nexus', 'error', `Auto Nexus reports ${status.protectionState}`);
      else if (status?.protectionState && !['safe', 'monitoring', 'monitoring-degraded'].includes(String(status.protectionState))) add('nexus-not-monitoring', 'auto-nexus', 'warning', `Auto Nexus reports ${status.protectionState}; monitoring is not confirmed`);
      if (!status?.protectionState) add('nexus-status-unknown', 'auto-nexus', 'warning', 'Waiting for Auto Nexus monitoring status');
      if (status?.protectionState === 'monitoring-degraded') add('nexus-monitoring-degraded', 'auto-nexus', 'warning', `Auto Nexus monitoring is degraded: ${status.degraded ?? 'unknown reason'}`);
      if (status?.collisionHp === 'fallback') add('collision-hp-fallback', 'auto-nexus', 'warning', 'Collision HP is unavailable; using server HP only');
    }
    const drinkStatus = drink?.data.status as Record<string, unknown> | undefined;
    if (drink?.enabled && (drink.failed || drinkStatus?.state === 'unavailable' || String(drinkStatus?.reason ?? '').includes('catalog unavailable')))
      add('drink-unavailable', 'auto-drink', 'warning', 'Auto Drink is unavailable');
    if (input.data.state === 'failed' || input.dataInvalidated || !input.data.gameBuild || input.data.gameBuild !== input.data.catalogBuild)
      add('data-unverified', 'data', 'warning', 'Game data is stale, unavailable or could not be verified');
  }
  const rank = { error: 0, warning: 1, info: 2 };
  reasons.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const uniqueReasons = reasons.filter((r, i) => reasons.findIndex(other => other.code === r.code && other.message === r.message) === i);
  const state = reasons.some(r => r.severity === 'error') ? 'unprotected'
    : input.proxy !== 'running' && !input.gameRunning ? 'idle'
    : reasons.some(r => r.severity === 'warning') ? 'degraded' : !input.gameRunning ? 'idle' : 'protected';
  return { state, reasons: uniqueReasons };
}
