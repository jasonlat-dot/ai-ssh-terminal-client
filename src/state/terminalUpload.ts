import type { TerminalRuntime } from './terminalRuntime';
import { terminalFileTarget } from './terminalFileTarget';
import type { TerminalFileTarget } from './terminalFileTarget';

export type TerminalUploadRequest = { id: string; terminalId: string; title: string; target: TerminalFileTarget; paths: string[] };

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
export function terminalUploadMatches(runtime: TerminalRuntime | undefined, request: TerminalUploadRequest, checkDirectory = false): boolean {
  if (!runtime || runtime.closed || runtime.disconnected || runtime.manuallyClosed || runtime.transportAvailable === false || runtime.sessionId !== request.target.terminalSessionId) return false;
  const target = terminalFileTarget(runtime, 0), snapshot = runtime.directorySnapshot?.();
  return snapshot?.access !== 'unavailable' && target.accessKey === request.target.accessKey
    && (!checkDirectory || (!snapshot?.running && target.path === request.target.path));
}

export async function runTerminalUpload(request: TerminalUploadRequest, operations: {
  valid: () => boolean;
  connect: () => Promise<boolean>;
  upload: (path: string, destination: string) => Promise<boolean>;
}): Promise<{ submitted: number; total: number }> {
  let submitted = 0;
  if (!operations.valid() || !await operations.connect() || !operations.valid()) return { submitted, total: request.paths.length };
  for (const path of request.paths) {
    if (!operations.valid()) break;
    if (await operations.upload(path, request.target.path)) submitted++;
  }
  return { submitted, total: request.paths.length };
}
