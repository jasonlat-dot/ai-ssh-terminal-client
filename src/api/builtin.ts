import { Channel, invoke } from '@tauri-apps/api/core';
import { isBuiltinEndpoint, requireBackendUrl } from '../config/backend';
import { isTauriRuntime } from '../state/runtime';
import type { TerminalReadResult } from './terminal';

export function usesBuiltinIpc(baseUrl = requireBackendUrl()): boolean {
  // A terminal stays pinned to the workspace instance that created it.
  return isTauriRuntime() && isBuiltinEndpoint(baseUrl);
}
export class NativeRequestError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(error: unknown) {
    const data = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    super(typeof data.message === 'string' ? data.message : String(error));
    this.code = typeof data.code === 'string' ? data.code : undefined;
    this.status = typeof data.status === 'number' ? data.status : undefined;
  }
}
export async function builtinRequest<T>(endpoint: string, method: string, body: unknown, params: unknown, signal?: AbortSignal, backendUrl = requireBackendUrl()): Promise<T> {
  if (!isTauriRuntime()) throw new Error('请在桌面应用内使用此功能。');
  if (!isBuiltinEndpoint(backendUrl)) throw new Error('应用功能仅支持内部 IPC。');
  if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
  const requestId = crypto.randomUUID();
  const abort = () => { void invoke('builtin_cancel', { requestId }).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const data = await invoke<T>('builtin_request', { request: {requestId, endpoint, method,
      body: body ?? null, params: params ?? {}, backendUrl} });
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    return data;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    throw new NativeRequestError(error);
  } finally { signal?.removeEventListener('abort', abort); }
}

/** At most one 64 KiB frame is outstanding; acknowledgement applies to this subscription only. */
export function subscribeBuiltinTerminal(sessionId: string, backendUrl: string,
  receive: (result: TerminalReadResult) => void | Promise<void>, failed: (error: Error) => void): () => void {
  const streamId = crypto.randomUUID();
  let stopped = false;
  let ended = false;
  const onEvent = new Channel<{ sequence: number; result: TerminalReadResult }>();
  onEvent.onmessage = async event => {
    if (stopped) return;
    ended = event.result.status === 'DISCONNECTED' || event.result.status === 'READER_ERROR';
    try { await receive(event.result); }
    catch (error) { if (!stopped) failed(error instanceof Error ? error : new Error(String(error))); }
    finally {
      if (event.sequence > 0) void invoke('builtin_terminal_ack', { streamId, sequence: event.sequence }).catch(() => undefined);
    }
  };
  void invoke('builtin_terminal_subscribe', { streamId, sessionId, backendUrl, onEvent })
    .then(() => { if (!stopped && !ended) failed(new Error('终端输出订阅已结束，请重试读取。')); })
    .catch(error => { if (!stopped) failed(new NativeRequestError(error)); });
  return () => {
    stopped = true;
    // The cancellation receipt also covers unsubscribe arriving before subscribe.
    void invoke('builtin_cancel', { requestId: streamId }).catch(() => undefined);
    void invoke('builtin_terminal_unsubscribe', { streamId }).catch(() => undefined);
  };
}
