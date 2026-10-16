import { ApiRequestError } from './client.ts';
import { Channel, invoke } from '@tauri-apps/api/core';
import { usesBuiltinIpc } from './builtin';
import { requireBackendUrl } from '../config/backend';

export interface UploadedFile {
  fileId: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256?: string;
  previewUrl?: string;
  status: string;
  downloadUrl: string;
  urlExpiresAt: string | number;
}

export type NativeAttachmentProgress = {id:string;fileName:string;size:number;finished?:boolean};
type AttachmentEvent = {type:'preparing'|'uploaded'|'error';id?:string;fileName?:string;size?:number;file?:UploadedFile;name?:string;message?:string};
/** Native chooser and file handles: attachment bytes never cross the WebView. */
export async function pickNativeAttachments(uploaded: (file: UploadedFile) => void, failed: (message: string) => void, chatOnly = false, chatLimit = 4, progress?: (value: NativeAttachmentProgress) => void): Promise<void> {
  const backendUrl = requireBackendUrl();
  if (!usesBuiltinIpc(backendUrl)) throw new Error('原生附件入口仅用于内置 Rust 服务。');
  const onEvent = new Channel<AttachmentEvent>();
  onEvent.onmessage = event => {
    if (event.type === 'preparing' && event.id && event.fileName) { progress?.({id:event.id,fileName:event.fileName,size:event.size??0}); return; }
    if (event.type === 'uploaded' && event.file) uploaded(event.file);
    else failed(`${event.name ?? '附件'}：${event.message ?? '上传失败'}`);
    if(event.id)progress?.({id:event.id,fileName:event.file?.fileName??event.fileName??'',size:event.file?.size??0,finished:true});
  };
  try { await invoke('builtin_pick_upload', { backendUrl, onEvent, chatOnly, chatLimit }); }
  catch (error) { throw new Error(error && typeof error === 'object' && 'message' in error ? String(error.message) : '附件选择失败'); }
}
/** Read only in response to the user's paste gesture; native code owns paths and bytes. */
export async function pasteNativeAttachments(uploaded: (file: UploadedFile) => void, chatLimit: number, chatBytes: number, progress?: (value: NativeAttachmentProgress) => void): Promise<string | null> {
  const backendUrl = requireBackendUrl();
  if (!usesBuiltinIpc(backendUrl)) throw new Error('请在桌面应用中粘贴附件。');
  const onEvent = new Channel<AttachmentEvent>();
  onEvent.onmessage = event => {
    if(event.type==='preparing'&&event.id&&event.fileName)progress?.({id:event.id,fileName:event.fileName,size:event.size??0});
    if(event.type==='uploaded'&&event.file){uploaded(event.file);if(event.id)progress?.({id:event.id,fileName:event.file.fileName,size:event.file.size,finished:true});}
  };
  try { return await invoke<string | null>('builtin_clipboard_upload', {backendUrl, onEvent, chatLimit, chatBytes}); }
  catch (error) { throw new Error(error && typeof error === 'object' && 'message' in error ? String(error.message) : '粘贴失败，请重试。'); }
}
export async function readNativeAttachmentPreview(fileId: string): Promise<string> {
  const backendUrl = requireBackendUrl();
  if (!usesBuiltinIpc(backendUrl)) throw new Error('请在桌面应用中预览图片。');
  try { return await invoke<string>('builtin_attachment_preview', {backendUrl,fileId}); }
  catch (error) { throw new Error(error && typeof error === 'object' && 'message' in error ? String(error.message) : '图片预览失败'); }
}
/** Native references pin both the file and the runtime that issued them. */
export function nativeAttachmentReference(value: string): { backendUrl: string; fileId: string } | null {
  const match = value.match(/^(ipc:\/\/builtin\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/files\/([0-9a-f-]{36})$/);
  return match ? { backendUrl: match[1], fileId: match[2] } : null;
}
export async function saveNativeAttachment(fileId: string, backendUrl = requireBackendUrl()): Promise<boolean> {
  if (!usesBuiltinIpc(backendUrl)) throw new Error('本地附件需要在桌面应用中保存。');
  return invoke<boolean>('builtin_save_attachment', { backendUrl, fileId });
}

/** WebView file bytes are never uploaded; use the native picker instead. */
export async function uploadFile(_file: File, signal?: AbortSignal): Promise<UploadedFile> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('上传已取消', 'AbortError');
  throw new ApiRequestError('请使用系统文件选择器上传附件。', 'application', 'FILE_NATIVE_PICKER_REQUIRED');
}

export function downloadUnavailable(file: Pick<UploadedFile, 'urlExpiresAt' | 'downloadUrl'>, _now = Date.now()): string | null {
  const reference = nativeAttachmentReference(file.downloadUrl);
  if (reference) return usesBuiltinIpc(reference.backendUrl) ? null : '本地附件需要在桌面应用中保存';
  return '附件引用不可用，请重新附加文件';
}
