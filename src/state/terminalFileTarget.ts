import type { TerminalRuntime } from './terminalRuntime';

export type TerminalFileTarget = { terminalSessionId: string; path: string; accessKey: string; revision: number };
/** Both file-manager entry points read the terminal, never a manually browsed sidebar path. */
export function terminalFileTarget(runtime: TerminalRuntime, revision: number): TerminalFileTarget {
  const snapshot = runtime.directorySnapshot?.();
  const path = snapshot?.path || '';
  return { terminalSessionId: runtime.sessionId,
    path: path.startsWith('/') && !/[\x00-\x1f\x7f-\x9f]/u.test(path) ? path : '',
    accessKey: snapshot?.accessKey || '', revision };
}
