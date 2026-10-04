# Phase 2 port details - Realm Engine 88a66b2

Research date: 2026-10-03. Source `main`/HEAD: `88a66b2155cddfe9c1bd086e58d408941dcef697`; tracked client files match. Existing untracked files untouched. RealmTool HEAD: `ff2af4ad3f94adea396d34a174286e839505420e`. Static inspection only: tests were counted, not executed; no API requests or gameplay validation. Citations link to pinned source; `RT...` citations reference RealmTool. This report is the only file written.

## 1. Chat Filter: complete inventory

Six files, **447 lines total**, including blank lines. Imports are exhaustive; paths relative; `type` means type-only.

| File | Lines | Imports |
|---|---:|---|
| `client/plugins/chat-filter.ts` | 96 | `./api.js`: type `PluginContext, ClientConnection`; `./chat-filter/engine.js`: `evaluate`; `./chat-filter/normalize.js`: `textViews`; `./chat-filter/settings.js`: `SETTING_DEFS, DEFAULTS, compileSettings, literalLines`, type `ChatSettings`; `./chat-filter/sender-state.js`: `SenderState`; `./chat-filter/rules.js`: type `Decision` |
| `client/plugins/chat-filter/engine.ts` | 34 | `./normalize.js`: `inferFilterChannel, textViews`; `./rules.js`: `advertisingRule, allow, block, contentDecision`, type `Decision`; `./settings.js`: type `CompiledSettings`; `./sender-state.js`: `SenderState` |
| `client/plugins/chat-filter/normalize.ts` | 53 | None |
| `client/plugins/chat-filter/rules.ts` | 60 | `./normalize.js`: `advertisingText, containsPhrase`; `./settings.js`: type `CompiledSettings` |
| `client/plugins/chat-filter/sender-state.ts` | 72 | `node:crypto`: `createHash` |
| `client/plugins/chat-filter/settings.ts` | 132 | `../../src/plugins/PluginContext.js`: type `SettingDef`; `./normalize.js`: `readableText` |

