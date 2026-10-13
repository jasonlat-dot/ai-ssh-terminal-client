import { isBuiltinEndpoint, readBackendUrl } from '../config/backend';
import { builtinRequest } from './builtin';

/** Readiness of application services, checked over IPC only. */
export type BackendHealthSnapshot = {
  ok: boolean; status: string | null; latencyMs: number; checkedAt: string;
  message: string | null; backendUrl: string;
};
export type BackendHealthProbeOptions = {
  /** Internal instance identity, not an HTTP address. */
  backendUrl?: string; timeoutMs?: number; signal?: AbortSignal;
};
export async function probeBackendHealth(options: BackendHealthProbeOptions = {}): Promise<BackendHealthSnapshot> {
  const backendUrl = options.backendUrl ?? readBackendUrl();
  if (!isBuiltinEndpoint(backendUrl)) throw new Error('工作区检查仅支持应用内部通信。');
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 4000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const started = performance.now();
  try {
    const payload = await builtinRequest<{status: string; checkedAt: string}>('health', 'GET', null, {}, controller.signal, backendUrl);
    return { ok: payload.status === 'UP', status: payload.status, checkedAt: payload.checkedAt,
      latencyMs: Math.round(performance.now() - started), message: payload.status === 'UP' ? null : '工作区尚未就绪', backendUrl };
  } catch (error) {
    return { ok: false, status: null, checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started), backendUrl,
      message: controller.signal.aborted ? options.signal?.aborted ? '工作区检查已取消' : `工作区检查超时（${timeoutMs}ms）`
        : error instanceof Error ? error.message : '工作区检查失败' };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
  }
}
