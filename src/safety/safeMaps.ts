// Ported from realm-engine-client client/src/safety/SafetyTypes.ts @ 88a66b2 (MIT, see NOTICE).
export const SAFE_MAPS: ReadonlySet<string> = new Set([
  'Nexus', 'Vault', 'Guild Hall', 'Guild Hall 2', 'Guild Hall 3', 'Guild Hall 4', 'Guild Hall 5',
  'Cloth Bazaar', 'Nexus Explanation', 'Vault Explanation', 'Guild Explanation',
  'Daily Quest Room', 'Daily Login Room', 'Pet Yard', 'Pet Yard 2', 'Pet Yard 3', 'Pet Yard 4', 'Pet Yard 5',
].map(s => s.toLowerCase()));
