import type { SessionFileState, TerminalSession } from '../types';

// Use the originating session ID, including for delayed transfer updates.
// A closed session must never be recreated by a pending callback.
export function updateSessionFiles(
  sessions: TerminalSession[],
  sessionId: string,
  update: (state: SessionFileState) => SessionFileState,
): TerminalSession[] {
  return sessions.map(session => session.id === sessionId
    ? { ...session, fileState: update(session.fileState) }
    : session);
}
