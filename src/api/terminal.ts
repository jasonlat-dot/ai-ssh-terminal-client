import { request } from './ssh';
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
export const terminalApi = {
  connect: (connectionId: string, requestId: string, signal: AbortSignal, baseUrl: string) => apiRequest<TerminalOpen>('ssh/terminal/connect', {
    method: 'POST', body: { connectionId, requestId, cols: 120, rows: 24 }, signal, baseUrl, service: 'SSH 服务',
  }),
  cancelConnect: (connectionId: string, requestId: string, baseUrl: string) => apiRequest<void>('ssh/terminal/cancel_connect', {
    method: 'POST', params: { connectionId, requestId }, baseUrl, service: 'SSH 服务',
  }),
  write: (sessionId: string, input: string) => request<void>('terminal/write', 'POST', { sessionId, input }),
  read: (sessionId: string, signal?: AbortSignal) => request<TerminalReadResult>('terminal/read', 'GET', undefined, { sessionId }, signal),
  connected: (sessionId: string) => request<TerminalConnectionState>('terminal/connected', 'GET', undefined, { sessionId }),
  resize: (sessionId: string, cols: number, rows: number) => request<void>('terminal/resize', 'POST', { sessionId, cols, rows }),
  close: (sessionId: string, signal?: AbortSignal, baseUrl?: string) => apiRequest<void>('ssh/terminal/close', {
    method: 'POST', params: { sessionId }, signal, baseUrl, service: 'SSH 服务',
  }),
};
