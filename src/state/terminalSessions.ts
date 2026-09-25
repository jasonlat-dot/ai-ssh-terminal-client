import type { Host, TerminalDisconnectReason, TerminalSession } from '../types';

const storagePrefix = 'agent-ssh-terminal-sessions-v1:';

type StoredTerminalSession = {
  id: string;
  connectionId: string;
  terminalSessionId: string;
  host: Host;
  title: string;
  disconnectReason: TerminalDisconnectReason | null;
};

function storageKey(backendUrl: string) {
  return `${storagePrefix}${backendUrl}`;
}

export function loadTerminalSessions(backendUrl: string): TerminalSession[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(backendUrl)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      const stored = item as Partial<StoredTerminalSession>;
      if (!stored.id || !stored.connectionId || !stored.host || !stored.title) return [];
      const terminalSessionId = typeof stored.terminalSessionId === 'string' ? stored.terminalSessionId : '';
      return [{
        id: stored.id,
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
        fileState: { open: false, files: [], selected: '', expanded: new Set<string>(), transfers: [] },
      }];
    });
  } catch {
    return [];
  }
}

export function saveTerminalSessions(backendUrl: string, sessions: TerminalSession[]) {
  const stored: StoredTerminalSession[] = sessions
    .filter(session => !session.manuallyClosed)
    .map(session => ({
      id: session.id,
      connectionId: session.connectionId,
      terminalSessionId: session.terminalSessionId,
      host: session.host,
      title: session.title,
      disconnectReason: session.disconnectReason,
    }));
  localStorage.setItem(storageKey(backendUrl), JSON.stringify(stored));
}
