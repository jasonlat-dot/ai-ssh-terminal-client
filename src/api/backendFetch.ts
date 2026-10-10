import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../state/runtime';
import { activeBackendConnection } from '../config/backend';

/** 短时间复用已加载证书；并发的连接列表、Agent 与健康检查共用一次准备任务。 */
const TLS_PREPARATION_TTL_MS = 10_000;
const preparations = new Map<string, { promise: Promise<void>; expiresAt: number; pending: boolean }>();
let connectionPreparation: { key: string; promise: Promise<void> } | undefined;

/** 所有 API 和原生传输切换同一活动信任身份；指纹变化时重新准备，不复用上一连接的信任。 */
export async function prepareBackendConnectionTls(): Promise<void> {
  const profile = activeBackendConnection();
  if (!isTauriRuntime()) {
    if (profile.trust === 'certificate') throw new Error('普通浏览器不支持单连接证书信任，请使用桌面客户端或系统信任。');
    return;
  }
  const key = JSON.stringify([profile.id, profile.kind, profile.url, profile.trust, profile.certificatePem]);
  if (connectionPreparation?.key === key) return connectionPreparation.promise;
  const preceding = connectionPreparation?.promise.catch(() => undefined) ?? Promise.resolve();
  const preparation = { key, promise: Promise.resolve() };
  preparation.promise = preceding.then(() => invoke<void>('configure_backend_connection_tls', {
    backendUrl: profile.kind === 'remote' ? profile.url : null,
    certificatePem: profile.kind === 'remote' && profile.trust === 'certificate' ? profile.certificatePem : null,
  })).catch((error: unknown) => {
    if (connectionPreparation === preparation) connectionPreparation = undefined;
    throw new Error(`准备连接证书失败：${String(error)}`);
  });
  connectionPreparation = preparation;
  await preparation.promise;
}

/**
 * 内置档案的本机后端请求预加载默认证书，不依赖是否启动内置 Java。
 * 远程档案即使填写回环地址也不走本机证书自动加载，必须遵守其自身的信任配置。
 *
 * @param raw 实际请求地址，以 origin 为单位准备身份，不把业务参数传给 Rust
 * @param force 主动检查时重新读取证书，兼容 IDEA 重启/证书刚生成的情况
 */
async function prepareLocalTls(raw: string, force: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
  const active = activeBackendConnection();
  if (active.kind === 'remote' && new URL(active.url).origin === url.origin) return;
  const existing = preparations.get(url.origin);
  if (existing && (existing.pending || (!force && existing.expiresAt > Date.now()))) return existing.promise;
  const preparation = { promise: Promise.resolve(), expiresAt: 0, pending: true };
  preparation.promise = invoke<void>('prepare_local_backend_tls', { backendUrl: url.origin })
    .then(() => { preparation.pending = false; preparation.expiresAt = Date.now() + TLS_PREPARATION_TTL_MS; })
    .catch((cause: unknown) => {
      preparations.delete(url.origin); // 不缓存失败，修复证书/重启桌面壳后可立即重试。
      throw new Error(`准备本机后端证书失败：${String(cause)}。请确认后端已启动，并重新启动 Tauri 客户端。`);
    });
  preparations.set(url.origin, preparation);
  return preparation.promise;
}

/**
 * 保留原生 fetch 的 Response、流式读取、请求头与 AbortSignal，只增加本机证书预加载。
 * 不代理 HTTP 请求、不修改远程地址、不跳过证书校验，也不改变现有并发调度。
 */
export async function backendFetch(input: RequestInfo | URL, init?: RequestInit, forceTlsReload = false): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) return globalThis.fetch(input, init);
  await prepareBackendConnectionTls();
  await prepareLocalTls(raw, forceTlsReload);
  const profile = activeBackendConnection();
  // 单连接的自签信任不能跟随重定向扩散到另一台服务；系统信任模式保持原生行为。
  const pinned = profile.kind === 'remote' && profile.trust === 'certificate'
    && new URL(raw, window.location.href).origin === new URL(profile.url).origin;
  return globalThis.fetch(input, pinned ? { ...init, redirect: 'error' } : init);
}
