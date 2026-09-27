import type { TerminalConnectionState } from '../api/terminal';
import type { TerminalDisconnectEvent } from './remoteTerminal';

/** xterm 视图所依赖的统一运行时接口，由远程 SSH 和本地 CMD 共同实现。 */
export interface TerminalRuntime {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly readLoopGeneration: number;
  closed: boolean;
  disconnected: boolean;
  manuallyClosed: boolean;
  reconnectAllowed: boolean;
  setForeground(foreground: boolean): void;
  subscribe(
    output: (data: string) => void,
    report: (error: string) => void,
    reportDisconnect?: (event: TerminalDisconnectEvent) => void,
  ): () => void;
  resume(): void;
  verifyConnected(): Promise<TerminalConnectionState>;
  prepareReconnect(manual?: boolean): void;
  markManuallyClosed(): void;
  exec(command: string): Promise<void>;
  write(input: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}
