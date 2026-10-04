// Adapted from realm-engine-client client/src/state/PlayerData.ts @ 88a66b2 (MIT, see NOTICE).
// Stat IDs from client/src/constants/StatType.ts @ 88a66b2: use raw server maxima, never bonuses.
const MAX_HP = 0;
const HP = 1;

export class ServerPlayerState {
  ownerObjectId = 0;
  hp: number | null = null;
  maxHp: number | null = null;
  defense: number | null = null;
  effects = 0;
  effects2 = 0;
  conditionsKnown = false;
  position: { x: number; y: number } | null = null;

  /** Returns the explicit valid HP sample, if this owner status contains one. */
  applyStatus(status: { objectId?: unknown; data?: unknown; position?: { x?: unknown; y?: unknown } }, full = false): number | null {
    if (this.ownerObjectId === 0 || status.objectId !== this.ownerObjectId) return null;
    const incoming = Array.isArray(status.data) ? status.data : [];
    const masks = incoming.filter(s => s?.id === 29 || s?.id === 95);
    const validMasks = masks.every(s => Number.isInteger(s.value) && s.value >= -2147483648 && s.value <= 4294967295);
    // A full object status establishes omitted masks as zero; delta omission does not.
    if (full) { this.effects = 0; this.effects2 = 0; }
    if (validMasks) this.conditionsKnown ||= full || masks.length > 0;
    else this.conditionsKnown = false;
    const defense = incoming.find(s => s?.id === 21);
    if (defense) this.defense = Number.isInteger(defense.value) && defense.value >= 0 && defense.value <= 10000 ? defense.value : null;
    if (validMasks) for (const stat of masks) {
      if (stat.id === 29) this.effects = stat.value;
      else this.effects2 = stat.value;
    }
    const pos = status.position;
    if (pos && typeof pos.x === 'number' && Number.isFinite(pos.x) && typeof pos.y === 'number' && Number.isFinite(pos.y))
      this.position = { x: pos.x, y: pos.y };
    let sample: number | null = null;
    for (const stat of Array.isArray(status.data) ? status.data : []) {
      if (!stat || typeof stat.value !== 'number' || !Number.isFinite(stat.value)) continue;
      if (stat.id === MAX_HP && stat.value > 0) this.maxHp = stat.value;
      if (stat.id === HP && stat.value >= 0) this.hp = sample = stat.value;
    }
    return sample;
  }
}
