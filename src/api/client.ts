import { builtinRequest, NativeRequestError, usesBuiltinIpc } from './builtin';

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

type RequestOptions = {
  method?: string;
  body?: object | FormData;
  params?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  service?: string;
  baseUrl?: string;
};

/** Application requests always call local Rust services over IPC. */
export async function apiRequest<T>(endpoint: string, {
  method = 'GET', body, params, signal, timeoutMs = 60_000, service = '服务', baseUrl,
}: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!usesBuiltinIpc(baseUrl)) throw new ApiRequestError('请在桌面应用内使用此功能。', 'application', 'DESKTOP_REQUIRED');
    if (body instanceof FormData) throw new ApiRequestError('附件请使用系统文件选择器上传。', 'application', 'FILE_NATIVE_PICKER_REQUIRED');
    return await builtinRequest<T>(endpoint, method, body, params, controller.signal, baseUrl);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    if (error instanceof ApiRequestError) throw error;
    if (controller.signal.aborted) throw new ApiRequestError(`${service}请求超时，请检查网络后重试。`, 'timeout');
    if (error instanceof NativeRequestError) throw new ApiRequestError(error.message,
      error.status === 503 ? 'network' : 'application', error.code, error.status);
    if (error instanceof TypeError) throw new ApiRequestError(`无法访问${service}，请检查应用工作区是否已初始化。`, 'network');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
