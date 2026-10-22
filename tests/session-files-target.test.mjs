import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const source = ts.createSourceFile('Sidebar.tsx', readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('handledTarget.current')) effect = node.arguments[0].getText(source);
  ts.forEachChild(node, visit);
}
visit(source); assert.ok(effect);
const code = ts.transpileModule(`exports.apply = ${effect}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(patch = {}) {
  const opened = [], navigated = [], notices = [];
  const context = vm.createContext({ exports: {}, visible: true, uploadRequest: undefined,
    target: { terminalSessionId: 'root-terminal', path: '/root/project', accessKey: 'root-one', revision: 1 },
    handledTarget: { current: 0 }, openedTarget: { current: undefined }, activeTransfers: 0, ready: false,
    files: { phase: 'idle', working: false, open: async (...args) => { opened.push(args); }, loadRemote: async path => { navigated.push(path); } },
    notify: message => notices.push(message), setRoot() {}, setTerminalAccess() {}, setAccessEditing() {}, setSudoPassword() {}, setRemoteSelected() {}, ...patch });
  vm.runInContext(code, context);
  return { context, opened, navigated, notices, apply() { context.exports.apply(); } };
}
test('任一入口打开后自动复用当前终端，根范围与初始目录分开，不索取 sudo 密码', () => {
  const ui = harness(); ui.apply(); ui.apply();
  assert.equal(ui.opened.length, 1);
  assert.deepEqual(ui.opened[0], ['/', 'login', undefined, 'root-terminal', '/root/project']);
});
test('重新打开同身份文件窗口定位最新目录，浏览不受之前打开目录限制', () => {
  const ui = harness({ ready: true });
  ui.context.files.session = { rootPath: '/' }; ui.context.files.phase = 'ready';
  ui.context.openedTarget.current = { ...ui.context.target, path: '/root/old', revision: 0 };
  ui.apply(); assert.deepEqual(ui.navigated, ['/root/project']); assert.equal(ui.opened.length, 0);
});
test('切换终端、root 身份或重连时重新绑定，不复用同服务器的旧权限', () => {
  for (const previous of [{ terminalSessionId: 'other' }, { accessKey: 'login' }]) {
    const ui = harness({ ready: true }); ui.context.files.phase = 'ready'; ui.context.files.session = { rootPath: '/' };
    ui.context.openedTarget.current = { ...ui.context.target, ...previous };
    ui.apply(); assert.equal(ui.opened.length, 1); assert.equal(ui.navigated.length, 0);
  }
});
test('传输期间保留会话和目录，重复渲染不反复弹提示；打开中等待完成', () => {
  const ui = harness({ activeTransfers: 1 }); ui.apply(); ui.apply();
  assert.equal(ui.opened.length, 0); assert.equal(ui.notices.length, 1);
  const pending = harness(); pending.context.files.phase = 'opening'; pending.apply();
  assert.equal(pending.opened.length, 0); assert.equal(pending.context.handledTarget.current, 0);
  pending.context.files.phase = 'closed'; pending.apply(); assert.equal(pending.opened.length, 1);
});
test('目录未知时只采用登录默认目录，窗口隐藏时不触发连接', () => {
  const ui = harness({ target: { terminalSessionId: 'login-terminal', path: '', accessKey: '', revision: 1 } }); ui.apply();
  assert.deepEqual(ui.opened[0], ['', 'login', undefined, 'login-terminal', '']);
  const hidden = harness({ visible: false }); hidden.apply(); assert.equal(hidden.opened.length, 0);
});

test('文件·SFTP 和侧栏管理与传输都用同一个当前终端入口', () => {
  const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = new Map();
  function scan(node) {
    if (ts.isJsxAttribute(node) && ['openFiles', 'toggleFiles'].includes(node.name.getText(app)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      callbacks.set(node.name.getText(app), node.initializer.expression.getText(app));
    }
    ts.forEachChild(node, scan);
  }
  scan(app); assert.equal(callbacks.size, 2);
  const calls = [], active = { id: 'terminal-one', kind: 'ssh', connectionId: 'same-wsl', title: 'wsl' };
  const context = vm.createContext({ active, visibleFiles: '', openFiles: terminal => calls.push(terminal), setVisibleFiles() {}, exports: {} });
  const code = [...callbacks].map(([name, callback]) => `exports.${name}=${callback};`).join('\n');
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.exports.openFiles(); context.exports.toggleFiles();
  assert.deepEqual(calls, [active, active]);
});
