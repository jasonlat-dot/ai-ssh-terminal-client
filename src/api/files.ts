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
