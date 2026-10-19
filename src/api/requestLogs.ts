import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../state/runtime';

/** Native code resolves the ID within its own logs; the UI never supplies a path. */
export async function revealRequestLog(traceId: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error('请在桌面客户端中定位请求日志。');
  try {
    await invoke<void>('bundled_backend_reveal_request_log', { traceId });
  } catch (cause) {
    throw new Error(typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '定位日志失败，请重试。');
  }
}
