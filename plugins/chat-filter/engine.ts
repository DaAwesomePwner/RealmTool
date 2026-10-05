// Ported from realm-engine-client client/plugins/chat-filter/engine.ts @ 88a66b2 (MIT, see NOTICE).
import { inferFilterChannel, textViews } from './normalize.ts';
import { advertisingRule, allow, block, contentDecision, type Decision } from './rules.ts';
import type { CompiledSettings } from './settings.ts';
import { SenderState } from './sender-state.ts';

export function evaluate(data: Record<string, unknown>, self: string, settings: CompiledSettings, state: SenderState): Decision {
  if (!settings.enabled) return allow('disabled');
  if (typeof data.name !== 'string') return allow('invalid-sender');
  const sender = data.name.trim();
  const key = sender.toLowerCase();
  if (key === self.trim().toLowerCase() || ['', '*', '#', '[server]'].includes(key)
    || (typeof data.numStars === 'number' && Number.isFinite(data.numStars) && data.numStars < 0)) return allow('exempt');
  if (settings.blocked.has(key) || settings.blockPatterns.some(test => test(key))) return block('blocked-sender');
  if (settings.allowed.has(key) || settings.allowPatterns.some(test => test(key))) {
    state.forget(sender);
    return allow('allowed-sender');
  }
  const channel = inferFilterChannel(data, self);
  const scoped = { public: settings.publicChat, whisper: settings.whispers, guild: settings.guildChat, party: settings.partyChat, unknown: settings.unknownChat };
  if (!scoped[channel]) return allow('channel-excluded');
  if (settings.autoMute && state.isMuted(sender)) return block('muted-sender');
  const views = textViews(data);
  const decision = contentDecision(views, settings);
  // A custom word may be the primary block reason, but must not mask independent
  // high-confidence advertising evidence when advertiser tracking is enabled.
  const advertising = decision.reason === 'advertising' || (settings.autoMute && settings.advertising
    && decision.reason === 'custom-word' && views.some(view => advertisingRule(view) !== null));
  const fingerprints = views.map(v => v.replace(/\s+(?:\d{3,}|<\d+>)$/, ''));
  if (settings.repetition || (settings.autoMute && advertising)) {
    const repeated = state.record(sender, fingerprints, advertising, settings);
    if (decision.action === 'allow' && settings.repetition && repeated) return block('repetition');
  }
  return decision;
}
