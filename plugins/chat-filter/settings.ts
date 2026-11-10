// Ported from realm-engine-client client/plugins/chat-filter/settings.ts @ 88a66b2 (MIT, see NOTICE).
import type { SettingDef } from '../../src/plugins/api.ts';
import { readableText } from './normalize.ts';

export const DEFAULTS = {
  schemaVersion: 1,
  enabled: true,
  blockedWordsEnabled: true,
  blockedWords: '',
  wordMatch: 'contains',
  advertising: true,
  trade: false,
  repetition: true,
  repeatCount: 3,
  repeatWindowSeconds: 20,
  autoMute: false,
  muteMinutes: 10,
  publicChat: true,
  whispers: true,
  guildChat: false,
  partyChat: false,
  unknownChat: false,
  allowedSenders: '',
  blockedSenders: '',
  whitelist: '',
  blacklist: '',
  captureMessages: false,
  previewMessage: '',
  previewSender: 'PreviewPlayer',
  previewChannel: 'public',
  selectedSender: '',
};
export type ChatSettings = typeof DEFAULTS;
export type ChatSettingKey = keyof ChatSettings;

const labels: Record<ChatSettingKey, string> = {
  schemaVersion: 'Chat filter schema', enabled: 'Chat filter',
  blockedWordsEnabled: 'Block custom words / phrases', blockedWords: 'Blocked words / phrases — one per line',
  wordMatch: 'Word matching', advertising: 'Block advertising and disguised shop links',
  trade: 'Hide trade chat (WTB / WTS / WTT / WTA, bulk keys)', repetition: 'Suppress repeated messages',
  repeatCount: 'Repetition — block starting at message', repeatWindowSeconds: 'Repetition window (seconds)',
  autoMute: 'Temporarily mute repeat advertisers (local only)', muteMinutes: 'Mute duration (minutes)',
  publicChat: 'Filter public chat (Nexus / Realm / other maps)', whispers: 'Filter incoming whispers',
  guildChat: 'Filter guild chat', partyChat: 'Filter party chat', unknownChat: 'Filter unclassified chat',
  allowedSenders: 'Bypass content / spam filtering — exact sender names, one per line',
  blockedSenders: 'Block senders in all channels — exact names, one per line',
  whitelist: 'Legacy bypass patterns — substring or /regex/ per line (block list wins)',
  blacklist: 'Legacy block patterns — substring or /regex/ per line',
  captureMessages: 'Capture recent blocked message bodies in memory',
  previewMessage: 'Test message (not saved)', previewSender: 'Test sender (not saved)',
  previewChannel: 'Test channel', selectedSender: 'Sender to manage (exact name, not saved)',
};
/** Display sections for every Chat Filter setting, including the button settings registered in index.ts. */
const GROUPS: Record<string, readonly string[]> = {
  'What to hide': ['enabled', 'trade', 'advertising', 'repetition', 'repeatCount', 'repeatWindowSeconds'],
  'Custom words': ['blockedWordsEnabled', 'blockedWords', 'wordMatch'],
  'Repeat advertisers': ['autoMute', 'muteMinutes'],
  'Where to filter': ['publicChat', 'whispers', 'guildChat', 'partyChat', 'unknownChat'],
  'Senders': ['allowedSenders', 'blockedSenders', 'selectedSender', 'unmuteSender', 'blockSender', 'allowSender', 'clearMutes'],
  'Test and diagnostics': ['previewMessage', 'previewSender', 'previewChannel', 'captureMessages', 'testMessage', 'refreshStatus'],
};
/** The `group` field for a setting key, or an empty object when the key is ungrouped. */
export function groupOf(key: string): { group?: string } {
  const group = Object.keys(GROUPS).find(name => GROUPS[name]!.includes(key));
  return group ? { group } : {};
}
const lists = new Set(['blockedWords', 'allowedSenders', 'blockedSenders', 'whitelist', 'blacklist']);
export const SETTING_DEFS: SettingDef[] = (Object.keys(DEFAULTS) as ChatSettingKey[]).map(key => ({
  key, label: labels[key], value: DEFAULTS[key], ...groupOf(key),
  type: key === 'wordMatch' || key === 'previewChannel' ? 'select' : typeof DEFAULTS[key] === 'boolean' ? 'boolean'
    : typeof DEFAULTS[key] === 'number' ? 'number' : 'text',
  ...(lists.has(key) ? { multiline: true, rows: 4, maxLength: 100_500 } : {}),
  ...(key === 'wordMatch' ? { options: [{ label: 'Contains', value: 'contains' }, { label: 'Whole word / phrase', value: 'whole' }] } : {}),
  ...(key === 'previewChannel' ? { options: ['public', 'whisper', 'guild', 'party', 'unknown'].map(value => ({ label: value, value })) } : {}),
  ...(['previewMessage', 'previewSender', 'previewChannel', 'selectedSender'].includes(key) ? { transient: true, maxLength: key === 'previewMessage' ? 2000 : 100 } : {}),
  ...(key === 'previewMessage' ? { multiline: true, rows: 3 } : {}),
  ...(key === 'schemaVersion' ? { hidden: true } : {}),
  ...(['whitelist', 'blacklist', 'repeatCount', 'repeatWindowSeconds', 'unknownChat', 'captureMessages'].includes(key) ? { advanced: true } : {}),
  ...(key === 'repeatCount' ? { min: 2, max: 20 } : {}),
  ...(key === 'repeatWindowSeconds' ? { min: 1, max: 120 } : {}),
  ...(key === 'muteMinutes' ? { min: 1, max: 120, visibleWhen: { key: 'autoMute', value: true } } : {}),
  ...(key === 'blockedWords' ? { help: 'Any match hides the entire message. Literal text; # and punctuation are not comments. Maximum 500 entries, 200 characters each.' } : {}),
  ...(key === 'allowedSenders' ? { help: 'Applies to all player-chat channels. Explicit block rules take precedence over bypass rules.' } : {}),
}));

