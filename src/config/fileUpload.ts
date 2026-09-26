export const fileUploadPolicy = {
  maxBytes: 20 * 1024 * 1024,
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'txt', 'log', 'csv', 'json', 'yaml', 'yml', 'md', 'docx', 'xlsx'] as readonly string[],
  concurrency: 2,
  timeoutMs: 120_000,
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function validateUploadFile(file: Pick<File, 'name' | 'size'>): string | null {
  if (file.size === 0) return '不能上传空文件。';
  if (file.size > fileUploadPolicy.maxBytes) return `文件超过单文件 ${formatFileSize(fileUploadPolicy.maxBytes)} 上限。`;
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (!fileUploadPolicy.extensions.includes(extension)) return '不支持此文件扩展名，请选择下方列出的文件类型。';
  return null;
}
