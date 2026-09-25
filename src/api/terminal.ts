import { request } from './ssh';
import { requireBackendUrl } from '../config/backend';

export type TerminalOpen = { sessionId: string; connectionId: string; initialOutput: string };
export type TerminalConnectionState = { sessionId: string; connectionId: string; connected: boolean };
export type TerminalReadStatus = 'DATA' | 'TIMEOUT' | 'DISCONNECTED' | 'READER_ERROR' | 'REPLACED';
export type TerminalReadResult = {
  status: TerminalReadStatus;
  output: string;
  hasData: boolean;
  connected: boolean;
  eof: boolean;
  timeout: boolean;
  bufferOverflow: boolean;
};
export const terminalApi = {
  open: (connectionId: string, cols = 120, rows = 24) => request<TerminalOpen>('terminal/open', 'POST', { connectionId, cols, rows }),
  exec: (sessionId: string, command: string) => request<{ output: string }>('terminal/exec', 'POST', { sessionId, command }),
  write: (sessionId: string, input: string) => request<void>('terminal/write', 'POST', { sessionId, input }),
  read: (sessionId: string) => request<TerminalReadResult>('terminal/read', 'GET', undefined, { sessionId }),
  connected: (sessionId: string) => request<TerminalConnectionState>('terminal/connected', 'GET', undefined, { sessionId }),
  resize: (sessionId: string, cols: number, rows: number) => request<void>('terminal/resize', 'POST', { sessionId, cols, rows }),
  close: (sessionId: string) => request<void>('terminal/close', 'POST', undefined, { sessionId }),
  // 页签关闭时普通异步 fetch 可能被浏览器取消；sendBeacon 可把本窗口的终端清理请求可靠地交给浏览器。
  closeOnUnload: (sessionId: string) => navigator.sendBeacon(
    `${requireBackendUrl()}/api/v1/ssh/terminal/close?${new URLSearchParams({ sessionId })}`,
  ),
};
