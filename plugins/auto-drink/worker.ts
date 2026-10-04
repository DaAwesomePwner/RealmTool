// Adapted from realm-engine-client client/src/proxy/network-worker.ts @ 88a66b2 (MIT, see NOTICE).
import { AutoDrinkController } from '../../src/auto-drink/AutoDrinkController.ts';
import { DEFAULT_AUTO_DRINK_SETTINGS } from '../../src/auto-drink/AutoDrinkTypes.ts';
import type { WorkerModule } from '../../src/transport/modules.ts';
import { validateConfig, type AutoDrinkEvent } from './messages.ts';
import { readGameBuildAsync } from '../../src/game/gameBuild.ts';
import { describeError } from '../../src/util/describeError.ts';

/** An independent module owner, also useful for isolated session tests. */
export function createAutoDrinkModule(buildReader: (gameDir: string) => Promise<string> = readGameBuildAsync): WorkerModule {
  let config = validateConfig({ settings: DEFAULT_AUTO_DRINK_SETTINGS, items: [], gameBuild: null, gameDir: null });
  const sessions = new Set<() => void>();
  return {
    id: 'auto-drink', priority: 10,
    observe: { server: ['MAPINFO', 'CREATESUCCESS', 'UPDATE', 'NEWTICK', 'DAMAGE', 'DEATH'], client: ['ESCAPE'] },
    writtenServer: ['RECONNECT'],
    written: ['MOVE', 'PONG', 'PLAYERSHOOT', 'USEITEM', 'INVENTORYSWAP', 'INVDROP', 'ESCAPE'],
    configure(value) {
      const next = validateConfig(value);
      config = next;
      for (const apply of sessions) apply();
    },
    createSession(context) {
      let escapedGeneration: number | null = null;
      let closed = false;
      let lastStatus = '';
      let lastPostedAt = -Infinity;
      let verification = 0;
      let catalogReason = '';
      const controller = new AutoDrinkController({
        now: () => context.now(), wallNow: () => Date.now(),
        send(use) {
          const transport = context.transport();
          if (closed || !transport.available || transport.backlog || context.automation.escapeLatched()) return false;
          try {
            const packet = context.factory.createByName('USEITEM');
            packet.data = use;
            const bytes = context.factory.serialize(packet);
            if (bytes.length < 5) return false;
            const decoded = context.factory.createFromBytes(bytes, 'client');
            if (!decoded.isDefined || decoded.name !== 'USEITEM' || JSON.stringify(decoded.data) !== JSON.stringify(use)) return false;
            return context.writePriority(bytes, false, () => {}, 'auto-drink');
          } catch { return false; }
        },
      });
      function apply(): void {
        const next = config;
        const token = ++verification;
        controller.configure(next.settings);
        // Catalog membership is also needed to account for accepted manual inventory consumption.
        // Verification blocks automatic selection in evaluate, not outgoing bookkeeping.
        controller.setCatalog(next.items);
        catalogReason = next.gameDir === null ? 'installed game build unknown (game directory unavailable)'
          : next.gameBuild === null ? 'catalog game build unknown' : 'verifying installed game build';
        if (next.gameDir === null || next.gameBuild === null) return;
        // Each session checks independently, including sessions opened while the main thread is stalled.
        // A replaced config or closed session must never accept a late result from this read.
        void (async () => {
          try {
            const installed = await buildReader(next.gameDir!);
            if (closed || token !== verification) return;
            if (installed !== next.gameBuild) {
              catalogReason = `catalog is for game build ${next.gameBuild} but the installed game is ${installed}; run npm run gen:catalogs`;
              return;
            }
            catalogReason = '';
          } catch (error) {
            if (!closed && token === verification) catalogReason = `installed game build unknown (${describeError(error)})`;
          }
        })();
      }
      apply();
      sessions.add(apply);
      return {
        observe(packet, fromClient) {
          if (fromClient) { if (packet.name === 'ESCAPE') controller.escape(); }
          else controller.observeServer(packet);
        },
        written(packet, _kind, _now, _observationId, origin) {
          if (origin !== 'auto-drink') controller.observeOutgoing(packet);
        },
        writtenServer(packet) {
          if (packet.name === 'RECONNECT') controller.escape();
        },
        allowWrite(name, toClient, kind, decode) {
          return toClient || kind !== 'injected' || name !== 'INVENTORYSWAP' || !controller.blocksInjectedSwap(decode());
        },
        connectionChanged() {
          escapedGeneration = null;
          controller.connectionChanged();
          lastStatus = '';
        },
        tick(now) {
          if (closed) return;
          const generation = context.generation();
          if (context.automation.escapeLatched() && escapedGeneration !== generation) {
            controller.escape();
            escapedGeneration = generation;
          }
          controller.evaluate({ ...context.transport(), escape: context.automation.escapeLatched(),
            consumptionBlockReason: catalogReason ? `consumables catalog unavailable: ${catalogReason}` : undefined });
          const status = controller.status();
          const signature = JSON.stringify([generation, status]);
          if (signature !== lastStatus && now - lastPostedAt >= 200) {
            context.post({ type: 'status', status, generation } satisfies AutoDrinkEvent);
            lastStatus = signature;
            lastPostedAt = now;
          }
        },
        close() {
          if (closed) return;
          closed = true;
          controller.disconnect();
          try { context.post({ type: 'status', status: controller.status(), generation: context.generation() } satisfies AutoDrinkEvent); }
          finally { sessions.delete(apply); }
        },
      };
    },
  };
}

export const autoDrinkModule = createAutoDrinkModule();
