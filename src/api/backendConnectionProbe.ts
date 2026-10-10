import { invoke } from '@tauri-apps/api/core';
import { normalizeBackendUrl, type BackendConnectionProfile } from '../config/backend';
import { isTauriRuntime } from '../state/runtime';
import { probeBackendHealth } from './health';

/** 独立测试结果只反映 TLS、HTTP 和 /api/health，不代表业务鉴权或浏览器跨域已经通过。 */
export type BackendConnectionProbeResult = {
  ok: boolean;
  status: string | null;
  latencyMs: number;
  message: string | null;
  /** 没有 HTTP 响应或旧版桌面壳未提供时为空；不能用它替代业务健康状态。 */
  httpStatus?: number | null;
  /** 原生侧限长并过滤控制字符的失败正文摘要，只能作为纯文本展示。 */
  responseBody?: string | null;
};

/**
 * 按页面草稿测试，不要求连接名称已填写或档案已保存。
 * @param profile 地址、档案类型、证书验证方式及公开证书的本次快照
 * @returns 不依赖活动连接的探测结果；参数错误直接抛出供界面展示
 */
export async function probeBackendConnection(profile: BackendConnectionProfile): Promise<BackendConnectionProbeResult> {
  const backendUrl = normalizeBackendUrl(profile.url);
  if (!isTauriRuntime()) {
    if (profile.trust === 'certificate') throw new Error('普通浏览器无法使用指定证书进行独立测试，请使用桌面客户端。');
    // 纯浏览器没有原生测试命令，只能使用浏览器本身的信任；不模拟桌面证书例外。
    return probeBackendHealth({ backendUrl });
  }
  // 不调用 prepareBackendConnectionTls/prepare_local_backend_tls，也不读写 activeId 或 localStorage。
  return invoke<BackendConnectionProbeResult>('probe_backend_connection', {
    request: {
      backendUrl,
      kind: profile.kind,
      trust: profile.trust,
      certificatePem: profile.trust === 'certificate' ? profile.certificatePem.trim() : null,
    },
  });
}
