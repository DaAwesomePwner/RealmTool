// Ported from realm-engine-client client/plugins/chat-filter.ts @ 88a66b2 (MIT, see NOTICE).
import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';
import { evaluate } from './engine.ts';
import { textViews } from './normalize.ts';
import { SETTING_DEFS, DEFAULTS, groupOf, compileSettings, literalLines, validateChatSetting, normalizeChatProfile, type ChatSettings } from './settings.ts';
import { SenderState } from './sender-state.ts';
import type { Decision } from './rules.ts';

export function register(ctx: PluginContext): void {
  ctx.name = 'Chat Filter';
  ctx.category = 'utility';
  let settings = compileSettings({ ...DEFAULTS });
  const sessions = new Map<ClientConnection, SenderState>();
  let counts: Record<string, number> = {};
  let recent: Array<{ sender: string; reason: string; ruleId?: string; message?: string }> = [];
  let preview: (Decision & { normalized: string[] }) | null = null;
  let actionResult = '';
  let pending: ReturnType<typeof setTimeout> | undefined;

  function publish(): void {
    if (pending) { clearTimeout(pending); pending = undefined; }
    const conflicts = [...settings.allowed].filter(name => settings.blocked.has(name)
      || settings.blockPatterns.some(test => test(name)));
    const status = {
      counts, recent, preview, actionResult, conflicts,
      mutes: [...sessions].flatMap(([client, state]) => state.mutes().map(mute => ({ clientId: client.clientId, ...mute }))),
    };
    ctx.setData('status', status);
    ctx.broadcastData('chatFilterStatus', status);
  }
  function schedulePublish(): void {
    if (!pending) pending = setTimeout(publish, 250);
  }
  function reset(): void {
    sessions.clear(); counts = {}; recent = []; preview = null; actionResult = '';
    publish();
  }
  function configure(): void {
    const values = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, ctx.getSetting(key)])) as ChatSettings;
    settings = compileSettings(values);
    reset();
  }

  for (const { key, ...def } of SETTING_DEFS) {
    ctx.registerSetting(key, def, def.transient ? undefined : configure);
  }
  ctx.registerSetting('testMessage', { label: 'Test message rules (does not change sender history)', type: 'button', value: undefined, ...groupOf('testMessage') }, () => {
    const channel = ctx.getSetting<string>('previewChannel');
    const self = '__preview_self__';
    const data = {
      name: ctx.getSetting<string>('previewSender'), text: ctx.getSetting<string>('previewMessage'), numStars: 20,
      recipient: channel === 'whisper' ? self : channel === 'guild' ? '*guild*' : channel === 'party' ? '*party*' : channel === 'unknown' ? '*unknown*' : '',
    };
    preview = { ...evaluate(data, self, { ...settings, enabled: settings.enabled && ctx.enabled }, new SenderState()), normalized: textViews(data) };
    publish();
  });
  ctx.registerSetting('refreshStatus', { label: 'Refresh filter status / mute countdowns', type: 'button', value: undefined, ...groupOf('refreshStatus') }, publish);
  ctx.registerSetting('clearMutes', { label: 'Clear all temporary mutes and history', type: 'button', value: undefined, ...groupOf('clearMutes') }, reset);
  ctx.registerSetting('unmuteSender', { label: 'Unmute selected sender on all local connections', type: 'button', value: undefined, ...groupOf('unmuteSender') }, () => {
    for (const state of sessions.values()) state.forget(ctx.getSetting<string>('selectedSender'));
    actionResult = 'Temporary history cleared for selected sender.';
    publish();
  });
  function manageSender(allow: boolean): void {
    const sender = ctx.getSetting<string>('selectedSender').trim().toLowerCase();
    if (!sender) { actionResult = 'Enter an exact sender name first.'; publish(); return; }
    const key = allow ? 'allowedSenders' : 'blockedSenders';
    const opposite = allow ? 'blockedSenders' : 'allowedSenders';
    const next = [...new Set([...literalLines(ctx.getSetting<string>(key)), sender])].join('\n');
    if (!ctx.updateSetting(key, next)) { actionResult = 'Sender list is full; edit the list before adding a sender.'; publish(); return; }
    ctx.updateSetting(opposite, literalLines(ctx.getSetting<string>(opposite)).filter(s => s !== sender).join('\n'));
    actionResult = allow ? 'Sender bypass added. Legacy block patterns still take precedence.' : 'Sender added to saved block list.';
    publish();
  }
  ctx.registerSetting('blockSender', { label: 'Always block selected sender', type: 'button', value: undefined, ...groupOf('blockSender') }, () => manageSender(false));
  ctx.registerSetting('allowSender', { label: 'Bypass filtering for selected sender', type: 'button', value: undefined, ...groupOf('allowSender') }, () => manageSender(true));

  ctx.onEnabledChange(reset);
  ctx.on('clientDisconnected', client => { sessions.delete(client); publish(); });
  ctx.registerCleanup(() => { if (pending) clearTimeout(pending); sessions.clear(); });
  ctx.hookPacket('TEXT', (client, packet) => {
    if (!settings.enabled || !packet.isDefined || !packet.data || packet.name !== 'TEXT') return;
    let state = sessions.get(client);
    if (!state) { state = new SenderState(); sessions.set(client, state); }
    const data = packet.data as Record<string, unknown>;
    const result = evaluate(data, client.playerData?.name ?? '', settings, state);
    if (result.action !== 'block') return;
    packet.send = false;
    counts[result.reason] = (counts[result.reason] ?? 0) + 1;
    recent.push({ sender: String(data.name ?? ''), reason: result.reason, ruleId: result.ruleId,
      ...(settings.captureMessages ? { message: String(data.text || data.cleanText || '').slice(0, 2000) } : {}),
    });
    recent = recent.slice(-100);
    schedulePublish();
  }, { prepend: true });
  publish();
}

export default definePlugin({
  id: 'chat-filter', name: 'Chat Filter', apiVersion: 1, capabilities: ['packets'], register,
  settings: { validate: validateChatSetting, migrate: normalizeChatProfile },
});
