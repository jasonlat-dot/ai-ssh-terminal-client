import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFileTarget } from '../src/state/terminalFileTarget';
import type { TerminalRuntime } from '../src/state/terminalRuntime';

test('文件入口取对应终端的当前目录与身份，重连和同服务器其他终端互不混用', () => {
  const runtime = (sessionId: string, path: string, accessKey: string) => ({ sessionId,
    directorySnapshot: () => ({ path, accessKey, revision: 1 }) }) as TerminalRuntime;
  assert.deepEqual(terminalFileTarget(runtime('one', '/root/project', 'root-bridge'), 5), {
    terminalSessionId: 'one', path: '/root/project', accessKey: 'root-bridge', revision: 5 });
  assert.equal(terminalFileTarget(runtime('two', '/home/user', 'login'), 6).path, '/home/user');
  assert.equal(terminalFileTarget(runtime('reconnected', '/root/docs', 'new-root'), 7).terminalSessionId, 'reconnected');
  assert.equal(terminalFileTarget(runtime('one', '/bad\npath', ''), 8).path, '');
  assert.equal(terminalFileTarget({ sessionId: 'old' } as TerminalRuntime, 9).path, '');
});
