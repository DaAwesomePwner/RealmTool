// Commands ported from realm-engine-client client/src/core/CoreCommands.ts, ServerSwitchService.ts and
// client/plugins/ip-connect.ts @ 88a66b2 (MIT, see NOTICE). RECONNECT targets the real server: RealmTool's
// worker Router rewrites every RECONNECT to the game, so no loopback/GUID handling belongs here.
import { join } from 'node:path';
import { resourcePaths } from '../../src/app/resources.ts';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';
import { GAME_PORT } from '../../src/protocol/constants.ts';
import { fallbackServers, resolveServer, ServerDirectory } from './directory.ts';

const NEXUS_GAME_ID = -2;

function defaultDirectory(): ServerDirectory {
  const json = JSON.parse(readFileSync(join(resourcePaths().dataDir, 'servers.json'), 'utf8')) as Record<string, unknown>;
  return new ServerDirectory({ fallback: fallbackServers(json) });
}

function reconnect(ctx: PluginContext, client: ClientConnection, name: string, host: string, port: number): void {
  const packet = ctx.createPacket('RECONNECT');
  packet.data = { name, host, port, gameId: NEXUS_GAME_ID, keyTime: -1, key: Buffer.alloc(0) };
  client.sendToClient(packet);
}

export function createServerSwitch(directory?: ServerDirectory) {
  return definePlugin({
    id: 'server-switch',
    name: 'Server Switch',
    apiVersion: 1,
    capabilities: ['packets', 'commands', 'notifications', 'inject'],
    register(ctx) {
      const servers = directory ?? defaultDirectory();
      ctx.observePacket('HELLO', (_client, packet) => {
        const token = packet.data.accessToken;
        if (typeof token === 'string' && token) void servers.refresh(token);
      });

      ctx.hookCommand('con', (client, _command, args) => {
        const say = (message: string) => ctx.sendNotification(client, 'Server Switch', message);
        if (args.length !== 1) {
          const names = servers.list().map(s => s.name).join(', ');
          say(`Use /con <name, abbreviation, or IPv4>, e.g. /con USEast or /con USE. Servers: ${names || '(none loaded)'}`);
          return;
        }
        const result = resolveServer(args[0], servers.list());
        if (!result.ok) { say(result.message); return; }
        say(`Connecting to ${result.name}...`);
        reconnect(ctx, client, result.name, result.address, GAME_PORT);
      });

      ctx.hookCommand('goto', (client, _command, args) => {
        const say = (message: string) => ctx.sendNotification(client, 'IP Connect', message);
        const parts = args.length === 1 ? args[0].split(':') : [];
        if (parts.length < 1 || parts.length > 2) { say('Usage: /goto {ip} or /goto {ip}:{port}'); return; }
        const [ip, portText] = parts;
        if (!isIPv4(ip)) { say(`Invalid IP: ${ip}`); return; }
        const port = portText === undefined ? GAME_PORT : /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65535) { say(`Invalid port: ${portText}`); return; }
        say(`Connecting to ${ip}:${port}...`);
        reconnect(ctx, client, `${ip}:${port}`, ip, port);
      });

      ctx.hookCommand('ip', client => {
        const server = client.server;
        ctx.sendNotification(client, 'Server Switch', server ? `Connected to ${server.host}:${server.port}` : 'No established server connection.');
      });
    },
  });
}

export default createServerSwitch();
