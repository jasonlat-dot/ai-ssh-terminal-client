import { uploadFile } from '../api/files.ts';
import type { UploadedFile } from '../api/files.ts';
import { ApiRequestError } from '../api/client.ts';
import { fileUploadPolicy, validateUploadFile } from '../config/fileUpload.ts';

export type UploadItem = {
  id: string;
  fingerprint: string;
  file?: File;
  name: string;
  size: number;
  status: 'queued' | 'uploading' | 'success' | 'error';
  error?: string;
  errorCode?: string;
  uncertain?: boolean;
  retryable: boolean;
  result?: UploadedFile;
};

type Upload = (file: File, signal: AbortSignal) => Promise<UploadedFile>;

/** Independent of SSH tabs and chat; closing the dialog does not stop uploads. */
export class FileUploadQueue {
  private items: readonly UploadItem[] = [];
  private listeners = new Set<() => void>();
  private requests = new Map<string, AbortController>();
  private active = true;
  private upload: Upload;

  constructor(upload: Upload = uploadFile) { this.upload = upload; }

  getSnapshot = () => this.items;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(items: readonly UploadItem[]) {
    this.items = items;
    this.listeners.forEach(listener => listener());
  }
  private update(id: string, change: Partial<UploadItem>) {
    this.publish(this.items.map(item => item.id === id ? { ...item, ...change } : item));
  }

  add = (files: Iterable<File>): number => {
    const next = [...this.items];
    let duplicates = 0;
    for (const file of files) {
      const fingerprint = JSON.stringify([file.name, file.size, file.lastModified, file.type]);
      if (next.some(item => item.fingerprint === fingerprint && item.status !== 'success')) {
        duplicates += 1;
        continue;
      }
      const error = validateUploadFile(file);
      next.push({ id: crypto.randomUUID(), fingerprint, file, name: file.name, size: file.size,
        status: error ? 'error' : 'queued', error: error ?? undefined, retryable: !error });
    }
    this.publish(next);
    this.pump();
    return duplicates;
  };

  retry = (id: string) => {
    const item = this.items.find(item => item.id === id);
    if (!item || item.status !== 'error' || !item.file || !item.retryable) return;
    const invalid = validateUploadFile(item.file);
    if (invalid) { this.update(id, { error: invalid, retryable: false }); return; }
    this.update(id, { status: 'queued', error: undefined, errorCode: undefined, uncertain: false });
    this.pump();
  };

  remove = (id: string) => {
    // Removal is local only, and cannot hide an in-flight request.
    if (this.requests.has(id)) return;
    this.publish(this.items.filter(item => item.id !== id));
  };

  activate = () => { this.active = true; this.pump(); };
  deactivate = () => {
    this.active = false;
    const interrupted = new Set(this.requests.keys());
    this.requests.forEach(controller => controller.abort());
    this.requests.clear();
    this.publish(this.items.map(item => interrupted.has(item.id)
      ? { ...item, status: 'error', error: '上传已中断，无法确认后端是否已保存文件。', uncertain: true }
      : item));
  };

  private pump() {
    if (!this.active) return;
    while (this.requests.size < fileUploadPolicy.concurrency) {
      const item = this.items.find(item => item.status === 'queued');
      if (!item?.file) break;
      const controller = new AbortController();
      this.requests.set(item.id, controller);
      this.update(item.id, { status: 'uploading' });
      void this.send(item, controller);
    }
  }

  private async send(item: UploadItem, controller: AbortController) {
    try {
      const result = await this.upload(item.file!, controller.signal);
      if (this.requests.get(item.id) !== controller) return;
      this.update(item.id, { status: 'success', result, file: undefined, retryable: false });
    } catch (error) {
      if (this.requests.get(item.id) !== controller) return;
      const failure = error instanceof ApiRequestError ? error : null;
      this.update(item.id, {
        status: 'error', error: error instanceof Error ? error.message : '上传失败，请稍后重试。',
        errorCode: failure?.code,
        uncertain: failure?.kind === 'network' || failure?.kind === 'timeout'
          || (failure?.kind === 'application' && (!failure.code || failure.code === 'FILE_RESPONSE_INVALID')),
      });
    } finally {
      if (this.requests.get(item.id) === controller) {
        this.requests.delete(item.id);
        this.pump();
      }
    }
  }
}
