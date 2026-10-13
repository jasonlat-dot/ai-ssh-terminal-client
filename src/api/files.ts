import { apiRequest, ApiRequestError } from './client.ts';
import { fileUploadPolicy, validateUploadFile } from '../config/fileUpload.ts';

export interface UploadedFile {
  fileId: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256?: string;
  status: string;
  downloadUrl: string;
  urlExpiresAt: string | number;
}

export async function uploadFile(file: File, signal?: AbortSignal): Promise<UploadedFile> {
  const invalid = validateUploadFile(file);
  if (invalid) throw new Error(invalid);
  const body = new FormData();
  body.append('file', file);
  const data = await apiRequest<UploadedFile>('files', {
    method: 'POST', body, signal, service: '文件服务', timeoutMs: fileUploadPolicy.timeoutMs,
  });
  if (!data || typeof data.fileId !== 'string' || !data.fileId
    || typeof data.fileName !== 'string' || typeof data.contentType !== 'string'
    || typeof data.size !== 'number' || !Number.isFinite(data.size) || data.size <= 0
    || (data.sha256 !== undefined && typeof data.sha256 !== 'string') || typeof data.downloadUrl !== 'string'
    || !['string', 'number'].includes(typeof data.urlExpiresAt) || (data.status !== undefined && data.status !== 'UPLOADED')) {
    throw new ApiRequestError('上传响应不完整或文件状态异常，无法确认上传结果。', 'application', 'FILE_RESPONSE_INVALID');
  }
  return { ...data, status: data.status ?? 'UPLOADED' };
}

export function downloadExpiresAt(value: UploadedFile['urlExpiresAt']): number | null {
  const time = typeof value === 'number'
    ? value < 1e12 ? value * 1000 : value
    : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function downloadUnavailable(file: Pick<UploadedFile, 'urlExpiresAt' | 'downloadUrl'>, now = Date.now()): string | null {
  const expiry = downloadExpiresAt(file.urlExpiresAt);
  if (expiry === null) return '无法确认下载链接有效期';
  if (expiry <= now) return '下载链接已过期';
  // Validate only. Never serialize or alter the returned signed URL.
  try {
    const url = new URL(file.downloadUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '下载链接不可用';
  } catch { return '下载链接不可用'; }
  return null;
}

export interface FileStorageStats {
  enabled: boolean; usedBytes: number; reservedBytes: number; maxStorageBytes: number;
  fileCount: number; maxFiles: number; maxFileBytes: number; retentionDays: number; downloadLinkSeconds: number;
}
export async function readUploadedFile(fileId: string, signal?: AbortSignal): Promise<UploadedFile> {
  if (!fileId.trim()) throw new Error('文件 ID 不能为空。');
  const file = await apiRequest<UploadedFile>('files/' + encodeURIComponent(fileId), { signal, service: '文件服务' });
  if (!file || file.fileId !== fileId || file.status !== 'UPLOADED'
      || typeof file.fileName !== 'string' || typeof file.contentType !== 'string'
      || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0
      || typeof file.sha256 !== 'string' || downloadExpiresAt(file.urlExpiresAt) === null
      || typeof file.downloadUrl !== 'string' || downloadUnavailable({ downloadUrl: file.downloadUrl, urlExpiresAt: Date.now() + 1000 }) !== null) {
    throw new ApiRequestError('附件元数据响应异常。', 'application', 'FILE_RESPONSE_INVALID');
  }
  return file;
}
export async function listUploadedFiles(offset = 0, signal?: AbortSignal): Promise<{ items: UploadedFile[]; offset: number; hasMore: boolean }> {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('文件列表偏移无效。');
  const page = await apiRequest<{ items: UploadedFile[]; offset: number; hasMore: boolean }>('files', { params: { offset: String(offset) }, signal, service: '文件服务' });
  if (!page || !Array.isArray(page.items) || page.items.length > 20 || page.offset !== offset || typeof page.hasMore !== 'boolean'
      || page.items.some(file => !file || !file.fileId || typeof file.fileName !== 'string' || file.status !== 'UPLOADED'
        || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0
        || typeof file.downloadUrl !== 'string' || downloadExpiresAt(file.urlExpiresAt) === null)) {
    throw new ApiRequestError('文件列表响应异常。', 'application', 'FILE_RESPONSE_INVALID');
  }
  return page;
}
export async function deleteUploadedFile(fileId: string): Promise<void> {
  if (!fileId.trim()) throw new Error('文件 ID 不能为空。');
  await apiRequest<void>('files/' + encodeURIComponent(fileId), { method: 'DELETE', service: '文件服务' });
}
export async function readFileStorageStats(): Promise<FileStorageStats> {
  const stats = await apiRequest<FileStorageStats>('files/storage', { service: '文件服务' });
  const numbers = ['usedBytes', 'reservedBytes', 'maxStorageBytes', 'fileCount', 'maxFiles', 'maxFileBytes', 'retentionDays', 'downloadLinkSeconds'] as const;
  if (!stats || typeof stats.enabled !== 'boolean' || numbers.some(key => typeof stats[key] !== 'number' || !Number.isSafeInteger(stats[key]) || stats[key] < 0)) {
    throw new ApiRequestError('存储容量响应异常。', 'application', 'FILE_RESPONSE_INVALID');
  }
  return stats;
}
