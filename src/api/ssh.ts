import type { Host } from '../types';
import { requireBackendUrl } from '../config/backend';

export type SshConnection = {
  connectionId: string; connectionName: string; host: string; port: number;
  username: string; authType: 1 | 2;
  userId: string; encrypted: number | null; createdAt: string | null; updatedAt: string | null;
};
export type ConnectionDraft = Host & {
  password?: string; privateKey?: string; connectTimeout?: number; keepaliveInterval?: number;
  startupCommand?: string; compression?: boolean; strictHostKeyCheck?: boolean;
};
export type SshConnectionRequest = {
  connectionId?: string; connectionName: string; host: string; port: number; username: string;
  authType: 1 | 2; userId: string; password?: string; privateKey?: string;
  connectTimeout?: number; keepaliveInterval?: number; startupCommand?: string;
  compression?: boolean; strictHostKeyCheck?: boolean;
};
export const sshUserId = import.meta.env.VITE_SSH_USER_ID || 'default';

export type SshRequestFailureKind = 'timeout' | 'network' | 'http' | 'application';

/** 保留失败类别，终端轮询才能区分“客户端网络抖动”和“SSH 会话已不存在”。 */
export class SshRequestError extends Error {
  constructor(message: string, readonly kind: SshRequestFailureKind, readonly code?: string) {
    super(message);
    this.name = 'SshRequestError';
  }
}

export async function request<T>(endpoint: string, method = 'GET', body?: object, params?: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${requireBackendUrl()}/api/v1/ssh/${endpoint}${params ? `?${new URLSearchParams(params)}` : ''}`, {
      method, signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new SshRequestError(`SSH 服务请求失败（HTTP ${response.status}）`, 'http');
    const result = await response.json() as { code?: string; info?: string; data?: T };
    if (result.code !== 'SUCCESS_0000') {
      throw new SshRequestError(result.info || 'SSH 操作失败', 'application', result.code);
    }
    return result.data as T;
  } catch (error) {
    if (error instanceof SshRequestError) throw error;
    if (controller.signal.aborted) throw new SshRequestError('SSH 请求超时，请检查网络后重试。', 'timeout');
    if (error instanceof TypeError) throw new SshRequestError('无法访问 SSH 服务，请检查后端地址和网络连接。', 'network');
    throw error;
  } finally { clearTimeout(timeout); }
}

export const sshApi = {
  list: () => request<SshConnection[]>('connection_list', 'GET', undefined, { userId: sshUserId }),
  get: (connectionId: string) => request<SshConnection>('get_connection', 'GET', undefined, { connectionId }),
  create: (body: SshConnectionRequest) => request<SshConnection>('create_connection', 'POST', body),
  update: (body: SshConnectionRequest) => request<SshConnection>('update_connection', 'POST', body),
  delete: (connectionId: string) => request<void>('delete_connection', 'POST', undefined, { connectionId }),
};

export function toHost(dto: SshConnection): Host {
  return { id: dto.connectionId, name: dto.connectionName, address: dto.host, port: dto.port,
    user: dto.username, auth: dto.authType === 2 ? 'key' : 'password', userId: dto.userId, saved: true };
}

export function toRequest(draft: ConnectionDraft): SshConnectionRequest {
  return { connectionId: draft.id || undefined, connectionName: draft.name.trim(), host: draft.address.trim(),
    port: draft.port ?? 22, username: draft.user.trim(), authType: draft.auth === 'key' ? 2 : 1,
    userId: draft.userId || sshUserId, password: draft.auth !== 'key' ? draft.password || undefined : undefined,
    privateKey: draft.auth === 'key' ? draft.privateKey || undefined : undefined,
    connectTimeout: draft.connectTimeout, keepaliveInterval: draft.keepaliveInterval,
    startupCommand: draft.startupCommand, compression: draft.compression, strictHostKeyCheck: draft.strictHostKeyCheck };
}
