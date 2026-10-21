import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createTerminalActions } from '../src/state/terminalActions.ts';

const source = name => ts.createSourceFile(name, readFileSync(new URL('../src/components/' + name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(file, predicate) {
  let result;
  function visit(node) { if (predicate(node)) result = node; ts.forEachChild(node, visit); }
  visit(file); assert.ok(result); return result;
}
function evaluate(code, globals = {}) {
  const context = vm.createContext({ exports: {}, ...globals });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context;
}
const remote = source('RemoteTerminalView.tsx');
const variable = name => find(remote, n => ts.isVariableDeclaration(n) && n.name.getText(remote) === name).initializer.getText(remote);
const registration = find(remote, n => ts.isCallExpression(n) && n.expression.getText(remote) === 'useTerminalTarget');
function terminal(patch = {}) {
  const calls = [], terminal = { focus: () => calls.push('focus') };
  const context = evaluate(`const pasteShortcut = ${variable('pasteShortcut')}; exports.target = ${registration.arguments[1].getText(remote)}; exports.enabled = ${registration.arguments[0].getText(remote)};`, {
    completionStatus:'未初始化',completionPrefs:{enabled:false,modelId:''},setCompletionSetup:()=>calls.push('completion'),
    title: '凯平哥', local: false, visible: true, focused: true, fontSize: 13, hasSelection: true, canAddToAgent: true,
    unavailable: false, isReconnecting: false, canCancelConnection: false, sessionUnavailable: false,
    copyShortcut: 'Ctrl+C', isMac: false, term: { current: terminal }, fontSizeRef: { current: 13 },
    copySelection: async () => { calls.push('copy'); }, pasteClipboard: async () => { calls.push('paste'); },
    addSelectionToAgent: () => calls.push('add'), cancelReconnect: () => calls.push('cancel'),
    reconnectNow: async () => { calls.push('reconnect'); }, disconnect: () => calls.push('disconnect'), ...patch,
  });
  return { ...context.exports, calls, context, command(id) { return context.exports.target.commands.find(item => item.id === id); } };
}

test('菜单只执行当前所有者；旧窗格清理、旧菜单与禁用动作不能影响新终端', () => {
  const store = createTerminalActions(), first = {}, second = {}, calls = [];
  let changes = 0; const stop = store.subscribe(() => changes++);
  const target = (owner, label, disabled = false) => ({ owner, title: label, fontSize: 13,
    commands: [{ id: 'paste', label, group: 'clipboard', disabled, run: () => calls.push(label) }] });
  assert.equal(store.getSnapshot(), null);
  store.publish(target(first, 'first')); assert.equal(store.run(first, 'paste'), true);
  store.publish(target(second, 'second')); store.clear(first);
  assert.equal(store.getSnapshot().owner, second); assert.equal(store.run(first, 'paste'), false);
  store.publish(target(second, 'disabled', true)); assert.equal(store.run(second, 'paste'), false);
  assert.equal(store.run(second, 'unknown'), false);
  store.publish(target(second, 'updated')); store.run(second, 'paste');
  store.clear(second); assert.equal(store.run(second, 'paste'), false); assert.equal(store.getSnapshot(), null);
  assert.deepEqual(calls, ['first', 'updated']); assert.equal(changes, 5);
  stop(); store.publish(target(first, 'last')); assert.equal(changes, 5);
});

test('活动可见窗格提供名称和真实操作；本地终端没有 SSH 重连项', async () => {
  const ui = terminal(); assert.equal(ui.enabled, true); assert.equal(ui.target.title, '凯平哥');
  for (const id of ['copy', 'paste', 'add', 'reconnect', 'disconnect']) await ui.command(id).run();
  assert.deepEqual(ui.calls.filter(item => item !== 'focus'), ['copy', 'paste', 'add', 'reconnect', 'disconnect']);
  assert.equal(terminal({ visible: false }).enabled, false); assert.equal(terminal({ focused: false }).enabled, false);
  const local = terminal({ local: true, title: '' });
  assert.equal(local.target.title, '本地终端'); assert.equal(local.command('reconnect'), undefined);
  assert.equal(local.command('disconnect').label, '关闭终端');
});

test('无选区、对话忙碌、离线与重连状态正确禁用或替换操作', () => {
  const empty = terminal({ hasSelection: false }); assert.equal(empty.command('copy').disabled, true); assert.equal(empty.command('add').disabled, true);
  const busy = terminal({ canAddToAgent: false }); assert.equal(busy.command('copy').disabled, false); assert.equal(busy.command('add').disabled, true);
  const offline = terminal({ unavailable: true, sessionUnavailable: true });
  assert.equal(offline.command('paste').disabled, true); assert.equal(offline.command('copy').disabled, false);
  assert.equal(offline.command('disconnect').label, '关闭页签');
  assert.equal(terminal({ isReconnecting: true }).command('reconnect').disabled, true);
  const cancelling = terminal({ isReconnecting: true, canCancelConnection: true });
  assert.equal(cancelling.command('reconnect'), undefined); cancelling.command('cancel').run(); assert.deepEqual(cancelling.calls, ['cancel']);
});

test('菜单只保留当前字号信息和粘贴平台快捷键，不提供字号操作命令', () => {
  const ui = terminal({ fontSize: 14 }); assert.equal(ui.target.fontSize, 14);
  assert.equal(ui.command('paste').shortcut, 'Ctrl+V');
  assert.equal(terminal({ isMac: true }).command('paste').shortcut, '⌘V');
  assert.equal(ui.target.commands.some(command => command.group === 'font'), false);
});

test('剪贴板异步读取后切换窗格、运行时或离线，不向旧终端粘贴或弹出兜底框', async () => {
  for (const failure of [false, true]) for (const change of ['focus', 'runtime', 'offline', 'hidden', 'disposed', 'none']) {
    let finish; const pastes = [], fallback = [], original = {};
    const context = evaluate(`exports.paste = ${variable('pasteClipboard')};`, {
      term: { current: original }, activeRuntime: { current: {} }, allowInput: { current: true }, visibleRef: { current: true }, focusedRef: { current: true },
      readClipboardText: () => new Promise((resolve, reject) => { finish = () => failure ? reject(new Error('denied')) : resolve('echo hello'); }),
      pasteText: text => pastes.push(text), clearFeedback() {}, setPasteFallback: value => fallback.push(value),
    });
    const pending = context.exports.paste();
    if (change === 'focus') context.focusedRef.current = false;
    if (change === 'runtime') context.activeRuntime.current = {};
    if (change === 'offline') context.allowInput.current = false;
    if (change === 'hidden') context.visibleRef.current = false;
    if (change === 'disposed') context.term.current = null;
    finish(); await pending;
    assert.equal(pastes.length, change === 'none' && !failure ? 1 : 0, change);
    assert.equal(fallback.length, change === 'none' && failure ? 1 : 0, change);
  }
});

test('菜单方向键循环并支持 Home/End；Escape 关闭恢复焦点，Tab 正常离开', () => {
  const file = source('TerminalMenu.tsx');
  const navigate = find(file, n => ts.isVariableDeclaration(n) && n.name.getText(file) === 'navigate').initializer.getText(file);
  const doc = { activeElement: null }, focused = [], closed = [];
  const buttons = [0, 1, 2].map(index => ({ focus() { focused.push(index); doc.activeElement = this; } }));
  const context = evaluate(`exports.navigate = ${navigate};`, { document: doc, items: () => buttons, close: restore => closed.push(restore) });
  const key = value => { let prevented = false, stopped = false; context.exports.navigate({ key: value, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }); return { prevented, stopped }; };
  key('ArrowDown'); key('ArrowUp'); key('Home'); key('End'); key('ArrowDown');
  assert.deepEqual(focused, [0, 2, 0, 2, 0]);
  assert.deepEqual(key('Escape'), { prevented: true, stopped: true }); assert.equal(closed[0], true);
  assert.deepEqual(key('Tab'), { prevented: false, stopped: false }); assert.equal(closed.length, 2); assert.equal(closed[1], true);
  assert.deepEqual(key('c'), { prevented: false, stopped: false });
});


test('补全重试仅 SSH 可用，本地候选无需模型，离线时禁用',()=>{
  assert.equal(terminal().command('completion').disabled,true);
  assert.equal(terminal({completionPrefs:{enabled:true,modelId:''}}).command('completion').disabled,false);
  const configured=terminal({completionPrefs:{enabled:true,modelId:'model'}});
  assert.equal(configured.command('completion').disabled,false);configured.command('completion').run();assert.deepEqual(configured.calls,['completion']);
  assert.equal(terminal({completionPrefs:{enabled:true,modelId:'model'},unavailable:true}).command('completion').disabled,true);
  assert.equal(terminal({local:true}).command('completion'),undefined);
});
