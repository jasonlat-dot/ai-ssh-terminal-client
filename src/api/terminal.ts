import { subscribeBuiltinTerminal } from './builtin';
import { apiRequest } from './client';
import type { TerminalDisconnectReason } from '../types';

export type TerminalOpen = { sessionId: string; connectionId: string; initialOutput: string };
export interface TerminalConnectionState {
  sessionId: string;
  connectionId: string | null;
  connected: boolean;
  disconnectReason: TerminalDisconnectReason | null;
  reconnectAllowed: boolean;
}
export type TerminalReadStatus = 'DATA' | 'TIMEOUT' | 'DISCONNECTED' | 'READER_ERROR' | 'REPLACED';
export interface TerminalReadResult {
  status: TerminalReadStatus;
  output: string;
  hasData: boolean;
  connected: boolean;
  eof: boolean;
  timeout: boolean;
  bufferOverflow: boolean;
  disconnectReason: TerminalDisconnectReason | null;
  reconnectAllowed: boolean;
}
function bound<T>(endpoint: string, method: string, body: object | undefined, params: Record<string,string> | undefined, baseUrl?: string, signal?: AbortSignal) {
  return apiRequest<T>(`ssh/terminal/${endpoint}`, { method, body, params, baseUrl, signal,
    service: 'SSH 服务' });
}
export const terminalApi = {
  async connect(connectionId: string, requestId: string, signal: AbortSignal, baseUrl: string) {
    const opened = await apiRequest<TerminalOpen>('ssh/terminal/connect', {
      method: 'POST', body: { connectionId, requestId, cols: 120, rows: 24 }, signal, baseUrl, service: 'SSH 服务',
    });
    return opened;
  },
  cancelConnect: (connectionId: string, requestId: string, baseUrl: string) => apiRequest<void>('ssh/terminal/cancel_connect', {
    method: 'POST', params: { connectionId, requestId }, baseUrl, service: 'SSH 服务',
  }),
  write: (sessionId: string, input: string, baseUrl?: string) => bound<void>('write','POST',{sessionId,input},undefined,baseUrl),
  read: (sessionId: string, signal?: AbortSignal, baseUrl?: string) => bound<TerminalReadResult>('read','GET',undefined,{sessionId},baseUrl,signal),
  connected: (sessionId: string, baseUrl?: string) => bound<TerminalConnectionState>('connected','GET',undefined,{sessionId},baseUrl),
  resize: (sessionId: string, cols: number, rows: number, baseUrl?: string) => bound<void>('resize','POST',{sessionId,cols,rows},undefined,baseUrl),
  close: async (sessionId: string, signal?: AbortSignal, baseUrl?: string) => {
    await bound<void>('close','POST',undefined,{sessionId},baseUrl,signal);
  },
  subscribe: subscribeBuiltinTerminal,
};
