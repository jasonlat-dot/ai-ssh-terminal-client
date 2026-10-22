import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('useSftp.ts', readFileSync(new URL('../src/state/useSftp.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const operations = new Map();
function scan(node) {
  if (ts.isVariableDeclaration(node) && ['expireSession', 'fail', 'refreshTasks', 'receive'].includes(node.name.getText(source))) {
    operations.set(node.name.getText(source), node.initializer.arguments[0].getText(source));
  }
  ts.forEachChild(node, scan);
}
scan(source);
assert.equal(operations.size, 4);
const code = ts.transpileModule([...operations].map(([name, fn]) => `const ${name} = ${fn}; exports.${name} = ${name};`).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
class SftpError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
function harness() {
  const values = {}, closed = [];
  const context = { exports: {}, Error, SftpError,
    sessionRef: { current: { sftpSessionId: 'old-root' } }, generation: { current: 1 }, mounted: { current: true },
    workLock: { current: false }, refreshAgain: { current: false }, refreshPending: { current: false }, tasksRef: { current: [] },
    sftpApi: { close: async id => { closed.push(id); }, tasks: async () => [] },
  };
  for (const name of ['Session', 'Phase', 'Connection', 'RemotePath', 'Entries', 'Tasks', 'TaskErrors', 'Scanning', 'Working', 'RemoteLoading', 'Error', 'LocalBytes']) {
    context[`set${name}`] = value => { values[name] = value; };
  }
  vm.createContext(context); vm.runInContext(code, context);
  return { context, values, closed };
}
const message = '终端访问身份已切换，重新打开文件管理即可使用当前身份';

test('identity change events clear old root state without a global error', () => {
  const ui = harness();
  ui.context.exports.receive({ type: 'session-closed', data: { code: 'SFTP_IDENTITY_CHANGED', message } });
  assert.equal(ui.values.Error, '');
  assert.equal(ui.values.Connection, message);
  assert.equal(ui.values.Phase, 'closed');
  assert.equal(ui.values.RemotePath, '');
  assert.equal(ui.values.Entries.length, 0);
  assert.equal(ui.context.sessionRef.current, null);
  assert.deepEqual(ui.closed, ['old-root']);
});

test('an in-flight operation revoked by identity change is also quiet', () => {
  const ui = harness();
  ui.context.exports.fail(new SftpError('SFTP_IDENTITY_CHANGED', message));
  assert.equal(ui.values.Error, '');
  assert.equal(ui.values.Phase, 'closed');
});

test('rapidly closing two terminal tabs quietly expires each bound file session', () => {
  const first = harness(), second = harness();
  first.context.sessionRef.current.sftpSessionId = 'files-first';
  second.context.sessionRef.current.sftpSessionId = 'files-second';
  first.context.exports.receive({ type: 'session-closed', data: { code: 'SFTP_TERMINAL_CLOSED', message: '当前终端已关闭，关联的文件会话已结束' } });
  assert.equal(first.values.Error, '');
  assert.equal(first.context.sessionRef.current, null);
  assert.ok(second.context.sessionRef.current, 'closing the first tab cannot clear the second file session');
  second.context.exports.fail(new SftpError('SFTP_TERMINAL_CLOSED', '当前终端已关闭，关联的文件会话已结束'));
  assert.equal(second.values.Error, '');
  assert.equal(second.values.Phase, 'closed');
  assert.equal(second.context.sessionRef.current, null);
  assert.deepEqual(first.closed, ['files-first']);
  assert.deepEqual(second.closed, ['files-second']);
});

test('missing files, permission errors and real session expiry still surface errors', () => {
  for (const [code, text, status] of [['SFTP_NOT_FOUND', '文件不存在', 404], ['SFTP_FORBIDDEN', '无权读取', 403], ['SFTP_SESSION_EXPIRED', '工作区会话已失效', 404]]) {
    const ui = harness(); ui.context.exports.fail(new SftpError(code, text, status));
    assert.equal(ui.values.Error, text);
  }
  const ui = harness();
  ui.context.exports.receive({ type: 'session-closed', data: { message: '文件管理会话异常结束' } });
  assert.equal(ui.values.Error, '文件管理会话异常结束');
});

test('a late task refresh cannot report the revoked session against a replacement', async () => {
  const ui = harness();
  let reject;
  ui.context.sftpApi.tasks = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = ui.context.exports.refreshTasks();
  const replacement = { sftpSessionId: 'current-login' };
  ui.context.sessionRef.current = replacement;
  reject(new SftpError('SFTP_NOT_FOUND', '连接、会话、任务或文件不存在', 404));
  await pending;
  assert.equal(ui.values.Error, undefined);
  assert.equal(ui.context.sessionRef.current, replacement);
});
