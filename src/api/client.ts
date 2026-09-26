import { requireBackendUrl } from '../config/backend.ts';

export type RequestFailureKind = 'timeout' | 'network' | 'http' | 'application';

export class ApiRequestError extends Error {
  readonly kind: RequestFailureKind;
  readonly code?: string;
  readonly httpStatus?: number;

  constructor(message: string, kind: RequestFailureKind, code?: string, httpStatus?: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.kind = kind;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Preserve any deployment prefix; an existing /api/v1 must not be appended twice. */
export function apiUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const root = base.endsWith('/api/v1') ? base : `${base}/api/v1`;
  return `${root}/${endpoint.replace(/^\/+/, '')}`;
}

type RequestOptions = {
  method?: string;
  body?: object | FormData;
  params?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  service?: string;
};

/** Shared JSON-envelope client. Fetch retains the existing same-origin cookie/auth behaviour. */
export async function apiRequest<T>(endpoint: string, {
  method = 'GET', body, params, signal, timeoutMs = 60_000, service = '服务',
}: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = body instanceof FormData;
    const response = await fetch(`${apiUrl(requireBackendUrl(), endpoint)}${params ? `?${new URLSearchParams(params)}` : ''}`, {
      method, signal: controller.signal,
      // Never set Content-Type for FormData: fetch supplies the multipart boundary.
      headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? form ? body : JSON.stringify(body) : undefined,
    });
    const payload: unknown = await response.json().catch(error => {
      // A truncated/aborted response is not evidence that the server rejected the upload.
      if (controller.signal.aborted || error instanceof TypeError) throw error;
      return null;
    });
    const result = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const info = typeof result.info === 'string' && result.info.trim() ? result.info : undefined;
    const code = typeof result.code === 'string' ? result.code : undefined;
    if (!response.ok) throw new ApiRequestError(info || `${service}请求失败（HTTP ${response.status}）`, 'http', code, response.status);
    if (code !== 'SUCCESS_0000') throw new ApiRequestError(info || `${service}操作失败，响应格式异常。`, 'application', code, response.status);
    return result.data as T;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    if (error instanceof ApiRequestError) throw error;
    if (controller.signal.aborted) throw new ApiRequestError(`${service}请求超时，请检查网络后重试。`, 'timeout');
    if (error instanceof TypeError) throw new ApiRequestError(`无法访问${service}，请检查后端地址和网络连接。`, 'network');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
