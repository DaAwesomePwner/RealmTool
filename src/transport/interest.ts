export interface DirectionalNames {
  client?: readonly string[];
  server?: readonly string[];
}

/** Which packets the main thread must decide on (verdict) or only see (observe). Everything else stays in the worker. */
export interface InterestSpec {
  verdict?: DirectionalNames;
  observe?: DirectionalNames;
}

export type InterestKind = 'verdict' | 'observe' | 'none';

interface Sides {
  client: Set<string>;
  server: Set<string>;
}

const sides = (names: DirectionalNames | undefined): Sides =>
  ({ client: new Set(names?.client ?? []), server: new Set(names?.server ?? []) });

const criticalServer = new Set(['RECONNECT', 'DEATH', 'MAPINFO']);

/** These packets must never depend on a main-thread verdict. */
export const isCriticalPacket = (name: string, fromClient: boolean): boolean =>
  fromClient ? name === 'ESCAPE' : criticalServer.has(name);

export class Interest {
  private verdict: Sides = sides(undefined);
  private observed: Sides = sides(undefined);

  constructor(spec: InterestSpec = {}) {
    this.set(spec);
  }

  set(spec: InterestSpec): void {
    this.verdict = sides(spec.verdict);
    this.observed = sides(spec.observe);
  }

  classify(name: string, fromClient: boolean): InterestKind {
    const side = fromClient ? 'client' : 'server';
    if (this.verdict[side].has(name)) return isCriticalPacket(name, fromClient) ? 'observe' : 'verdict';
    if (this.observed[side].has(name) || this.observed[side].has('*')) return 'observe';
    return 'none';
  }
}