export function literalLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean))];
}

export function legacyMatchers(value: string): Array<(sender: string) => boolean> {
  return value.split(/[\r\n]+/).map(s => s.replace(/\s+#.*$/, '').trim())
    .filter(s => s && !s.startsWith('#')).map(line => {
      if (!line.startsWith('/')) return (sender: string) => sender.includes(line.toLowerCase());
      const end = line.lastIndexOf('/');
      if (end < 2 || !/^[dgimsuy]*$/.test(line.slice(end + 1))) throw new Error('Invalid legacy sender regex');
      let regex: RegExp;
      try { regex = new RegExp(line.slice(1, end), line.slice(end + 1)); }
      catch { throw new Error('Invalid legacy sender regex'); }
      return (sender: string) => { regex.lastIndex = 0; return regex.test(sender); };
    });
}

export function validateChatSetting(key: string, value: unknown): unknown {
  const def = SETTING_DEFS.find(s => s.key === key);
  if (!def) throw new Error(`Unknown chat filter setting: ${key}`);
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${def.label}: expected boolean`);
  } else if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)
      || value < (def.min ?? 1) || value > (def.max ?? 1)) throw new Error(`${def.label}: invalid number`);
  } else {
    if (typeof value !== 'string') throw new Error(`${def.label}: expected text`);
    if (key === 'wordMatch' && value !== 'contains' && value !== 'whole') throw new Error('Invalid word matching mode');
    if (def.options && !def.options.some(o => o.value === value)) throw new Error(`${def.label}: invalid option`);
    if (def.maxLength && value.length > def.maxLength) throw new Error(`${def.label}: text too long`);
    if ((key === 'selectedSender' || key === 'previewSender') && /[\r\n]/.test(value)) throw new Error('Expected a single sender name');
    if (lists.has(key)) {
      if (value.length > 100_500 || value.split(/\r?\n/).length > 500
        || value.split(/\r?\n/).some(s => s.length > 200)) throw new Error(`${def.label}: maximum 500 lines of 200 characters`);
      if (key === 'whitelist' || key === 'blacklist') legacyMatchers(value);
    }
  }
  return value;
}

/** Missing plugin resets to fresh defaults; an existing unversioned entry retains trade blocking. */
export function normalizeChatProfile(settings: unknown, present: boolean): ChatSettings {
  if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) throw new Error('Invalid Chat Filter settings');
  const saved = (settings ?? {}) as Record<string, unknown>;
  const result = { ...DEFAULTS, trade: present && saved.schemaVersion === undefined };
  for (const key of Object.keys(DEFAULTS) as ChatSettingKey[]) {
    if (!SETTING_DEFS.find(s => s.key === key)?.transient && Object.hasOwn(saved, key)) Object.assign(result, { [key]: validateChatSetting(key, saved[key]) });
  }
  return result;
}

export function compileSettings(settings: ChatSettings) {
  return {
    ...settings,
    words: [...new Set(literalLines(settings.blockedWords).map(readableText).filter(Boolean))],
    allowed: new Set(literalLines(settings.allowedSenders)),
    blocked: new Set(literalLines(settings.blockedSenders)),
    allowPatterns: legacyMatchers(settings.whitelist),
    blockPatterns: legacyMatchers(settings.blacklist),
  };
}
export type CompiledSettings = ReturnType<typeof compileSettings>;
