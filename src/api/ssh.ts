import type { Host } from '../types';

export type SshConnection = {
  connectionId: string; connectionName: string; host: string; port: number;
  username: string; authType: 1 | 2; status: 0 | 1 | 2 | 3 | null;
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
// Override the full SSH controller URL in .env.local when needed.
const baseUrl = (import.meta.env.VITE_SSH_API_BASE_URL || 'http://localhost:8888/api/v1/ssh').replace(/\/$/, '');
export const sshUserId = import.meta.env.VITE_SSH_USER_ID || 'default';

export async function request<T>(endpoint: string, method = 'GET', body?: object, params?: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${baseUrl}/${endpoint}${params ? `?${new URLSearchParams(params)}` : ''}`, {
      method, signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`SSH 服务请求失败（HTTP ${response.status}）`);
    const result = await response.json();
    if (result.code !== 'SUCCESS_0000') throw new Error(result.info || 'SSH 操作失败');
    return result.data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('SSH 请求超时，请刷新连接状态后重试。');
    if (error instanceof TypeError) throw new Error('无法访问 SSH 服务，请检查后端地址和网络连接。');
    throw error;
  } finally { clearTimeout(timeout); }
}

export const sshApi = {
  list: () => request<SshConnection[]>('connection_list', 'GET', undefined, { userId: sshUserId }),
  get: (connectionId: string) => request<SshConnection>('get_connection', 'GET', undefined, { connectionId }),
  create: (body: SshConnectionRequest) => request<SshConnection>('create_connection', 'POST', body),
  update: (body: SshConnectionRequest) => request<SshConnection>('update_connection', 'POST', body),
  delete: (connectionId: string) => request<void>('delete_connection', 'POST', undefined, { connectionId }),
  connect: (connectionId: string) => request<void>('connect', 'POST', undefined, { connectionId }),
  disconnect: (connectionId: string) => request<void>('disconnect', 'POST', undefined, { connectionId }),
};

export function toHost(dto: SshConnection): Host {
  return { id: dto.connectionId, name: dto.connectionName, address: dto.host, port: dto.port,
    user: dto.username, auth: dto.authType === 2 ? 'key' : 'password', online: dto.status === 1,
    status: dto.status ?? 0, userId: dto.userId, saved: true };
}

export function toRequest(draft: ConnectionDraft): SshConnectionRequest {
  return { connectionId: draft.id || undefined, connectionName: draft.name.trim(), host: draft.address.trim(),
    port: draft.port ?? 22, username: draft.user.trim(), authType: draft.auth === 'key' ? 2 : 1,
    userId: draft.userId || sshUserId, password: draft.auth !== 'key' ? draft.password || undefined : undefined,
    privateKey: draft.auth === 'key' ? draft.privateKey || undefined : undefined,
    connectTimeout: draft.connectTimeout, keepaliveInterval: draft.keepaliveInterval,
    startupCommand: draft.startupCommand, compression: draft.compression, strictHostKeyCheck: draft.strictHostKeyCheck };
}
