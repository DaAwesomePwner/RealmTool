// Ported from realm-engine-client client/plugins/chat-filter/rules.ts @ 88a66b2 (MIT, see NOTICE).
import { advertisingText, containsPhrase } from './normalize.ts';
import type { CompiledSettings } from './settings.ts';

export type Decision = { action: 'allow' | 'block'; reason: string; ruleId?: string; evidence: string[] };
export const allow = (reason = 'no-match'): Decision => ({ action: 'allow', reason, evidence: [] });
export const block = (reason: string, evidence: string[] = [], ruleId?: string): Decision => ({ action: 'block', reason, evidence, ...(ruleId ? { ruleId } : {}) });

/** True when whole words spell `name` followed by the whole word `com` ("realm stock com", "realmstockcom"). */
function dotlessDomain(words: string[], name: string): boolean {
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && joined.length < name.length + 3; j++) {
      joined += words[j];
      if (joined === `${name}com` || (joined === name && words[j + 1] === 'com')) return true;
    }
  }
  return false;
}

export function advertisingRule(text: string): Decision | null {
  const scan = advertisingText(text);
  const compact = scan.replace(/[^a-z0-9]/g, '');
  const sales = /\b(?:in\s*stock|buy|sell|cheap|delivery|maxing|bulk|services?|sales?)\b/.test(scan);
  const price = /(?:[$€£]\s*\d|\d+(?:\.\d{1,2})?\s*(?:[$€£]|usd\b))/.test(scan);
  const invite = /(?:dsc|discord)\s*\.\s*gg\s*\/\s*famazon\b/.test(scan);
  if (invite) return block('advertising', ['campaign invite'], 'famazon');
  // Campaign signatures that identify the advertiser on their own.
  if (/={3,}\s*realmshop\s*info\b/.test(scan)) return block('advertising', ['campaign banner'], 'realmshop');
  if (/\brpg?6\s*(?:\.|[([{]\s*dot\s*[)\]}])\s*rip\b/.test(scan)) return block('advertising', ['campaign domain'], 'rp6');
  // A domain spelled with "(dot)" is filter evasion; with a price or sales language it is an ad.
  const hiddenLink = /\b[a-z0-9-]{2,}\s*[([{]\s*dot\s*[)\]}]\s*[a-z]{2,6}\b/.test(scan);
  // Bare retail-style prices (4.99, 12.49) count; versions and measurements (1.20) do not.
  if (hiddenLink && (sales || price || /\b\d{1,4}\.[49]9\b/.test(scan))) {
    return block('advertising', ['obfuscated link', ...(sales ? ['sales language'] : []), ...(price ? ['real-money price'] : [])], 'obfuscated-link');
  }
  const campaign = ['realmshop', 'realmstock', 'r2realm', 'r2wins', 'oryxshop', 'nexusmaxing'].find(s => compact.includes(s));
  // Payment methods are evidence only alongside a known shop, not generic sales language.
  const payment = /\b(?:paypal|venmo|cash\s*app|crypto)\b/.test(scan);
  if (campaign && (sales || price || payment || dotlessDomain(scan.split(/[^a-z0-9]+/).filter(Boolean), campaign)
    || /(?:https?:\/\/|hxxps?:\/\/|\.(?:com|net|info)\b)/.test(scan))) {
    return block('advertising', ['known shop', ...(sales ? ['sales language'] : []), ...(price ? ['real-money price'] : []),
      ...(payment ? ['payment method'] : [])], campaign);
  }
  const destination = /(?:https?:\/\/|hxxps?:\/\/|\b[a-z0-9-]*(?:shop|stock|coin)[a-z0-9-]*\s*(?:\.|\[dot\])\s*(?:com|net|info)\b)/.test(scan);
  if (destination && sales && price) return block('advertising', ['destination', 'sales language', 'real-money price'], 'commercial-link');
  return null;
}

export function contentDecision(views: string[], settings: CompiledSettings): Decision {
  if (settings.blockedWordsEnabled) {
    for (const word of settings.words) {
      if (views.some(text => containsPhrase(text, word, settings.wordMatch === 'whole'))) return block('custom-word', [word], word);
    }
  }
  if (settings.advertising) {
    for (const view of views) { const result = advertisingRule(view); if (result) return result; }
  }
  if (settings.trade && views.some(text => /\b(?:wtb|wts|wtt|wta)\b|\bbulk\s+keys\b/.test(text))) return block('trade');
  return allow();
}
