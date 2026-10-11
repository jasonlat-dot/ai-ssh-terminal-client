import type { TerminalSession } from '../types';
import type { TerminalRuntime } from './terminalRuntime';
import { isSessionConnected } from './terminalSessions';

export type TerminalCommandMode = 'single' | 'all' | 'selected';
export type TerminalCommandTarget = { id: string; title: string; runtime: TerminalRuntime };
export type TerminalCommandResult = { id: string; title: string; status: 'submitted' | 'failed' | 'skipped'; detail?: string };

export function canSubmitTerminalCommand(session: TerminalSession, runtime?: TerminalRuntime) {
  return isSessionConnected(session) && !session.busy && !!runtime
    && runtime.sessionId === session.terminalSessionId && !runtime.closed && !runtime.disconnected
    && !runtime.manuallyClosed && runtime.transportAvailable !== false;
}

/** Explicit targets only. An empty selection never falls back to all/current terminals. */
export function resolveTerminalCommandTargets(sessions: readonly TerminalSession[], clients: ReadonlyMap<string, TerminalRuntime>,
  mode: TerminalCommandMode, activeId: string, selectedIds: readonly string[]) {
  const wanted = new Set(mode === 'single' ? [activeId] : mode === 'selected' ? selectedIds : sessions.map(session => session.id));
  const targets: TerminalCommandTarget[] = [], skipped: TerminalCommandResult[] = [];
  for (const session of sessions) {
    if (!wanted.delete(session.id)) continue;
    const runtime = clients.get(session.id);
    if (canSubmitTerminalCommand(session, runtime)) targets.push({ id: session.id, title: session.title, runtime: runtime! });
    else skipped.push({ id: session.id, title: session.title, status: 'skipped', detail: session.busy ? '正在提交命令' : '连接不可用' });
  }
  return { targets, skipped };
}

/** Only called by human command controls; Agent and xterm's raw input never enter this path.
 * Capture runtime identities before sending, lock each target, and never retry a partial batch.
 */
export async function submitTerminalCommandBatch(targets: readonly TerminalCommandTarget[], command: string,
  locks: Map<string, TerminalRuntime>, isCurrent: (target: TerminalCommandTarget) => boolean,
  onBusy: (target: TerminalCommandTarget, busy: boolean) => void): Promise<TerminalCommandResult[]> {
  if (!command.trim()) return [];
  // Claim every target synchronously before any await; duplicate IDs cannot submit twice.
  const claimed = new Set<string>();
  const jobs = targets.map(target => {
    if (claimed.has(target.id) || locks.has(target.id) || !isCurrent(target)) return { target, acquired: false };
    claimed.add(target.id); locks.set(target.id, target.runtime); onBusy(target, true);
    return { target, acquired: true };
  });
  return Promise.all(jobs.map(async ({ target, acquired }): Promise<TerminalCommandResult> => {
    if (!acquired) return { id: target.id, title: target.title, status: 'skipped', detail: '会话已变化或正在提交命令' };
    try {
      if (!isCurrent(target)) return { id: target.id, title: target.title, status: 'skipped', detail: '会话已变化' };
      await target.runtime.exec(command);
      return { id: target.id, title: target.title, status: 'submitted' };
    } catch (error) {
      return { id: target.id, title: target.title, status: 'failed', detail: error instanceof Error ? error.message : '命令提交失败' };
    } finally {
      // An old request completing after reconnect must not unlock the new runtime's request.
      if (locks.get(target.id) === target.runtime) { locks.delete(target.id); onBusy(target, false); }
    }
  }));
}
