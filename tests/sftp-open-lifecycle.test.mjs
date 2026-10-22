import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { remoteInitialPath } from '../src/state/sftp.ts';

// Exercise the production hook operations with deferred transport replies.
const source = ts.createSourceFile('useSftp.ts', readFileSync(new URL('../src/state/useSftp.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const operations = new Map();
let mount;
function scan(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('mounted.current = true')) mount = node.arguments[0].getText(source);
  if (ts.isVariableDeclaration(node) && ['loadRemote', 'open'].includes(node.name.getText(source))) {
    const initializer = node.initializer;
    operations.set(node.name.getText(source), ts.isCallExpression(initializer) ? initializer.arguments[0].getText(source) : initializer.getText(source));
  }
  ts.forEachChild(node, scan);
}
scan(source);
assert.equal(operations.size, 2);
assert.ok(mount);
const code = ts.transpileModule([...operations].map(([name, fn]) => `const ${name} = ${fn}; exports.${name} = ${name};`).join('\n') + `\nexports.mount = ${mount};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const errors = [], paths = [], states = [];
  let refreshed = 0;
  const session = { sftpSessionId: 'current', rootPath: '/srv' };
  const context = vm.createContext({ exports: {}, connectionId: 'ssh', phase: 'idle', remoteInitialPath, queueMicrotask, console, loadLocal: async () => {},
    remoteVersion: { current: 0 }, generation: { current: 0 }, mounted: { current: true }, sessionRef: { current: null },
    setPhase: value => states.push(value), setError() {}, setSession() {}, setRemotePath: value => paths.push(value),
    setTasks() {}, setTaskErrors() {}, setLocalBytes() {}, setEntries() {}, setRemoteLoading() {}, receive() {},
    fail: error => errors.push(error), refreshTasks: async () => { refreshed++; },
    sftpApi: { open: async () => session, close: async () => {}, entries: async (_id, path) => { paths.push(`request:${path}`); return []; } },
  });
  vm.runInContext(code, context);
  return { context, session, errors, paths, states, refreshed: () => refreshed };
}

test('opening at terminal cwd falls back to the selected root when cwd is outside its scope', async () => {
  const ui = harness();
  assert.equal(await ui.context.exports.open('/srv', 'login', undefined, 'terminal', '/root/project'), true);
  assert.ok(ui.paths.includes('request:/srv'));
  assert.equal(ui.paths.includes('request:/root/project'), false);
});

test('identity expiry during initial directory loading cannot report an open success', async () => {
  const ui = harness();
  ui.context.sftpApi.entries = async () => { throw new Error('identity revoked'); };
  ui.context.fail = error => { ui.errors.push(error); ui.context.sessionRef.current = null; ui.context.generation.current++; };
  assert.equal(await ui.context.exports.open('/', 'login', undefined, 'terminal', '/srv'), false);
  assert.equal(ui.errors.length, 1);
  assert.equal(ui.refreshed(), 0);
});

test('a late directory error from the previous file session cannot expire the new session', async () => {
  const ui = harness();
  let reject;
  ui.context.sessionRef.current = ui.session;
  ui.context.sftpApi.entries = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = ui.context.exports.loadRemote('/srv', ui.session);
  const replacement = { sftpSessionId: 'replacement', rootPath: '/' };
  ui.context.sessionRef.current = replacement;
  reject(new Error('old session expired'));
  await pending;
  assert.equal(ui.errors.length, 0);
  assert.equal(ui.context.sessionRef.current, replacement);
});

test('StrictMode effect cleanup and replay preserve the one automatic connection', async () => {
  const ui = harness();
  let resolve;
  const closed = [];
  ui.context.sftpApi.open = () => new Promise(done => { resolve = done; });
  ui.context.sftpApi.close = async id => { closed.push(id); };
  const cleanup = ui.context.exports.mount();
  const pending = ui.context.exports.open('/', 'login', undefined, 'terminal', '/srv');
  cleanup();
  const unmount = ui.context.exports.mount();
  resolve(ui.session);
  assert.equal(await pending, true);
  assert.equal(ui.states.at(-1), 'ready');
  assert.equal(ui.context.sessionRef.current, ui.session);
  assert.deepEqual(closed, []);
  unmount();
  await Promise.resolve();
  assert.deepEqual(closed, ['current']);
});

test('real unmount still releases a file connection that completes late', async () => {
  const ui = harness();
  let resolve;
  const closed = [];
  ui.context.sftpApi.open = () => new Promise(done => { resolve = done; });
  ui.context.sftpApi.close = async id => { closed.push(id); };
  const cleanup = ui.context.exports.mount();
  const pending = ui.context.exports.open('/');
  cleanup();
  resolve(ui.session);
  assert.equal(await pending, false);
  assert.equal(ui.context.sessionRef.current, null);
  assert.deepEqual(closed, ['current']);
});
