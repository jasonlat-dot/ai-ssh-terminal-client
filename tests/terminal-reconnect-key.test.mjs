import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const file = ts.createSourceFile('RemoteTerminalView.tsx', readFileSync(new URL('../src/components/RemoteTerminalView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expressions = new Map(); let focusEffect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['handleTerminalKeyDown', 'reconnectNow', 'unavailableMessage'].includes(node.name.getText(file))) expressions.set(node.name.getText(file), node.initializer.getText(file));
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.arguments[0]?.getText(file).includes('A disconnected terminal still needs focus')) focusEffect = node.arguments[0].getText(file);
  ts.forEachChild(node, visit);
}
visit(file); assert.equal(expressions.size, 3); assert.ok(focusEffect);
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const code = compile(`const reconnectNow = ${expressions.get('reconnectNow')}; exports.key = ${expressions.get('handleTerminalKeyDown')}; exports.focus = ${focusEffect}; exports.message = ${expressions.get('unavailableMessage')};`);
class Target { constructor(terminal = true) { this.terminal = terminal; } closest() { return this.terminal ? this : null; } }
function harness(patch = {}) {
  let settle; const attempts = [], states = [], cleared = [], focused = [], body = { matches: () => false };
  const pane = { contains: target => target?.inside === true }, element = { current: { closest: () => pane } };
  const context = vm.createContext({ exports: {}, Element: Target, selectionAction: null, setSelectionAction: value => cleared.push(value),
    local: false, sessionUnavailable: true, visible: true, focused: true, isReconnecting: false, manuallyClosed: false,
    reconnectingRef: { current: false }, reconnectGeneration: { current: 0 }, setLocalReconnecting: value => states.push(value),
    reconnect: options => { attempts.push(options); return new Promise((resolve, reject) => { settle = { resolve, reject }; }); },
    attempt: 1, error: '', disconnectReason: 'CLIENT_CLOSED', reconnectAllowed: false,
    terminalDisconnectMessage: () => '终端连接已关闭。', unavailable: true, element,
    document: { body, activeElement: body }, term: { current: { focus: () => focused.push(true) } }, ...patch,
  });
  vm.runInContext(code, context);
  return { context, attempts, states, cleared, focused, message: context.exports.message,
    resolve(value) { settle.resolve(value); }, reject() { settle.reject(new Error('failed')); },
    key(patch = {}) { let prevented = 0, stopped = 0; context.exports.key({ key: 'Enter', target: new Target(), repeat: false, ctrlKey: false, metaKey: false, altKey: false,
      nativeEvent: { isComposing: false }, isDefaultPrevented: () => false, preventDefault: () => prevented++, stopPropagation: () => stopped++, ...patch }); return { prevented, stopped }; },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('断开的 SSH 终端按键立即发起一次手动重连并消费按键，连按和长按不重复', async () => {
  const ui = harness({ manuallyClosed: true });
  assert.deepEqual(ui.key({ key: 'a' }), { prevented: 1, stopped: 1 });
  ui.key(); ui.key({ repeat: true }); assert.equal(ui.attempts.length, 1);
  assert.equal(ui.attempts[0].automatic, false); assert.equal(ui.context.reconnectingRef.current, true);
  ui.resolve(true); await flush(); assert.equal(ui.context.reconnectingRef.current, false);
  const repeat = harness(); repeat.key({ repeat: true }); assert.equal(repeat.attempts.length, 0);
});

test('重连失败和取消回执解除互斥，下一次独立按键可再次尝试', async () => {
  for (const failure of ['false', 'reject']) {
    const ui = harness(); ui.key(); if (failure === 'false') ui.resolve(false); else ui.reject(); await flush();
    assert.equal(ui.context.reconnectingRef.current, false); assert.deepEqual(ui.states, [true, false]);
    ui.key({ key: ' ' }); assert.equal(ui.attempts.length, 2); ui.resolve(false); await flush();
  }
});

test('仅当前可见断线 SSH 的 xterm 接收重连键，其他窗格、聊天和本地终端不受影响', () => {
  for (const patch of [{ local: true }, { sessionUnavailable: false }, { visible: false }, { focused: false }]) {
    const ui = harness(patch); assert.deepEqual(ui.key(), { prevented: 0, stopped: 0 }); assert.equal(ui.attempts.length, 0);
  }
  const ui = harness(); assert.deepEqual(ui.key({ target: new Target(false) }), { prevented: 0, stopped: 0 });
  assert.deepEqual(ui.key({ target: {} }), { prevented: 0, stopped: 0 }); assert.equal(ui.attempts.length, 0);
  const pending = harness({ isReconnecting: true }); assert.deepEqual(pending.key(), { prevented: 1, stopped: 1 }); assert.equal(pending.attempts.length, 0);
});

test('复制/粘贴等组合键、修饰键、Tab、Escape 和输入法组合不触发重连', () => {
  const ui = harness();
  for (const patch of [{ key: 'c', ctrlKey: true }, { key: 'v', metaKey: true }, { key: 'x', altKey: true },
    ...['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape', 'Dead', 'Process', 'Unidentified'].map(key => ({ key })),
    { nativeEvent: { isComposing: true } }, { isDefaultPrevented: () => true }]) assert.deepEqual(ui.key(patch), { prevented: 0, stopped: 0 });
  assert.equal(ui.attempts.length, 0);
  const selected = harness({ selectionAction: { text: 'buffer' } }); assert.deepEqual(selected.key({ key: 'Escape' }), { prevented: 1, stopped: 1 });
  assert.deepEqual(selected.cleared, [null]); assert.equal(selected.attempts.length, 0);
});

test('断线提示包含按任意键引导，重连期间显示进度，本地关闭不显示 SSH 重连引导', () => {
  assert.match(harness().message, /终端连接已关闭。.*在终端内按任意键重新连接/);
  assert.match(harness({ error: '连接失败' }).message, /连接失败.*按任意键/);
  assert.match(harness({ isReconnecting: true, attempt: 2 }).message, /第 2 次连接/);
  assert.doesNotMatch(harness({ isReconnecting: true }).message, /任意键/);
  assert.doesNotMatch(harness({ local: true }).message, /任意键/);
});

test('断线终端可获得重连按键焦点，聊天输入、其他窗格和终端内控件不会被抢焦点', () => {
  const ui = harness(); ui.context.exports.focus(); assert.equal(ui.focused.length, 1);
  for (const control of [{ matches: () => true, inside: false }, { matches: () => true, inside: true }]) {
    const protectedUi = harness(); protectedUi.context.document.activeElement = control; protectedUi.context.exports.focus(); assert.equal(protectedUi.focused.length, 0);
  }
  for (const patch of [{ visible: false }, { focused: false }]) { const hidden = harness(patch); hidden.context.exports.focus(); assert.equal(hidden.focused.length, 0); }
});
