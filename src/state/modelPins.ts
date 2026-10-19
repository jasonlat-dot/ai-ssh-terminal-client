const storageKey = (userId: string) => `shellpilot-model-pins-v1:${userId}`;

/** Newest pin first; only stable channel IDs are stored, never model credentials. */
export function loadModelPins(userId: string, storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(storageKey(userId)) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128))].slice(0, 128) : [];
  } catch { return []; }
}

export function saveModelPins(userId: string, pins: string[], storage?: Pick<Storage, 'setItem'>): void {
  (storage ?? localStorage).setItem(storageKey(userId), JSON.stringify(pins));
}

/** Unpinned channels retain the repository's creation order; never mutate that source array. */
export function orderPinnedModels<T extends { id: string }>(profiles: T[], pins: string[]): T[] {
  const rank = new Map(pins.map((id, index) => [id, index]));
  return [...profiles].sort((a, b) => (rank.get(a.id) ?? pins.length) - (rank.get(b.id) ?? pins.length));
}
