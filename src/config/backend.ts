/** Internal workspace identity only. This application has no configurable HTTP backend. */
export const BUILTIN_ENDPOINT = 'ipc://builtin';
let currentEndpoint = BUILTIN_ENDPOINT;

export function isBuiltinEndpoint(value: string): boolean {
  return /^ipc:\/\/builtin(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(value);
}
export function backendWorkspaceKey(value: string): string {
  if (!isBuiltinEndpoint(value)) throw new Error('工作区只能使用应用内部通信。');
  return BUILTIN_ENDPOINT;
}
export function readBackendUrl(): string { return currentEndpoint; }
export function requireBackendUrl(): string { return currentEndpoint; }

/** Copy the last local tab history; old remote profiles are never selected or contacted. */
function migrateLocalHistory(): void {
  try {
    const target = `agent-ssh-terminal-sessions-v1:${BUILTIN_ENDPOINT}`;
    if (localStorage.getItem(target) !== null) return;
    const previous = JSON.parse(localStorage.getItem('agent-ssh-backend-connections-v2') || '{}') as {
      profiles?: { id: string; kind: string; url: string }[];
    };
    const builtin = previous.profiles?.find(profile => profile.id === 'builtin' && profile.kind === 'builtin');
    if (!builtin) return;
    const saved = localStorage.getItem(`agent-ssh-terminal-sessions-v1:${builtin.url}`);
    if (saved && Array.isArray(JSON.parse(saved))) localStorage.setItem(target, saved);
  } catch { /* Damaged old settings must not prevent local workspace initialization. */ }
}
export function saveBackendUrl(raw: string): string {
  const identity = raw.trim();
  if (!isBuiltinEndpoint(identity)) throw new Error('不支持远程后端地址，请使用应用内工作区。');
  migrateLocalHistory();
  currentEndpoint = identity;
  return currentEndpoint;
}
export function adoptBundledBackendUrl(actual: string | null | undefined): string {
  return actual ? saveBackendUrl(actual) : currentEndpoint;
}
