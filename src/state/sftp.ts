import type { SftpProgress, SftpTransfer } from '../api/sftp.ts';

export function remoteParent(path: string, root: string): string | null {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === root || clean === '/') return null;
  const parent = clean.slice(0, clean.lastIndexOf('/')) || '/';
  return root === '/' || parent === root || parent.startsWith(`${root}/`) ? parent : null;
}
export function remoteChild(parent: string, name: string): string {
  if (!name.trim() || name === '.' || name === '..' || /[/*?\\\x00-\x1f\x7f]/.test(name)) throw new Error('目录名不能包含路径分隔符、通配符或控制字符。');
  return `${parent === '/' ? '' : parent}/${name}`;
}
export function transferPercent(progress: SftpProgress): number | null {
  if (progress.status === 'COMPLETED') return 100;
  if (progress.totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor(progress.transferredBytes / progress.totalBytes * 100)));
}
export const transferStatus: Record<string, string> = {
  AWAITING_CONTENT: '等待传输', RUNNING: '正在传输', AWAITING_CONFIRMATION: '等待本地保存确认',
  COMPLETED: '已完成', FAILED: '传输失败', CANCELLED: '已取消',
};
export function mergeTask(tasks: SftpTransfer[], next: SftpTransfer): SftpTransfer[] {
  const old = tasks.find(task => task.transferId === next.transferId);
  if (old && Date.parse(old.progress.updatedAt) > Date.parse(next.progress.updatedAt)) return tasks;
  return old ? tasks.map(task => task.transferId === next.transferId ? next : task) : [...tasks, next];
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
