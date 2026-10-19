const seenVersionKey = 'shellpilot-release-notes-seen-v1';

/** Failure to read browser storage must not produce an unavoidable startup prompt. */
export function shouldShowReleaseNotes(version: string, storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem(seenVersionKey) !== version; } catch { return false; }
}

export function acknowledgeReleaseNotes(version: string, storage: Pick<Storage, 'setItem'>): void {
  try { storage.setItem(seenVersionKey, version); } catch { /* Still dismiss for this app session. */ }
}
