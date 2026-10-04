// Ported from realm-engine-client client/plugins/chat-filter/sender-state.ts @ 88a66b2 (MIT, see NOTICE).
import { createHash } from 'node:crypto';

type Sender = { name: string; fingerprints: Map<string, number[]>; offenses: number[]; muteUntil: number };

/** One instance per local connection. No timers and no cross-account reputation. */
export class SenderState {
  private senders = new Map<string, Sender>();
  private readonly now: () => number;
  private readonly limit: number;
  constructor(now: () => number = () => performance.now(), limit = 1000) {
    this.now = now;
    this.limit = limit;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, sender] of this.senders) {
      sender.offenses = sender.offenses.filter(t => now - t < 60_000);
      for (const [fp, times] of sender.fingerprints) {
        const fresh = times.filter(t => now - t < 120_000);
        if (fresh.length) sender.fingerprints.set(fp, fresh); else sender.fingerprints.delete(fp);
      }
      if (sender.muteUntil <= now && !sender.offenses.length && !sender.fingerprints.size) this.senders.delete(key);
    }
  }

  private get(name: string): Sender {
    this.prune();
    const key = name.trim().toLowerCase();
    let sender = this.senders.get(key);
    if (!sender) {
      if (this.senders.size >= this.limit) this.senders.delete(this.senders.keys().next().value!);
      sender = { name, fingerprints: new Map(), offenses: [], muteUntil: 0 };
      this.senders.set(key, sender);
    }
    return sender;
  }

  isMuted(name: string): boolean { return (this.senders.get(name.trim().toLowerCase())?.muteUntil ?? 0) > this.now(); }

  record(name: string, fingerprints: string[], advertising: boolean, options: { autoMute: boolean; muteMinutes: number; repeatWindowSeconds: number; repeatCount: number }): boolean {
    const sender = this.get(name);
    const now = this.now();
    let repeated = false;
    for (const text of new Set(fingerprints.filter(Boolean))) {
      // History retains fixed-size digests rather than message bodies.
      const fp = createHash('sha256').update(text).digest('hex');
      const times = (sender.fingerprints.get(fp) ?? []).filter(t => now - t < options.repeatWindowSeconds * 1000);
      times.push(now);
      if (times.length >= options.repeatCount) repeated = true;
      if (!sender.fingerprints.has(fp) && sender.fingerprints.size >= 10) sender.fingerprints.delete(sender.fingerprints.keys().next().value!);
      sender.fingerprints.set(fp, times.slice(-20));
    }
    if (advertising && options.autoMute) {
      sender.offenses.push(now);
      sender.offenses = sender.offenses.slice(-2);
      if (sender.offenses.length >= 2) {
        sender.muteUntil = now + options.muteMinutes * 60_000;
        sender.offenses = [];
      }
    }
    return repeated;
  }

  forget(name: string): void { this.senders.delete(name.trim().toLowerCase()); }
  clear(): void { this.senders.clear(); }
  mutes(): Array<{ sender: string; remainingSeconds: number }> {
    this.prune();
    return [...this.senders.values()].filter(s => s.muteUntil > this.now())
      .map(s => ({ sender: s.name, remainingSeconds: Math.ceil((s.muteUntil - this.now()) / 1000) }));
  }
  clone(): SenderState {
    const copy = new SenderState(this.now, this.limit);
    copy.senders = new Map([...this.senders].map(([key, s]) => [key, { ...s, offenses: [...s.offenses], fingerprints: new Map([...s.fingerprints].map(([fp, ts]) => [fp, [...ts]])) }]));
    return copy;
  }
}
