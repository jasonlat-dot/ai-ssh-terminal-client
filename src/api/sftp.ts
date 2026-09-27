import { Channel, invoke } from '@tauri-apps/api/core';
import { requireBackendUrl } from '../config/backend';
import { isTauriRuntime } from '../state/runtime';

export type SftpEntry = { name: string; path: string; kind: 'FILE' | 'DIRECTORY' | 'SYMLINK' | 'OTHER'; size: number; modifiedAt: number; permissions: string };
export type LocalDirectory = { path: string; parent: string | null; entries: SftpEntry[] };
export type SftpSession = { sftpSessionId: string; connectionId: string; rootPath: string; createdAt: string };
export type SftpItem = { itemId: string; relativePath: string; kind: SftpEntry['kind']; size: number; transferredBytes: number; status: string; errorCode: string | null; message: string | null };
export type SftpProgress = { transferId: string; direction: 'UPLOAD' | 'DOWNLOAD'; status: string; totalBytes: number; transferredBytes: number; completedItems: number; totalItems: number; failedItems: number; awaitingConfirmation: number; updatedAt: string; activeItems: SftpItem[] };
export type SftpTransfer = { transferId: string; sftpSessionId: string; direction: 'UPLOAD' | 'DOWNLOAD'; remotePath: string; progress: SftpProgress; items: SftpItem[] };
export type SftpEvent =
  | { type: 'progress'; data: SftpProgress[] }
  | { type: 'task'; data: SftpTransfer }
  | { type: 'local-progress'; data: { transferId: string; itemId: string; bytes: number } }
  | { type: 'connection'; data: string }
  | { type: 'session-closed'; data: unknown }
  | { type: 'error'; data: { transferId: string; message: string } };

export class SftpError extends Error {
  code?: string;
  status?: number;
  constructor(error: unknown) {
    const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    super(typeof value.message === 'string' ? value.message : String(error));
    this.code = typeof value.code === 'string' ? value.code : undefined;
    this.status = typeof value.status === 'number' ? value.status : undefined;
  }
}
async function native<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriRuntime()) throw new Error('请在桌面客户端打开文件管理，本地文件传输需要 Tauri。');
  try { return await invoke<T>(command, args); }
  catch (error) { throw new SftpError(error); }
}
export const sftpApi = {
  open(connectionId: string, rootPath: string, onEvent: (event: SftpEvent) => void) {
    if (!isTauriRuntime()) return Promise.reject(new Error('请在桌面客户端打开文件管理，本地文件传输需要 Tauri。'));
    const channel = new Channel<SftpEvent>();
    channel.onmessage = onEvent;
    return native<SftpSession>('sftp_open', { backendUrl: requireBackendUrl(), connectionId, rootPath: rootPath.trim() || null, onEvent: channel });
  },
  close: (sessionId: string) => native<void>('sftp_close', { sessionId }),
  entries: (sessionId: string, path: string) => native<SftpEntry[]>('sftp_entries', { sessionId, path }),
  mkdir: (sessionId: string, path: string) => native<void>('sftp_mkdir', { sessionId, path }),
  tasks: (sessionId: string) => native<SftpTransfer[]>('sftp_tasks', { sessionId }),
  transfer: (sessionId: string, direction: 'UPLOAD' | 'DOWNLOAD', localPath: string, remotePath: string, conflict: 'FAIL' | 'SKIP') => native<void>('sftp_transfer', { sessionId, direction, localPath, remotePath, conflict }),
  retry: (sessionId: string, transferId: string) => native<void>('sftp_retry', { sessionId, transferId }),
  cancel: (sessionId: string, transferId: string) => native<void>('sftp_cancel', { sessionId, transferId }),
  local: (path?: string) => native<LocalDirectory>('sftp_local_entries', { path: path || null }),
  localMkdir: (parent: string, name: string) => native<void>('sftp_local_mkdir', { parent, name }),
};
