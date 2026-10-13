import type { Host, TerminalDisconnectReason, TerminalSession } from '../types';
import { backendWorkspaceKey } from '../config/backend';

const storagePrefix = 'agent-ssh-terminal-sessions-v1:';

/** A remembered SSH connection is usable only while the backend can confirm it. */
export function isSessionConnected(session: TerminalSession | undefined) {
  return !!session?.connected && session.connectionStatus === 'connected' && !session.manuallyClosed;
}

type StoredTerminalSession = {
  id: string;
  connectionId: string;
  terminalSessionId: string;
  host: Host;
  title: string;
  disconnectReason: TerminalDisconnectReason | null;
};

export function terminalSessionsStorageKey(backendUrl: string) {
  return `${storagePrefix}${backendWorkspaceKey(backendUrl)}`;
}

export function loadTerminalSessions(backendUrl: string): TerminalSession[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(terminalSessionsStorageKey(backendUrl)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      const stored = item as Partial<StoredTerminalSession>;
      if (!stored.id || !stored.connectionId || !stored.host || !stored.title) return [];
      const terminalSessionId = typeof stored.terminalSessionId === 'string' ? stored.terminalSessionId : '';
      return [{
        id: stored.id,
        kind: 'ssh' as const,
        connectionId: stored.connectionId,
        terminalSessionId,
        connected: false,
        connectionStatus: 'disconnected' as const,
        disconnectReason: stored.disconnectReason ?? (terminalSessionId ? null : 'SESSION_NOT_FOUND'),
        reconnectAllowed: false,
        reconnectAttempts: 0,
        reconnecting: false,
        readLoopGeneration: 0,
        manuallyClosed: false,
        host: stored.host,
        title: stored.title,
        busy: false,
        fileState: { open: false, files: [], selected: '', expanded: new Set<string>() },
      }];
    });
  } catch {
    return [];
  }
}

export function saveTerminalSessions(backendUrl: string, sessions: TerminalSession[]) {
  const stored: StoredTerminalSession[] = sessions
    // 本地 ConPTY 随桌面进程退出，重启后无法恢复，因此只持久化 SSH 页签。
    .filter(session => session.kind === 'ssh' && !session.manuallyClosed)
    .map(session => ({
      id: session.id,
      connectionId: session.connectionId,
      terminalSessionId: session.terminalSessionId,
      host: session.host,
      title: session.title,
      disconnectReason: session.disconnectReason,
    }));
  localStorage.setItem(terminalSessionsStorageKey(backendUrl), JSON.stringify(stored));
}
