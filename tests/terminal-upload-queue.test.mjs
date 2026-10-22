import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createTerminalUpload, terminalUploadMatches, runTerminalUpload } from '../src/state/terminalUpload.ts';

const parse = name => ts.createSourceFile(name, readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const sidebar = parse('components/Sidebar.tsx');
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(sidebar) === 'useEffect' && node.arguments[0]?.getText(sidebar).includes('runTerminalUpload(')) effect = node.arguments[0].getText(sidebar);
  ts.forEachChild(node, visit);
}
visit(sidebar); assert.ok(effect);
function harness(patch = {}) {
  const opened = [], uploaded = [], navigated = [], handled = [], notices = [];
  const target = { terminalSessionId: 'ssh-one', path: '/root/project', accessKey: 'root-one', revision: 4 };
  const context = vm.createContext({ exports: {}, Error, runTerminalUpload, target,
    uploadRequest: { id: 'drop-one', target, paths: ['C:\\a.txt', 'C:\\folder'] },
    claimedUpload: { current: '' }, handledTarget: { current: 0 }, openedTarget: { current: undefined },
    uploadMounted: { current: true }, activeTransfers: 0, ready: false,
    uploadCallbacks: { current: { validateUpload: () => true, uploadHandled: id => handled.push(id), notify: (...args) => notices.push(args) } },
    files: { phase: 'idle', working: false, open: async (...args) => { opened.push(args); return true; },
      loadRemote: async path => { navigated.push(path); }, transfer: async (...args) => { uploaded.push(args); return true; } },
    setTransfersOpen() {}, setAccessEditing() {}, setTerminalAccess() {}, setRoot() {}, setSudoPassword() {}, setConflict() {}, ...patch });
  vm.runInContext(compile(`exports.apply = ${effect};`), context);
  return { context, opened, uploaded, navigated, handled, notices, apply: () => context.exports.apply(), async flush() { await new Promise(resolve => setImmediate(resolve)); } };
}

test('confirmed drop uses the existing SFTP controller and queue, with no repeat on effect replay', async () => {
  const ui = harness(); ui.apply(); ui.apply(); await ui.flush(); ui.apply();
  assert.deepEqual(ui.opened, [['/', 'login', undefined, 'ssh-one', '/root/project']]);
  assert.deepEqual(ui.uploaded, [['UPLOAD', 'C:\\a.txt', '/root/project', 'FAIL'], ['UPLOAD', 'C:\\folder', '/root/project', 'FAIL']]);
  assert.deepEqual(ui.handled, ['drop-one']);
  assert.equal(ui.context.handledTarget.current, 4, 'normal open cannot replace the upload session');
});

test('a compatible file session retains its task history and accepts uploads without reconnecting', async () => {
  const ui = harness({ ready: true, activeTransfers: 1 });
  ui.context.files.phase = 'ready'; ui.context.files.session = { rootPath: '/' };
  ui.context.openedTarget.current = { ...ui.context.target };
  ui.apply(); await ui.flush();
  assert.equal(ui.opened.length, 0); assert.deepEqual(ui.navigated, ['/root/project']); assert.equal(ui.uploaded.length, 2);
});

test('busy independent identity is not replaced; a waiting drop starts only once it is idle', async () => {
  const ui = harness({ ready: true, activeTransfers: 1 });
  ui.context.files.phase = 'ready'; ui.context.files.session = { rootPath: '/home/user' };
  ui.apply(); await ui.flush(); assert.equal(ui.opened.length, 0); assert.equal(ui.uploaded.length, 0);
  ui.context.activeTransfers = 0; ui.apply(); await ui.flush(); assert.equal(ui.opened.length, 1); assert.equal(ui.uploaded.length, 2);
});

test('queued drops use individual confirmed destinations and cannot borrow a revoked identity', async () => {
  const ui = harness(); ui.apply(); await ui.flush();
  ui.context.uploadRequest = { ...ui.context.uploadRequest, id: 'drop-two', target: { ...ui.context.target, path: '/root/next' }, paths: ['D:\\b.txt'] };
  ui.context.uploadCallbacks.current.validateUpload = () => false;
  ui.apply(); await ui.flush();
  assert.equal(ui.uploaded.length, 2); assert.deepEqual(ui.handled, ['drop-one', 'drop-two']);
});

test('App only creates an upload request after confirmation, keeping multiple approved drops queued', () => {
  const app = parse('App.tsx'), operations = [];
  function scan(node) {
    if (ts.isVariableDeclaration(node) && ['requestTerminalUpload', 'confirmTerminalUpload'].includes(node.name.getText(app))) operations.push(`exports.${node.name.getText(app)} = ${node.initializer.getText(app)};`);
    ts.forEachChild(node, scan);
  }
  scan(app); assert.equal(operations.length, 2);
  const directory = { path: '/root/project', accessKey: 'root-one', access: 'root' };
  const runtime = { sessionId: 'ssh-one', connectionId: 'wsl', directorySnapshot: () => directory };
  let windows = [], notices = [];
  const context = vm.createContext({ exports: {}, Error, terminalUpload: null, createTerminalUpload, terminalUploadMatches,
    terminalClients: { current: new Map([['tab-one', runtime]]) }, fileOpenRevision: { current: 0 },
    setTerminalUpload: value => { context.terminalUpload = value; }, setFileWindows: update => { windows = update(windows); }, setVisibleFiles() {}, notify: (...args) => notices.push(args) });
  vm.runInContext(compile(operations.join('\n')), context);
  const terminal = { id: 'tab-one', kind: 'ssh', title: 'WSL', connectionId: 'wsl' };
  context.exports.requestTerminalUpload(terminal, ['C:\\a.txt']); assert.equal(windows.length, 0);
  context.exports.confirmTerminalUpload(); assert.equal(windows[0].uploadRequests.length, 1);
  context.exports.requestTerminalUpload(terminal, ['C:\\b.txt']); context.exports.confirmTerminalUpload();
  assert.equal(windows[0].uploadRequests.length, 2);
  context.exports.requestTerminalUpload(terminal, ['C:\\c.txt']); directory.path = '/root/changed'; context.exports.confirmTerminalUpload();
  assert.equal(windows[0].uploadRequests.length, 2); assert.equal(notices.length, 1);
});
