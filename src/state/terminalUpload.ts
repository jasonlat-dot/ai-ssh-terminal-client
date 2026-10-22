import type { TerminalRuntime } from './terminalRuntime';
import { terminalFileTarget } from './terminalFileTarget';
import type { TerminalFileTarget } from './terminalFileTarget';

type TransferBase = { id: string; terminalId: string; title: string; target: TerminalFileTarget; paths: string[] };
export type TerminalUploadRequest = TransferBase & { direction?: 'UPLOAD' };
export type TerminalDownloadRequest = TransferBase & { direction: 'DOWNLOAD'; remotePath: string; remotePaths?: string[] };
export type TerminalTransferRequest = TerminalUploadRequest | TerminalDownloadRequest;

/** Sidebar targets are explicit: free browsing must not silently use the Shell cwd. */
export function createSidebarTransfer(runtime: TerminalRuntime, terminalId: string, title: string,
  path: string, paths: string[], remoteName?: string | string[]): TerminalTransferRequest {
  if (runtime.closed || runtime.disconnected || runtime.manuallyClosed || runtime.transportAvailable === false
    || runtime.directorySnapshot?.().access === 'unavailable') throw new Error('终端连接或访问身份已变化，请重新连接后再传输。');
  if (!path.startsWith('/') || /[\x00-\x1f\x7f-\x9f]/u.test(path) || !paths.length) throw new Error('请先读取有效目录并选择本地路径。');
  const base = { id: crypto.randomUUID(), terminalId, title, target: { ...terminalFileTarget(runtime, 0), path }, paths };
  if (remoteName === undefined) return base;
  const names = [...new Set(Array.isArray(remoteName) ? remoteName : [remoteName])];
  if (!names.length || names.some(name => !name || ['.', '..'].includes(name) || /[\x00-\x1f\x7f-\x9f/]/u.test(name))) throw new Error('请选择有效的远程文件或目录。');
  const remotePaths = names.map(name => `${path.replace(/\/+$/, '')}/${name}`);
  return { ...base, direction: 'DOWNLOAD', remotePath: remotePaths[0], remotePaths };
}

export function createTerminalUpload(runtime: TerminalRuntime, terminalId: string, title: string, paths: string[]): TerminalUploadRequest {
  if (runtime.closed || runtime.disconnected || runtime.manuallyClosed || runtime.transportAvailable === false) throw new Error('请先连接此 SSH 终端，再拖入文件。');
  const snapshot = runtime.directorySnapshot?.();
  const target = terminalFileTarget(runtime, 0);
  if (!target.path || snapshot?.access === 'unavailable') throw new Error('当前终端目录或访问身份尚未就绪，请等待目录同步后再拖入。');
  if (snapshot?.running) throw new Error('请等待终端命令结束、当前目录同步后再拖入文件。');
  const unique = [...new Set(paths.filter(path => !!path && !/[\x00-\x1f\x7f]/u.test(path) && (/^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\\\'))))];
  if (!unique.length) throw new Error('没有可上传的本地文件或文件夹。');
  return { id: crypto.randomUUID(), terminalId, title, target, paths: unique };
}

/** A confirmation belongs to one runtime/identity; changing the selected tab cannot redirect it. */
export function terminalUploadMatches(runtime: TerminalRuntime | undefined, request: TerminalTransferRequest, checkDirectory = false): boolean {
  if (!runtime || runtime.closed || runtime.disconnected || runtime.manuallyClosed || runtime.transportAvailable === false || runtime.sessionId !== request.target.terminalSessionId) return false;
  const target = terminalFileTarget(runtime, 0), snapshot = runtime.directorySnapshot?.();
  return snapshot?.access !== 'unavailable' && target.accessKey === request.target.accessKey
    && (!checkDirectory || (!snapshot?.running && target.path === request.target.path));
}

export async function runTerminalTransfer(request: TerminalTransferRequest, operations: {
  valid: () => boolean;
  connect: () => Promise<boolean>;
  transfer: (direction: 'UPLOAD' | 'DOWNLOAD', local: string, remote: string) => Promise<boolean>;
}): Promise<{ submitted: number; total: number }> {
  let submitted = 0;
  const direction = request.direction ?? 'UPLOAD';
  const jobs = request.direction === 'DOWNLOAD'
    ? (request.remotePaths ?? [request.remotePath]).flatMap(remote => request.paths.map(local => ({local, remote})))
    : request.paths.map(local => ({local, remote: request.target.path}));
  const total = jobs.length;
  if (!operations.valid() || !await operations.connect() || !operations.valid()) return { submitted, total };
  for (const job of jobs) {
    if (!operations.valid()) break;
    if (await operations.transfer(direction, job.local, job.remote)) submitted++;
  }
  return { submitted, total };
}

export function runTerminalUpload(request: TerminalUploadRequest, operations: {
  valid: () => boolean; connect: () => Promise<boolean>;
  upload: (path: string, destination: string) => Promise<boolean>;
}) {
  return runTerminalTransfer(request, { ...operations, transfer: (_direction, local, remote) => operations.upload(local, remote) });
}
