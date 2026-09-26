import type { Host } from '../types';
import { apiRequest } from './client';
export { ApiRequestError as SshRequestError } from './client';
export type { RequestFailureKind as SshRequestFailureKind } from './client';

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

/** Keep SSH callers and terminal error classification on the shared request client. */
export function request<T>(endpoint: string, method = 'GET', body?: object, params?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(`ssh/${endpoint}`, { method, body, params, signal, service: 'SSH 服务' });
}

export const sshApi = {
  list: () => request<SshConnection[]>('connection_list', 'GET', undefined, { userId: sshUserId }),
  get: (connectionId: string) => request<SshConnection>('get_connection', 'GET', undefined, { connectionId }),
  create: (body: SshConnectionRequest) => request<SshConnection>('create_connection', 'POST', body),
  update: (body: SshConnectionRequest) => request<SshConnection>('update_connection', 'POST', body),
  delete: (connectionId: string) => request<void>('delete_connection', 'POST', undefined, { connectionId }),
  connect: (connectionId: string) => request<void>('connect', 'POST', undefined, { connectionId }),
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
