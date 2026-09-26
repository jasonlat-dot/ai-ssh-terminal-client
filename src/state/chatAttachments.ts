import { FileUploadQueue } from './fileUploads.ts';
import type { UploadedFile } from '../api/files.ts';
import type { ChatAttachment } from '../types.ts';

export const chatAttachmentPolicy = {
  maxCount: 4,
  maxBytes: 20_000_000,
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'txt', 'log', 'csv', 'json', 'yaml', 'yml', 'md'],
  imageExtensions: ['png', 'jpg', 'jpeg', 'webp'],
};
function extension(name: string) { return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''; }
export function isImageAttachment(name: string) {
  return chatAttachmentPolicy.imageExtensions.includes(extension(name));
}
export function validateChatAttachments(files: readonly { name: string; size: number }[]): string | null {
  if (files.length > chatAttachmentPolicy.maxCount) return '每条消息最多附加 4 个文件，本次选择未加入。';
  if (files.some(file => !Number.isFinite(file.size) || file.size <= 0)) return '不能附加空文件或大小未知的文件，本次选择未加入。';
  if (files.some(file => !chatAttachmentPolicy.extensions.includes(extension(file.name)))) return '聊天仅支持 PNG、JPG、WEBP、PDF 和 UTF-8 文本文件，暂不支持 DOCX、XLSX。';
  if (files.reduce((sum, file) => sum + file.size, 0) > chatAttachmentPolicy.maxBytes) return '附件原始大小合计不能超过 20 MB，本次选择未加入。';
  return null;
}
export function validateChatContent(text: string, attachments: readonly ChatAttachment[]): string | null {
  if (!text.trim() && !attachments.length) return '请输入文字或添加附件。';
  if (attachments.some(file => !file.fileId.trim()) || new Set(attachments.map(file => file.fileId)).size !== attachments.length) return '附件引用无效或重复，请移除后重新附加。';
  return validateChatAttachments(attachments.map(file => ({ name: file.fileName, size: file.size })));
}
export function attachmentReferences(attachments: readonly ChatAttachment[]) {
  return attachments.map(({ fileId }) => ({ fileId }));
}

/** File items take precedence. Do not read files a second time for the same paste. */
export function pastedFiles(clipboard: Pick<DataTransfer, 'items' | 'files'>): File[] {
  const items = Array.from(clipboard.items ?? []).filter(item => item.kind === 'file');
  const fromItems = items.map(item => item.getAsFile()).filter((file): file is File => file !== null);
  const files = fromItems.length ? fromItems : Array.from(clipboard.files ?? []);
  return files.map((file, index) => {
    const imageTypes: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    if (!file.name.includes('.') && imageTypes[file.type]) {
      return new File([file], `clipboard-${index + 1}.${imageTypes[file.type]}`, { type: file.type, lastModified: file.lastModified });
    }
    return file;
  });
}
export function insertPastedText(draft: string, text: string, start: number, end: number) {
  return { text: draft.slice(0, start) + text + draft.slice(end), cursor: start + text.length };
}

/** URLs belong to the app; draft and displayed messages can share a preview. */
export class AttachmentPreviews {
  private urls = new Set<string>();
  create = (file: File) => {
    if (!isImageAttachment(file.name)) return undefined;
    const url = URL.createObjectURL(file);
    this.urls.add(url);
    return url;
  };
  reconcile(live: Iterable<string | undefined>) {
    const keep = new Set(live);
    for (const url of this.urls) if (!keep.has(url)) { URL.revokeObjectURL(url); this.urls.delete(url); }
  }
  dispose = () => this.reconcile([]);
}

export class ChatAttachmentDraft {
  private queue: FileUploadQueue;
  constructor(previews: AttachmentPreviews, upload?: (file: File, signal: AbortSignal) => Promise<UploadedFile>) {
    this.queue = new FileUploadQueue(upload, {
      validate: file => validateChatAttachments([file]), preview: previews.create, cancelOnRemove: true,
    });
  }
  getSnapshot = () => this.queue.getSnapshot();
  subscribe = (listener: () => void) => this.queue.subscribe(listener);
  activate = () => this.queue.activate();
  deactivate = () => this.queue.deactivate();
  private validate(next: readonly { name: string; size: number }[]) {
    const error = validateChatAttachments(next);
    if (error) throw new Error(error);
  }
  add = (files: File[]) => {
    this.validate([...this.getSnapshot(), ...files]);
    const fingerprints = new Set(this.getSnapshot().map(item => item.fingerprint));
    for (const file of files) {
      const key = JSON.stringify([file.name, file.size, file.lastModified, file.type]);
      if (fingerprints.has(key)) throw new Error('所选附件已在输入框中，请勿重复添加。');
      fingerprints.add(key);
    }
    this.queue.add(files);
  };
  attach = (attachments: readonly ChatAttachment[]) => {
    const current = this.getSnapshot();
    this.validate([...current, ...attachments.map(file => ({ name: file.fileName, size: file.size }))]);
    const ids = new Set(current.map(item => item.result?.fileId).filter(Boolean));
    for (const file of attachments) {
      if (!file.fileId || ids.has(file.fileId)) throw new Error('此附件已在输入框中，不能重复附加。');
      ids.add(file.fileId);
    }
    attachments.forEach(file => this.queue.addUploaded({
      fileId: file.fileId, fileName: file.fileName, size: file.size, contentType: file.contentType,
      status: 'UPLOADED', sha256: '', downloadUrl: file.downloadUrl ?? '', urlExpiresAt: file.urlExpiresAt ?? '',
    }, file.previewUrl));
  };
  retry = (id: string) => { this.validate(this.getSnapshot()); this.queue.retry(id); };
  remove = (id: string) => this.queue.remove(id);
  clear = () => this.queue.clear();
  ready = (): ChatAttachment[] => {
    const items = this.getSnapshot();
    this.validate(items);
    if (items.some(item => item.status === 'error')) throw new Error('附件上传失败，请重试或移除后再发送。');
    if (items.some(item => item.status !== 'success' || !item.result?.fileId)) throw new Error('附件尚未准备完成，请等待上传结束。');
    return items.map(item => ({
      fileId: item.result!.fileId, fileName: item.name, size: item.size, contentType: item.result!.contentType,
      downloadUrl: item.result!.downloadUrl, urlExpiresAt: item.result!.urlExpiresAt, previewUrl: item.previewUrl,
    }));
  };
}

/** Persist references/metadata, never an in-memory blob URL or original File. */
export function storedAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(file => {
    if (!file || typeof file.fileId !== 'string' || typeof file.fileName !== 'string'
      || typeof file.size !== 'number' || typeof file.contentType !== 'string') return [];
    return [{ fileId: file.fileId, fileName: file.fileName, size: file.size, contentType: file.contentType,
      ...(typeof file.downloadUrl === 'string' ? { downloadUrl: file.downloadUrl } : {}),
      ...(typeof file.urlExpiresAt === 'string' || typeof file.urlExpiresAt === 'number' ? { urlExpiresAt: file.urlExpiresAt } : {}),
    }];
  });
}
