// Adapted from realm-engine-client client/src/state/PlayerData.ts @ 88a66b2 (MIT, see NOTICE).
// Stat IDs from client/src/constants/StatType.ts @ 88a66b2: use raw server maxima, never bonuses.
const MAX_HP = 0;
const HP = 1;

export class ServerPlayerState {
  ownerObjectId = 0;
  hp: number | null = null;
  maxHp: number | null = null;

  /** Returns the explicit valid HP sample, if this owner status contains one. */
  applyStatus(status: { objectId?: unknown; data?: unknown }): number | null {
    if (this.ownerObjectId === 0 || status.objectId !== this.ownerObjectId) return null;
    let sample: number | null = null;
    for (const stat of Array.isArray(status.data) ? status.data : []) {
      if (!stat || typeof stat.value !== 'number' || !Number.isFinite(stat.value)) continue;
      if (stat.id === MAX_HP && stat.value > 0) this.maxHp = stat.value;
      if (stat.id === HP && stat.value >= 0) this.hp = sample = stat.value;
    }
    return sample;
  }
}
