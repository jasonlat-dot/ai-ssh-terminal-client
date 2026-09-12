import { sshUserId } from '../api/ssh';
import type { Host } from '../types';

export type ConnectionHistory = { id: string; hostId: string; name: string; address: string; disconnectedAt: string };
const storageKey = `agent-ssh-disconnect-history-v1:${sshUserId}`;
export function loadConnectionHistory(): ConnectionHistory[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(value) ? value.filter((item): item is ConnectionHistory => item &&
      ['id', 'hostId', 'name', 'address', 'disconnectedAt'].every(key => typeof item[key] === 'string')).slice(0, 50) : [];
  } catch { return []; }
}
export function recordDisconnect(host: Host): ConnectionHistory[] {
  const next = [{ id: crypto.randomUUID(), hostId: host.id, name: host.name,
    address: `${host.address}:${host.port ?? 22}`, disconnectedAt: new Date().toISOString() }, ...loadConnectionHistory()].slice(0, 50);
  // Only metadata is persisted; terminal input, output and credentials are excluded.
  localStorage.setItem(storageKey, JSON.stringify(next));
  return next;
}