Sources: [CF:1-6](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter.ts#L1-L6), [Engine:1-4](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/engine.ts#L1-L4), [Normalize:1-53](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/normalize.ts#L1-L53), [Rules:1-2](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/rules.ts#L1-L2), [State:1-8](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/sender-state.ts#L1-L8), [Settings:1-2](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/settings.ts#L1-L2).

### Host dependencies and lifecycle

Only the entry uses host APIs. Helpers use JavaScript, SHA-256 and monotonic `performance.now()`. Signatures/behavior:

- Mutable `name: string`, `category: PluginCategory`, and readable/writable `enabled: boolean`. Registration sets `Chat Filter`/`utility`. Context defaults enabled; its setter calls enabled callbacks even when reassigning the same value. [Context:194-228](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L194-L228)
- `registerSetting(key: string, config: Omit<SettingDef, 'key'>, onChange?: (value: any) => void): void`: stores schema/default and callback; does **not** invoke callback initially. `getSetting<T = any>(key: string): T` returns stored value, possibly undefined. `updateSetting(key: string, value: any): boolean` rejects invalid/unknown values, otherwise stores and invokes callbacks even for identical values. Buttons invoke callback with `true` without storing. [Context:234-268](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L234-L268) [Context:503-537](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L503-L537)
- `setData(key: string, value: any): void` stores runtime data. `broadcastData(type: string, data: any): void` calls `onBroadcastData(pluginId, type, data)` for dashboard WebSockets; neither persists it. There is no `ctx.publish`; `publish()` is plugin-local. [Context:560-577](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L560-L577)
- `hookPacket(packetName: string, handler: (client: ClientConnection, packet: Packet) => void, options?: { prepend?: boolean }): void`: enabled-gated, plugin-owned registration. `{prepend:true}` unshifts the handler; later prepends can precede it. Proxy runs every handler, including after a drop, catching individual exceptions. [Context:584-595](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L584-L595) [Proxy:217-233](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/Proxy.ts#L217-L233) [Proxy:337-349](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/Proxy.ts#L337-L349)
- `onEnabledChange(cb: (enabled: boolean) => void): void`; `on(event: 'clientConnected' | 'clientDisconnected', handler: (client: ClientConnection) => void): void`. Events are enabled-gated; listener removal is automatically registered. [Context:210-212](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L210-L212) [Context:616-622](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L616-L622)
- `registerCleanup(fn: () => void): void`: `runCleanup(): void` invokes callbacks, swallowing exceptions. Manager separately unregisters packet/command hooks on unload. [Context:659-666](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L659-L666) [Manager:567-583](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginManager.ts#L567-L583)

Client usage is strictly `client.clientId` and `client.playerData?.name`; **no ClientConnection methods or direct proxy calls**. Packet usage: `isDefined`, `data`, `name`, and setting `send=false`; never `modified=true`. Native `setTimeout(publish,250)` coalesces blocks; `clearTimeout(pending)` cancels publication. Countdowns refresh on publication/button. Configuration changes recompile **all** settings, clear sessions/counters/recent/preview/actionResult, then publish. Parent toggles also reset; disconnect removes only that client's state; cleanup cancels the timer and clears sessions. [CF:8-45](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter.ts#L8-L45) [CF:77-96](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter.ts#L77-L96)

### TEXT semantics and state

Reads only `name`, `numStars`, `recipient`, `text`, `cleanText`. **Does not read `objectId`, `bubbleTime`, `isSupporter`, or `starBg`.** Self identity comes exclusively from `client.playerData?.name ?? ''`, not TEXT object identity. [CF:80-90](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter.ts#L80-L90) [Engine:6-34](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/engine.ts#L6-L34)

Evaluation order: disabled -> invalid non-string sender -> exempt -> explicit block -> allow/bypass (also forget history) -> channel exclusion -> existing mute -> custom words -> advertising -> trade -> repetition. Exempt means trimmed, case-insensitive self; sender `''`, `*`, `#`, `[server]`; or finite numeric negative `numStars`. System/NPC are thus heuristic exemptions, **not channel enum values**. Explicit block wins over allow and channel exclusion, but never over self/system exemptions. [Engine:6-33](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/engine.ts#L6-L33)

Channel inference: trimmed case-insensitive recipient equal to nonempty self means incoming whisper; `*guild*`/`*party*` identify those channels. Any string recipient otherwise means public if empty, unknown if nonempty. Only absent/non-string recipient permits normalized-text prefixes `Guild>`, `Party>`, `tell>`, `[tell]`. Player-authored prefixes cannot bypass filtering when recipient is `''`. [Normalize:38-53](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/normalize.ts#L38-L53)

Both nonempty text fields are normalized and deduplicated: NFKC, invisible-character removal, supported formatting/single-alphanumeric-tag removal, lowercase/whitespace folding. Advertising adds limited homoglyph/`rea!mshop` folding; literal words retain punctuation and support Unicode whole-word boundaries. Rules retain the campaign signatures and evidence, including Famazon, Realmshop banners, RP6/RPG6, obfuscated retail links, known-shop/payment combinations, commercial links, and optional trade phrases. [Normalize:1-35](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/normalize.ts#L1-L35) [Rules:8-60](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/rules.ts#L8-L60)

State is per connection, capped at 1,000 senders, ten SHA-256 fingerprints/sender, twenty timestamps/fingerprint; oldest insertions are evicted. Repetition defaults to third match within 20 seconds. Two independent advertising offenses within 60 seconds produce a fixed mute when enabled; custom-word precedence cannot hide advertising evidence. Muted messages do not extend expiry. Fingerprint retention is 120 seconds; messages themselves are not retained in history. [State:6-65](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/sender-state.ts#L6-L65) [Engine:24-32](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/engine.ts#L24-L32)

### Exact setting schema and definitions

Full `SettingDef`/option declarations, including fields unused here: [Context:28-77](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L28-L77)

```ts
export interface SettingOption {
  label: string;
  value: string;
}

export interface SettingDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'range' | 'select' | 'text' | 'button';
  value: any;
  /** Textarea presentation and bounded input; server validation remains authoritative. */
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  help?: string;
  /** Runtime-only input (e.g. message preview); excluded from saved profiles. */
  transient?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: SettingOption[];
  /** If set, this setting is rendered only when another setting has the requested value. */
  visibleWhen?: { key: string; value: any };
  /** If true, the setting is not rendered in the dashboard UI (value can still be set via updateSetting). */
  hidden?: boolean;
  /** If true, the setting is only shown when the plugin's "Advanced settings"
   *  toggle is on. Default (simple) mode hides it. Use for deep tuning knobs
   *  most users never touch, to keep the panel uncluttered. */
  advanced?: boolean;
  /**
   * Show a red warning on this setting (label turns red + an inline alert, plus a
   * ⚠ icon on the plugin's enable/disable row) when another setting's value
   * conflicts with this one. Generic: any plugin can declare this; the dashboard
   * evaluates it from live plugin data, so it stays reactive to changes in either
   * setting without the plugin pushing updates. Numeric comparison only
   * (booleans coerce to 0/1).
   */
  warnWhen?: {
    /** Plugin id to read the compared setting from. Defaults to this plugin,
     *  so a plugin can compare two of its own settings. */
    pluginId?: string;
    /** The compared setting's key (e.g. `'threshold'`). */
    key: string;
    /** Warn when `other <cmp> this`, where `other` is the compared value and
     *  `this` is this setting's value. */
    cmp: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
    /** Warning text shown in red. */
    message: string;
  };
}
```

Exact defaults/labels/builder defining **every SettingDef**: [Settings:4-69](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/settings.ts#L4-L69)

```ts
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
const lists = new Set(['blockedWords', 'allowedSenders', 'blockedSenders', 'whitelist', 'blacklist']);
export const SETTING_DEFS: SettingDef[] = (Object.keys(DEFAULTS) as ChatSettingKey[]).map(key => ({
  key, label: labels[key], value: DEFAULTS[key],
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
```

26 value settings plus six buttons. Exact button definitions/handlers: [CF:46-75](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter.ts#L46-L75)

```ts
  ctx.registerSetting('testMessage', { label: 'Test message rules (does not change sender history)', type: 'button', value: undefined }, () => {
    const channel = ctx.getSetting<string>('previewChannel');
    const self = '__preview_self__';
    const data = {
      name: ctx.getSetting<string>('previewSender'), text: ctx.getSetting<string>('previewMessage'), numStars: 20,
      recipient: channel === 'whisper' ? self : channel === 'guild' ? '*guild*' : channel === 'party' ? '*party*' : channel === 'unknown' ? '*unknown*' : '',
    };
    preview = { ...evaluate(data, self, { ...settings, enabled: settings.enabled && ctx.enabled }, new SenderState()), normalized: textViews(data) };
    publish();
  });
  ctx.registerSetting('refreshStatus', { label: 'Refresh filter status / mute countdowns', type: 'button', value: undefined }, publish);
  ctx.registerSetting('clearMutes', { label: 'Clear all temporary mutes and history', type: 'button', value: undefined }, reset);
  ctx.registerSetting('unmuteSender', { label: 'Unmute selected sender on all local connections', type: 'button', value: undefined }, () => {
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
  ctx.registerSetting('blockSender', { label: 'Always block selected sender', type: 'button', value: undefined }, () => manageSender(false));
  ctx.registerSetting('allowSender', { label: 'Bypass filtering for selected sender', type: 'button', value: undefined }, () => manageSender(true));
```

Preview uses fresh state; block/allow actions preserve legacy-block precedence.

### Validation, migration, publication

`validateChatSetting(key:string,value:unknown):unknown` throws for unknown keys; booleans are strict, numbers finite integers within schema bounds (schemaVersion exactly 1), strings strict; selects require listed options. Sender inputs reject newlines. Lists allow <=100,500 characters, <=500 raw lines, <=200 characters/line. Literal lists lowercase/trim/deduplicate without comments; legacy lists support comment lines/trailing whitespace-`#` comments, substring matching, or `/regex/flags` with flags `dgimsuy`; invalid expressions throw and `lastIndex` resets per match. [Settings:71-109](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/settings.ts#L71-L109)

`normalizeChatProfile(settings:unknown,present:boolean):ChatSettings` validates object shape, starts from defaults, and sets trade true only for an existing unversioned entry (explicit trade overrides). It copies only known non-transient keys; unknown/button keys are ignored. Missing plugin resets fresh defaults. `compileSettings` creates normalized words, exact-name Sets, and legacy matchers; it is **not** a substitute for validation. [Settings:111-132](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/settings.ts#L111-L132)

Host dependencies must move: Context imports these functions and branches on plugin ID for strict updates and `prepareChatFilterProfile`. Preparation validates all values/parent enabled before returning an apply closure; apply replays settings and reassigns parent enabled, clearing history even for identical profiles. Manager delegates; Config rejects duplicates and prepares before mutations, then skips generic Chat Filter replay. This is prevalidation, not a rollback transaction for arbitrary failing Chat Filter callbacks. [Context:488-537](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L488-L537) [Manager:299-304](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginManager.ts#L299-L304) [Config:173-255](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/dashboard/server/PluginConfigService.ts#L173-L255)

`setData('status',status)` and `broadcastData('chatFilterStatus',status)` publish:

```ts
{
  counts: Record<string, number>,
  recent: Array<{sender: string; reason: string; ruleId?: string; message?: string}>,
  preview: null | {action: 'allow'|'block'; reason: string; ruleId?: string;
                   evidence: string[]; normalized: string[]},
  actionResult: string,
  conflicts: string[],
  mutes: Array<{clientId: string; sender: string; remainingSeconds: number}>
}
```

Counts aggregate block reasons; recent keeps last 100 blocks; opt-in message bodies use `text || cleanText || ''`, truncated to 2,000 characters. Conflicts list exact allowed names also blocked explicitly/by legacy pattern. [CF:13-40](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter.ts#L13-L40) [CF:85-93](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter.ts#L85-L93) [Rules:4-6](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/chat-filter/rules.ts#L4-L6)

## 2. Tests and portability

Static `it.each` counts; two direct suites, three incidental references:

| File | Cases | Relevance / portability |
|---|---:|---|
| `client/src/plugins/__tests__/chatFilter.test.ts` | **62** | 16 declarations: 16 spam, 18 ordinary-chat, 10 invalid-setting, six reset-path cases, 12 standalone. Covers normalization, scope/exemptions, block precedence, repetition, mute expiry/isolation, preview/privacy, migration/prevalidation and bounded state. Assertions/case data portable verbatim with compatible adapters. |
| `client/src/proxy/__tests__/chatVisibility.test.ts` | **1** | Final-visible-chat ordering versus raw observers and SDK filters. Requires SDK/bridge; adapt integration harness. |
| `client/src/dashboard/server/__tests__/packetCaptureDemand.test.ts` | 11 total; **1 relevant** | Lightweight `chatFilterStatus` WS forwarding while capture is SUMMARY. Host-specific. |
| `client/src/status/__tests__/AutoNexusDevServer.test.ts` | 5 total; **1 relevant** | Chat status remains broadcast while plugin-published safety data is suppressed. Host-specific. |
| `client/src/plugins/__tests__/antiAfk.test.ts` | 47 total; **1 incidental** | Chat Filter is an unrelated profile-entry sentinel; does not test filtering. |

Direct suite imports outside the plugin folder: `node:events`/`EventEmitter`; Vitest `afterEach,describe,expect,it,vi`; `PluginContext`, `PluginConfigService`; types `PluginManager,Proxy,ClientConnection`; `createPacket`/type `Packet`. Mocks: Logger methods; EventEmitter proxy capturing the TEXT hook; two client identities; `performance.now` spy/advance; manager delegation; config-service callbacks; cleanup and explicit status refresh. The 62 cases can preserve test bodies, but whole-file verbatim portability requires matching old constructors/import paths/profile-service facade; normal RealmTool `.ts` imports and new profile storage require harness edits. [ChatTests:1-65](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/__tests__/chatFilter.test.ts#L1-L65) [ChatTests:68-271](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/__tests__/chatFilter.test.ts#L68-L271)

Visibility imports Vitest, SDK `chat`, Proxy, PacketFactory, createPacket, ClientConnection type, bridge `install`/`BridgeDeps`, Context, and register; loads packet/stat JSON, spies observers and unsubscribes/cleans up. [VisibilityTests:1-55](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/__tests__/chatVisibility.test.ts#L1-L55)

Capture imports EventEmitter/Vitest, DevServer, PacketInspector, PacketLab/TradeSession types, createPacket, PacketFactory/generated definitions, and Manager/Proxy/ClientConnection types. Status imports EventEmitter/Vitest, DevServer, PacketInspector/Manager/Proxy/ClientConnection types, AutoNexusStatusOwner/AutoNexusDisplay, and `NOW,snapshot` fixtures. Both mock HTTP/WS, filesystem/config paths, account/launcher/config/wiki/updater services, tuning/watchdog/trim and Logger; fake sockets collect JSON and managers collect broadcast callbacks. Adapt assertions to RealmTool broadcaster tests. [CaptureTests:1-84](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/dashboard/server/__tests__/packetCaptureDemand.test.ts#L1-L84) [CaptureTests:235-247](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/dashboard/server/__tests__/packetCaptureDemand.test.ts#L235-L247) [StatusTests:1-74](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/status/__tests__/AutoNexusDevServer.test.ts#L1-L74) [StatusTests:129-135](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/status/__tests__/AutoNexusDevServer.test.ts#L129-L135)

The Anti-AFK sentinel test additionally depends on its plugin, DllFeatureBus/InternalBridge/contract, config migration/service, packet/connection/context classes and manager/proxy types; its DLL fixture is outside Phase 2. [AfkTests:1-12](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/__tests__/antiAfk.test.ts#L1-L12) [AfkTests:429-437](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/__tests__/antiAfk.test.ts#L429-L437)

## 3. Commands and notifications

Proxy registers lowercase command keys, stripping one optional slash. Defined PLAYERTEXT interception uses exactly:

```ts
const text = typeof packet.data.text === 'string' ? packet.data.text : '';
const parts = text.startsWith('/') ? text.slice(1).trimEnd().toLowerCase().split(/\s+/) : [];
const command = parts[0];
const args = parts.slice(1);
```

Thus **arguments also lowercase**, whitespace separates without quote handling, trailing whitespace disappears; leading whitespace before slash or directly after slash prevents matching. All matching handlers run; any result other than false (including void) consumes with `packet.send=false`; exceptions log and do not themselves consume. Unknown/disabled-only commands pass through. Client observers/packet hooks still run afterward. Context wraps its void handler to return true when enabled, false otherwise. [Proxy:237-252](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/Proxy.ts#L237-L252) [Proxy:295-327](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/Proxy.ts#L295-L327) [Context:607-613](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L607-L613)

`sendNotification(client:ClientConnection,sender:string,message:string):void` creates TEXT and calls `client.sendToClient(packet)` with exactly:

```ts
{ name: sender, objectId: -1, numStars: -1, bubbleTime: 0,
  recipient: '', text: message, cleanText: message,
  isSupporter: false, starBg: 0 }
```

ServerSwitchService duplicates this with sender `Server Switch`; `/goto` uses `IP Connect`. `createPacket(name:string):Packet` delegates to factory `createByName`; `sendToClient(packet:Packet):void` serializes and injects toward the game, without running ordinary inbound hooks. [Context:625-644](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/plugins/PluginContext.ts#L625-L644) [Switch:203-208](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L203-L208) [Connection:218-225](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/ClientConnection.ts#L218-L225) [Connection:345-360](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/ClientConnection.ts#L345-L360)

## 4. Server Switch / IP connect

`CoreCommands.attachCoreCommands` constructs one shared service, reading `servers.json` unless baked data supplied. `/con` and `/ip` are core-owned, available independently of plugin enabled state. `server-switch.ts` is only a dashboard select adapter, not the command implementation. It refreshes options from the shared directory. [Commands:8-25](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/core/CoreCommands.ts#L8-L25) [SwitchPlugin:1-17](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/server-switch.ts#L1-L17)

Fetcher's only endpoint is `https://www.realmofthemadgod.com/account/servers`; **GET, no body**, query encoded by `URLSearchParams`:

```ts
{ accessToken, game_net: 'Unity', play_platform: 'Unity', game_net_user_id: '' }
```

Headers exactly `User-Agent: UnityPlayer/2021.3.31f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)` and `X-Unity-Version: 2021.3.31f1`; timeout 15,000 ms. Non-OK throws `Server list API returned ${res.status}`. Response is XML: regex `<Server>...</Server>` blocks, `<Name>...</Name>` and `<DNS>...</DNS>` captures; skip blocks containing `<AdminOnly/>` or `<AdminOnly>`. No XML entity decoding, trimming, alternate attribute syntax or DNS resolution. Service subsequently accepts only names matching `/^[a-z][a-z\d]{0,63}$/i` and IPv4 values. [Fetcher:1-52](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerListFetcher.ts#L1-L52) [Switch:20-24](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L20-L24)

Token comes from parsed HELLO `packet.data.accessToken`, stored if truthy as `client.state.accessToken`; connection event triggers refresh. Refresh deduplicates in-flight requests; success replaces in-memory directory and delays next refresh 15 minutes; failure retains directory and delays 60 seconds. Retry happens on a later connection, not a timer; no disk cache write. Service itself retains no token field (connection State does). [Reconnect:95-99](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/ReconnectHandler.ts#L95-L99) [Switch:37-47](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L37-L47) [Switch:80-98](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L80-L98)

`servers.json` is a flat canonical-name-to-IPv4 object, 18 entries, no ports/metadata. Names: EUEast, EUSouthWest, EUNorth, EUWest, EUWest2, USEast, USEast2, USWest, USWest3, USWest4, USMidWest, USMidWest2, USSouth, USSouth3, USSouthWest, USNorthWest, Asia, Australia. Pinned fallback data; availability unverified. [Servers:1-20](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/data/servers.json#L1-L20)

Resolution rejects empty/whitespace queries; accepts IPv4; then case-insensitive exact name, uppercase-letter/digit abbreviation, finally unique case-insensitive prefix. `USWest -> usw`, `USEast2 -> use2`; ambiguous matches fail, never select arbitrarily. [Switch:100-111](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L100-L111)

Engine `/con` sets state destination/2050, clears real key, records `{name,address,sourceGuid}`; injected RECONNECT is:

```ts
{ name: target.name, host: '127.0.0.1', port: GAME_PORT,
  gameId: GameId.Nexus, keyTime: -1,
  key: Buffer.from(client.state.guid, 'utf8') }
```

`GAME_PORT=2050`, Nexus `-2`, `modified=true`. Named destinations first attempt DLL PlayerPrefs synchronization; guard asynchronous replies against closed/replaced route, warn if unavailable, then reconnect. This DLL branch must not be ported into routing-only RealmTool. [Switch:113-158](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L113-L158) [GameId:1-17](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/constants/GameId.ts#L1-L17)

`ip-connect.ts` owns `/goto`: zero args shows usage; otherwise only args[0] matters. Colon splitting takes first two components; `parseInt` accepts suffix garbage, IPv4 regex checks shape but not octet bounds. Command always uses gameId `-2`, port default 2050. It sets state target IP/custom port and empty real key; injects the following, with `modified=true`:

```ts
    reconnect.data = {
      name: `${ip}:${port}`,
      host: '127.0.0.1',
      port: 2050,
      gameId,
      keyTime: -1,
      key: Buffer.from(client.state.guid, 'utf8'),
    };
```
 Dashboard-only persisted inputs are `ip`, `port`, `gameId`; connect is a button. [IPPlugin:19-108](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/ip-connect.ts#L19-L108) [IPPlugin:112-138](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/ip-connect.ts#L112-L138)

Exact in-game message templates:

- `/con` wrong arity: `Use /con <name, abbreviation, or IPv4>, e.g. /con USEast or /con USE. Servers: ${names || '(none loaded)'}`.
- `Use a server name, abbreviation, or IPv4 address.`; `Ambiguous server: ${matches.join(', ')}. Use the full name.`; `Unknown server or invalid IPv4 address. Use /con to list servers.`
- `A server switch is already being prepared.`; `Connecting directly; Exalt may show the previous server name because its display could not be synchronized.`; `Connecting directly to ${target.name}...`.
- `/ip`: `No established server connection.` or `${name}: ${address}${request ? '; requested '+request.name : ''}`.
- `/goto`: `Usage: /goto {ip} or /goto {ip}:{port}`; `Invalid port: ${parts[1]}`; `Invalid IP: ${ip}`; `Connecting to ${ip}:${port}...`.

Sources: [Commands:17-23](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/core/CoreCommands.ts#L17-L23), [Switch:100-148](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L100-L148), [Switch:196-208](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L196-L208), [IPPlugin:79-119](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/ip-connect.ts#L79-L119). No command cooldown; named-sync preparation guard only. Separate external-link queue expires after five minutes and settles one second after MAPINFO; exclude it from chat-only scope. Arrival/queue/failure diagnostics are logs, not confirmation of successful admission. [Switch:49-70](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L49-L70) [Switch:162-194](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/services/ServerSwitchService.ts#L162-L194)

## 5. Local player identity

`ClientConnection.playerData` begins with name `''`, ownerObjectId `0`; `client.objectId` exposes ownerObjectId. CREATESUCCESS replaces PlayerData, preserving map metadata, then assigns `packet.data.objectId`. UPDATE examines `newObjs[].status`; NEWTICK examines `statuses[]`; only matching objectId reaches `parseStatus(status.data)`. That loops `{id,value,stackCount}` and `NameStat=31` assigns name.  [Player:22-25](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/state/PlayerData.ts#L22-L25) [Connection:100-104](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/proxy/ClientConnection.ts#L100-L104) [Identity:84-96](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/state/StateManager.ts#L84-L96) [Identity:116-164](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/state/StateManager.ts#L116-L164) [Player:208-223](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/state/PlayerData.ts#L208-L223) [Player:285-289](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/state/PlayerData.ts#L285-L289) [Stat:35-35](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/constants/StatType.ts#L35-L35)

RealmTool needs only this small identity projection. Reset name on CREATESUCCESS/new connection, consume stat 31 only for the local object, process identity before later TEXT hooks. Until name arrives, self/recipient matching is unavailable; preserve this limit rather than guessing.

## 6. Profile/config persistence

Engine profile shape:

```ts
{ id: string, name: string, createdAt: number, updatedAt: number,
  plugins: Array<{ id: string, enabled: boolean, hotkey: string,
                   settings: Record<string, unknown> }> }
```

Stored under `Documents/Realmengine/configs/<id>.json`; active selection is `lastPluginConfigId`. Snapshots include every non-button/non-transient setting: Chat Filter persists all DEFAULTS except previewMessage/previewSender/previewChannel/selectedSender; both parent `enabled` and setting `enabled` persist. Status, history, message capture contents and mutes do not. Server Switch persists `server`; IP Connect persists `ip,port,gameId`. [Config:110-133](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/dashboard/server/PluginConfigService.ts#L110-L133) [DevServer:362-367](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/dashboard/server/DevServer.ts#L362-L367) [SwitchPlugin:10-15](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/server-switch.ts#L10-L15) [IPPlugin:38-77](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/plugins/ip-connect.ts#L38-L77)

Generic replay skips buttons but does **not** generally skip transient keys; Chat Filter's dedicated normalizer excludes saved transient inputs and resets them. Server select replay invokes its callback and can switch the active client; do not reproduce that in a command-only plugin. Autosave debounce is 800 ms for active default profile; writes use non-atomic `writeFileSync`. RealmTool instead specifies `{schemaVersion,plugins:{[id]:{enabled,settings}}}`, atomic writes, and plugin-owned migration/validation. [Config:143-170](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/dashboard/server/PluginConfigService.ts#L143-L170) [Config:219-255](https://github.com/DaAwesomePwner/realm-engine-client/blob/88a66b2155cddfe9c1bd086e58d408941dcef697/client/src/dashboard/server/PluginConfigService.ts#L219-L255) [RTDesign:92-116](../../docs/design.md#L92-L116)

## 7. Recommended minimal port

**Judgment call:** retain compatibility method names to minimize Chat Filter edits, while implementing generic host policies. Proposed interfaces use RealmTool's existing Packet and the complete SettingDef above:

```ts
interface ClientConnection {
  readonly clientId: string;
  readonly connected: boolean;
  playerData: { name: string; ownerObjectId: number };
  sendToClient(packet: Packet): void;
}
interface PluginContext {
  name: string;
  category: string;
  enabled: boolean;
  registerSetting(key: string, def: Omit<SettingDef, 'key'>,
                  onChange?: (value: any) => void): void;
  getSetting<T = any>(key: string): T;
  updateSetting(key: string, value: any): boolean;
  hookPacket(name: string, fn: (c: ClientConnection, p: Packet) => void,
             options?: { prepend?: boolean }): void;
  hookCommand(name: string,
              fn: (c: ClientConnection, command: string, args: string[]) => void): void;
  on(event: 'clientConnected'|'clientDisconnected',
     fn: (c: ClientConnection) => void): void;
  onEnabledChange(fn: (enabled: boolean) => void): void;
  registerCleanup(fn: () => void): void;
  setData(key: string, value: any): void;
  broadcastData(type: string, data: any): void;
  createPacket(name: string): Packet;
  sendNotification(c: ClientConnection, sender: string, text: string): void;
}
interface PluginDefinition {
  register(ctx: PluginContext): void;
  settings?: {
    validate(key: string, value: unknown): unknown;
    migrate(saved: unknown, present: boolean): Record<string, unknown>;
  };
}
```

Generic host validates parent enabled/duplicate IDs and stages complete profiles before apply; invokes non-transient callbacks and enabled callbacks even for identical reloads; excludes buttons/transients on save/replay. Register `validateChatSetting`/`normalizeChatProfile` through `settings.validate/migrate`, removing plugin-ID branches. Test facade may expose `getSettings/getData/resetSettingsToDefaults` and old preparation methods.

Exact file changes:

| Source -> destination | Required edits |
|---|---|
| `chat-filter.ts` -> `plugins/chat-filter/index.ts` | Change API import to shared adapter; helper imports become `./engine.ts`, `./normalize.ts`, `./settings.ts`, `./sender-state.ts`, `./rules.ts`. Keep register body. Add default `definePlugin({register,settings:{validate:validateChatSetting,migrate:normalizeChatProfile}})` export/imports. |
| `engine.ts` | Change four import specifiers to `.ts`; otherwise unchanged. |
| `normalize.ts` | No behavior changes. |
| `rules.ts` | Change two import specifiers to `.ts`; otherwise unchanged. |
| `settings.ts` | Import shared SettingDef; normalize import to `.ts`; export existing migrate/validate through definition. Keep defaults/rules exactly. |
| `sender-state.ts` | Replace constructor parameter properties with explicit readonly `now`/`limit` fields and constructor assignments; same defaults, state behavior and node:crypto import. |

Add provenance headers to all six and a manifest (`id:chat-filter`, apiVersion 1, main index.ts, worker null, packets capability). **Judgment call:** advertise only used capabilities; commands/notifications are needed by Server Switch. Preserve 62-case behavior; add host tests for verdict mapping, identity lifecycle, command consumption, cleanup, and reconnect serialization.

Transport mapping: verdict interests server TEXT/client PLAYERTEXT; observe interests server CREATESUCCESS/UPDATE/NEWTICK. Union plugin subscriptions; preserve prepends and enabled gates. Decode `createFromBytes(event.data,event.fromClient?'client':'server')`; for verdict packets call `forward(id,sequence,generation,null)` on drop, otherwise original bytes unless modified, then serialize. Never verdict an observation. Inject via `inject(clientId,serialize(packet),true)`. Keep stable client facades and discard them on closed events. [RTHost:9-29](../../src/transport/host.ts#L9-L29) [RTHost:97-109](../../src/transport/host.ts#L97-L109) [RTInterest:35-39](../../src/transport/interest.ts#L35-L39) [RTFactory:139-227](../../src/protocol/PacketFactory.ts#L139-L227)

**Critical Phase 1 gap:** initial HELLO returns through `routeHello` before interest dispatch or module observe; declaring HELLO observe will **not** expose the token. RouteHello currently posts only destination/restored. Add an explicit scoped, nonblocking token handoff from successful HELLO routing (or a dedicated worker fetch service); never persist/log it. Choice of handoff is a **judgment call**, but some transport addition is required for authenticated list refresh. [RTSession:225-275](../../src/transport/session.ts#L225-L275)

For command-only Server Switch, port fetch/validation/matching/cache behavior; omit dropdown, DLL sync, external-link queue and persistent destination inputs. **Judgment calls:** strict `isIPv4`, full decimal port validation 1-65535, exactly one `/goto` argument, and lowercase parsing compatibility. Inject real `{name,host:targetIp,port:targetPort,gameId:-2,keyTime:-1,key:Buffer.alloc(0)}`. **Never copy Engine's loopback/GUID injection:** RealmTool's final writer rewrites RECONNECT and stores real route/key itself; copying it would route back to the proxy. `/ip` is researched for parity but not required by Phase 2 scope. [RTSession:397-405](../../src/transport/session.ts#L397-L405) [RTRouter:79-108](../../src/routing/router.ts#L79-L108)
