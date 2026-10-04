// Ported from realm-engine-client client/plugins/chat-filter/normalize.ts @ 88a66b2 (MIT, see NOTICE).
const INVISIBLE = /[\u200B-\u200F\uFEFF\u2060-\u2064\u00AD\u034F\u180E]/g;
// Spammers rotate bare single-character markers (<a>, <g>, <8>, ...) that the game hides.
const FORMATTING = /<\/?[a-z0-9]>|<sprite\b[^>]{0,200}>|<\/?(?:color|size)(?:=[^>]{0,100})?>/gi;

/** Keep ordinary punctuation and unknown angle-bracket text intact. */
export function readableText(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(FORMATTING, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Aggressive folding is restricted to advertising detection. */
export function advertisingText(text: string): string {
  const pairs: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i' };
  return readableText(text).replace(/[аеорсухі]/g, c => pairs[c]!)
    .replace(/rea[!1|]m\s*shop/g, 'realmshop');
}

export function textViews(data: Record<string, unknown>): string[] {
  return [...new Set([data.text, data.cleanText]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(readableText))];
}

export function containsPhrase(text: string, needle: string, whole: boolean): boolean {
  let at = text.indexOf(needle);
  if (!whole) return at !== -1;
  while (at !== -1) {
    const previous = text.charCodeAt(at - 1);
    const before = text.slice(Math.max(0, at - (previous >= 0xdc00 && previous <= 0xdfff ? 2 : 1)), at);
    const afterPoint = text.codePointAt(at + needle.length);
    const after = afterPoint === undefined ? '' : String.fromCodePoint(afterPoint);
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
    at = text.indexOf(needle, at + 1);
  }
  return false;
}

export type FilterChannel = 'public' | 'whisper' | 'guild' | 'party' | 'unknown';
export function inferFilterChannel(data: Record<string, unknown>, self: string): FilterChannel {
  const recipient = typeof data.recipient === 'string' ? data.recipient.trim().toLowerCase() : '';
  if (recipient && self && recipient === self.trim().toLowerCase()) return 'whisper';
  // The game uses recipient markers; prefixes cover bridge/script-formatted messages.
  if (recipient === '*guild*') return 'guild';
  if (recipient === '*party*') return 'party';
  // A real public TEXT has an empty recipient. Do not let player-authored
  // "Guild>" / "Party>" prefixes opt it out of filtering.
  if (typeof data.recipient === 'string') return recipient ? 'unknown' : 'public';
  const text = textViews(data)[0] ?? '';
  if (/^guild>/.test(text)) return 'guild';
  if (/^party>/.test(text)) return 'party';
  if (/^(?:tell>|\[tell\])/.test(text)) return 'whisper';
  return recipient ? 'unknown' : 'public';
}
