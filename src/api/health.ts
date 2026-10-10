import { normalizeBackendUrl, readBackendUrl } from '../config/backend';
import { backendFetch } from './backendFetch';

/**
 * 后端 /api/health 探测的标准化结果。
 *
 * 之所以把 ok / latency / message 拆开，是为了让多个 UI（启动页状态、设置页顶栏、
 * 启动/停止按钮 hint）能直接消费结构化字段，而不是各自再去 fetch + parse。
 */
export type BackendHealthSnapshot = {
  /** 探测是否成功拿到 status === "UP"。 */
  ok: boolean;
  /** 后端原始状态字串：UP / 其它（接口 200 但字段异常时）。 */
  status: string | null;
  /** 探测耗时（毫秒）；失败也保留，方便排查网络慢。 */
  latencyMs: number;
  /** 探测时的 ISO 时间，便于日志和 UI 展示。 */
  checkedAt: string;
  /** 失败原因；成功时为 null。 */
  message: string | null;
  /** 探测使用的后端根地址。 */
  backendUrl: string;
  /** 是否使用了客户端保存的自定义地址（区别于内置默认 127.0.0.1:8888）。 */
  usingCustomUrl: boolean;
};

export type BackendHealthProbeOptions = {
  /**
   * 指定要探测的根地址；不传则读取客户端保存的地址（内置默认或用户填的远程）。
   * 给“测试连接”按钮用，可以传入用户临时输入的地址。
   */
  backendUrl?: string;
  /** 单次请求超时；默认 4 秒，和“测试连接”超时一致。 */
  timeoutMs?: number;
  /** 用于取消本次探测的 AbortSignal。 */
  signal?: AbortSignal;
  /** 显式传 false 时跳过本地默认地址的探测（例如 UI 只想验证用户输入的地址）。 */
  useDefaultWhenMissing?: boolean;
};

/**
 * 把根地址归一化。readBackendUrl() 已经做了一次 normalize；这里仍然再做一次，
 * 是为了“测试连接”按钮传入的临时地址也走相同校验。
 */
function resolveUrl(raw: string | undefined, fallback: string | null): string {
  if (raw && raw.trim()) return normalizeBackendUrl(raw);
  if (fallback) return fallback;
  throw new Error('尚未配置后端地址。');
}

/**
 * 探测后端 /api/health。
 *
 * 设计要点：
 * - 故意绕开 apiRequest()，因为该函数会主动校验 JSON 信封（code === 'SUCCESS_0000'），
 *   而 /api/health 返回的是 {status, checkedAt}，没有 code 字段；同时它也不应触发
 *   任何业务级 Agent 接口，所以另起一个轻量 fetch 更直观。
 * - 4 秒超时和测试连接保持一致，避免 UI 长时间卡住。
 * - 即便后端返回 200 但 status !== "UP"，也算失败但 ok=false，让 UI 给出明确提示。
 */
export async function probeBackendHealth(options: BackendHealthProbeOptions = {}): Promise<BackendHealthSnapshot> {
  const fallback = options.useDefaultWhenMissing === false ? null : readBackendUrl();
  const baseUrl = resolveUrl(options.backendUrl, fallback);
  /**
   * 是否由调用方显式指定了根地址。
   * - 测试连接按钮 / 用户临时输入都走 options.backendUrl，会被识别成自定义；
   * - 仅依靠 localStorage 中的地址（不论是默认还是用户保存的远程）则是“客户端级配置”。
   * UI 用来告诉用户这次探测的来源。
   */
  const usingCustomUrl = typeof options.backendUrl === 'string' && options.backendUrl.trim().length > 0;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 4000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });

  const startedAt = performance.now();
  let checkedAt = new Date().toISOString();
  let rawStatus: string | null = null;
  let failureMessage: string | null = null;
  let ok = false;

  try {
    const response = await backendFetch(`${baseUrl}/api/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    }, true);
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      failureMessage = `健康检查返回 HTTP ${response.status}`;
      return {
        ok, status: rawStatus, latencyMs, checkedAt,
        message: failureMessage, backendUrl: baseUrl, usingCustomUrl,
      };
    }
    const payload = await response.json().catch(() => null) as { status?: unknown; checkedAt?: unknown } | null;
    const status = typeof payload?.status === 'string' ? payload.status : null;
    const reportedAt = typeof payload?.checkedAt === 'string' ? payload.checkedAt : null;
    rawStatus = status;
    if (reportedAt) checkedAt = reportedAt;
    ok = status === 'UP';
    if (!ok) {
      failureMessage = status ? `健康检查返回非 UP 状态：${status}` : '健康检查响应缺少 status 字段';
    }
    return {
      ok, status: rawStatus, latencyMs, checkedAt,
      message: failureMessage, backendUrl: baseUrl, usingCustomUrl,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    if (controller.signal.aborted) {
      failureMessage = options.signal?.aborted ? '健康检查已取消' : `健康检查超时（${timeoutMs}ms）`;
    } else if (error instanceof TypeError) {
      failureMessage = '无法访问后端，请检查地址和网络连接。';
    } else {
      failureMessage = error instanceof Error ? error.message : '健康检查失败。';
    }
    return {
      ok, status: rawStatus, latencyMs, checkedAt,
      message: failureMessage, backendUrl: baseUrl, usingCustomUrl,
    };
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
