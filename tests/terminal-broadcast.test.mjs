import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function load(path, requireModule = () => { throw new Error('Unexpected import'); }, globals = {}) {
  const compiled = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, Error, ...globals });
  vm.runInContext(compiled, context); return context.exports;
}
const backend = load('config/backend.ts');
const sessionModel = load('state/terminalSessions.ts', name => {
  if (name === '../config/backend') return backend;
  throw new Error(name);
});
const model = load('state/terminalBroadcast.ts', name => {
  if (name === './terminalSessions') return sessionModel;
  throw new Error(name);
});
const plain = value => JSON.parse(JSON.stringify(value));
function fixtures() {
  const sessions = ['a', 'b', 'c'].map((id, index) => ({ id, title: `终端 ${id}`, kind: index ? 'ssh' : 'local',
    terminalSessionId: `runtime-${id}`, connected: true, connectionStatus: 'connected', manuallyClosed: false, busy: false }));
  const calls = [];
  const clients = new Map(sessions.map(session => [session.id, { sessionId: session.terminalSessionId,
    closed: false, disconnected: false, manuallyClosed: false, transportAvailable: true,
    exec: async command => { calls.push([session.id, command]); } }]));
  const resolve = (mode, selected = [], activeId = 'b') => model.resolveTerminalCommandTargets(sessions, clients, mode, activeId, selected);
  return { sessions, clients, calls, resolve };
}
const ids = plan => Array.from(plan.targets, item => item.id);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('默认只发送当前终端；全部包含隐藏页签；勾选去重且空选区不回退', () => {
  const f = fixtures();
  assert.deepEqual(ids(f.resolve('single')), ['b']);
  assert.deepEqual(ids(f.resolve('all')), ['a', 'b', 'c']);
  assert.deepEqual(ids(f.resolve('selected', ['c', 'c', 'a', 'missing'])), ['a', 'c']);
  assert.deepEqual(ids(f.resolve('selected')), []);
  assert.deepEqual(ids(f.resolve('single', [], 'missing')), []);
});

test('失联、关闭、忙碌、无传输或运行时 ID 不匹配的会话只跳过', () => {
  const mutations = [
    (session) => { session.connected = false; },
    (session) => { session.connectionStatus = 'unreachable'; },
    (session) => { session.manuallyClosed = true; },
    (session) => { session.busy = true; },
    (_session, runtime) => { runtime.closed = true; },
    (_session, runtime) => { runtime.disconnected = true; },
    (_session, runtime) => { runtime.manuallyClosed = true; },
    (_session, runtime) => { runtime.transportAvailable = false; },
    (_session, runtime) => { runtime.sessionId = 'old'; },
  ];
  for (const mutate of mutations) {
    const f = fixtures(); mutate(f.sessions[1], f.clients.get('b'));
    const plan = f.resolve('all');
    assert.deepEqual(ids(plan), ['a', 'c']);
    assert.equal(plan.skipped[0].id, 'b'); assert.equal(plan.skipped[0].status, 'skipped');
  }
  const f = fixtures(); f.clients.delete('b'); assert.deepEqual(ids(f.resolve('all')), ['a', 'c']);
});

test('各目标并行提交原始命令、独立报告结果；单个失败不影响其他目标也不重试', async () => {
  const f = fixtures(), gates = [deferred(), deferred()], locks = new Map(), busy = [];
  f.clients.get('a').exec = command => { f.calls.push(['a', command]); return gates[0].promise; };
  f.clients.get('b').exec = async command => { f.calls.push(['b', command]); throw new Error('发送失败'); };
  f.clients.get('c').exec = command => { f.calls.push(['c', command]); return gates[1].promise; };
  const pending = model.submitTerminalCommandBatch(f.resolve('all').targets, '  echo ok  ', locks, () => true,
    (target, value) => busy.push([target.id, value]));
  assert.deepEqual(f.calls, [['a', '  echo ok  '], ['b', '  echo ok  '], ['c', '  echo ok  ']]);
  assert.equal(locks.size, 3);
  gates.forEach(gate => gate.resolve());
  assert.deepEqual(plain(await pending), [
    { id: 'a', title: '终端 a', status: 'submitted' },
    { id: 'b', title: '终端 b', status: 'failed', detail: '发送失败' },
    { id: 'c', title: '终端 c', status: 'submitted' },
  ]);
  assert.equal(locks.size, 0); assert.equal(f.calls.length, 3);
  for (const id of ['a', 'b', 'c']) assert.deepEqual(busy.filter(item => item[0] === id), [[id, true], [id, false]]);
});

test('同步锁阻止重复目标和重叠提交；空命令没有任何副作用', async () => {
  const f = fixtures(), gate = deferred(), locks = new Map(), busy = [];
  f.clients.get('b').exec = command => { f.calls.push(['b', command]); return gate.promise; };
  const [target] = f.resolve('single').targets;
  const pending = model.submitTerminalCommandBatch([target, target], 'echo first', locks, () => true, (...args) => busy.push(args));
  const overlapping = await model.submitTerminalCommandBatch([target], 'echo second', locks, () => true, (...args) => busy.push(args));
  assert.equal(overlapping[0].status, 'skipped'); assert.deepEqual(f.calls, [['b', 'echo first']]);
  gate.resolve(); const results = await pending;
  assert.deepEqual(Array.from(results, item => item.status), ['submitted', 'skipped']); assert.equal(locks.size, 0);
  const before = busy.length;
  assert.deepEqual(plain(await model.submitTerminalCommandBatch([target], '\n  ', locks, () => true, (...args) => busy.push(args))), []);
  assert.equal(busy.length, before); assert.equal(f.calls.length, 1);
});

test('发送前重查具体运行时：失效目标和重连替代会话均不接收旧命令', async () => {
  const f = fixtures(), locks = new Map(), busy = [], [target] = f.resolve('single').targets;
  const isCurrent = item => f.clients.get(item.id) === item.runtime;
  const replacement = { ...target.runtime, sessionId: 'new-runtime', exec: async () => { throw new Error('Must not execute'); } };
  const results = await model.submitTerminalCommandBatch([target], 'echo stale', locks, isCurrent,
    (item, value) => { busy.push(value); if (value) f.clients.set(item.id, replacement); });
  assert.equal(results[0].status, 'skipped'); assert.equal(f.calls.length, 0); assert.equal(locks.size, 0);
  assert.deepEqual(busy, [true, false]);
  assert.equal((await model.submitTerminalCommandBatch([target], 'echo stale', locks, () => false, () => {}))[0].status, 'skipped');
});

test('旧运行时完成后不会释放新运行时锁或覆盖其忙碌状态', async () => {
  const f = fixtures(), gate = deferred(), locks = new Map(), busy = [], [target] = f.resolve('single').targets;
  target.runtime.exec = () => gate.promise;
  const pending = model.submitTerminalCommandBatch([target], 'echo old', locks, () => true, (_target, value) => busy.push(value));
  const replacement = { ...target.runtime, sessionId: 'new-runtime' };
  locks.set(target.id, replacement); gate.resolve(); await pending;
  assert.equal(locks.get(target.id), replacement); assert.deepEqual(busy, [true]);
});

function commandBar(overrides = {}, globals = {}) {
  const calls = [], effects = [], node = (type, props) => ({ type, props });
  const { TerminalCommandBar } = load('components/TerminalCommandBar.tsx', name => {
    if (name === 'react') return { useLayoutEffect: callback => effects.push(callback) };
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === './Select') return { Select: 'Select' };
    if (name === './Ui') return { Badge: 'Badge', Icon: 'Icon' };
    if (name.endsWith('.css')) return {};
    throw new Error(name);
  }, globals);
  const props = { mode: 'all', changeMode: value => calls.push(['mode', value]), sessions: [
    { id: 'a', title: '本地 CMD', address: 'local', available: true },
    { id: 'b', title: '服务器', address: 'ssh', available: false },
  ], selectedIds: ['a'], toggleTarget: id => calls.push(['toggle', id]), targetCount: 1, draft: 'echo ok',
    changeDraft: draft => calls.push(['draft', draft]), inputRef: { current: null }, submit: () => calls.push(['submit']), busy: false, result: '', ...overrides };
  const tree = TerminalCommandBar(props);
  const cleanups = effects.map(callback => callback());
  function walk(item) { if (Array.isArray(item)) return item.flatMap(walk); if (!item?.props) return []; return [item, ...walk(item.props.children)]; }
  const nodes = walk(tree);
  return { calls, props, nodes, cleanups, find: type => nodes.find(item => item.type === type) };
}

test('广播输入显式 Enter/按钮提交；空草稿、无目标、忙碌均不发送；IME Enter 不提交', () => {
  const ui = commandBar(); let prevented = 0;
  ui.find('form').props.onSubmit({ preventDefault: () => prevented++ });
  assert.deepEqual(ui.calls, [['submit']]); assert.equal(prevented, 1);
  const input = ui.find('textarea'); input.props.onChange({ target: { value: 'echo changed' } });
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault: () => prevented++ });
  assert.equal(prevented, 1); assert.deepEqual(ui.calls[1], ['draft', 'echo changed']);
  for (const props of [{ draft: '  ' }, { targetCount: 0 }, { busy: true }]) {
    const blocked = commandBar(props);
    blocked.find('form').props.onSubmit({ preventDefault() {} }); assert.equal(blocked.calls.length, 0);
    assert.equal(blocked.find('button').props.disabled, true);
  }
  const single = commandBar({ mode: 'single' }); assert.equal(single.find('form'), undefined);
});

test('软折行不修改内容，Shift+Enter 保留换行，Enter 仅提交一次且中文确认/长按不误提交', () => {
  const draft = 'echo "' + 'x'.repeat(500) + '"\necho next';
  const ui = commandBar({ draft }), field = ui.find('textarea');
  assert.equal(field.props.value, draft); assert.equal(field.props.wrap, 'soft');
  assert.equal(field.props.className, 'code-input');
  let prevented = 0;
  const press = options => field.props.onKeyDown({ key: 'Enter', shiftKey: false, repeat: false,
    nativeEvent: { isComposing: false }, preventDefault: () => prevented++, ...options });
  press({ shiftKey: true }); assert.equal(prevented, 0); assert.equal(ui.calls.length, 0);
  press({ nativeEvent: { isComposing: true } });
  press({ keyCode: 229 }); assert.equal(ui.calls.length, 0);
  press({}); assert.deepEqual(ui.calls, [['submit']]); assert.equal(prevented, 1);
  press({ repeat: true }); assert.equal(ui.calls.length, 1); assert.equal(prevented, 2);
  for (const props of [{ busy: true }, { targetCount: 0 }, { draft: ' ' }]) {
    const blocked = commandBar(props);
    blocked.find('textarea').props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} });
    assert.equal(blocked.calls.length, 0);
  }
});

test('输入随内容及宽度自动增高并能收缩；高度变化不循环测量，观察器卸载清理', () => {
  const field = { clientWidth: 400, scrollHeight: 70, style: {} };
  let resize, disconnected = 0, observed;
  class Observer {
    constructor(callback) { resize = callback; }
    observe(element) { observed = element; }
    disconnect() { disconnected++; }
  }
  const ui = commandBar({ inputRef: { current: field } }, { ResizeObserver: Observer });
  assert.equal(field.style.height, '72px'); assert.equal(observed, field);
  field.scrollHeight = 95; resize(); assert.equal(field.style.height, '72px');
  field.clientWidth = 250; resize(); assert.equal(field.style.height, '97px');
  ui.cleanups.forEach(cleanup => cleanup?.()); assert.equal(disconnected, 1);
  field.scrollHeight = 30;
  commandBar({ draft: '', inputRef: { current: field } }); assert.equal(field.style.height, '32px');
  const css = source('components/TerminalCommandBar.css');
  assert.match(css, /max-height: min\(160px, 25vh\)/);
  assert.match(css, /white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; overflow-y: auto/);
});

test('命令目标栏移除 Agent 单终端提示，广播状态和 Toast 反馈保留', () => {
  for (const mode of ['single', 'all', 'selected']) {
    const ui = commandBar({ mode, result: '已提交 2 个终端' });
    assert.ok(!ui.nodes.some(item => item.props.className === 'terminal-command-agent'));
    const badges = ui.nodes.filter(item => item.type === 'Badge');
    assert.equal(badges.length, mode === 'single' ? 0 : 1);
    if (mode !== 'single') assert.equal(badges[0].props.tone, 'amber');
    assert.ok(!ui.nodes.some(item => item.props.role === 'status'), 'operation feedback belongs to the application Toast');
  }
});

test('实际 App 提交入口：成功使用 Toast，失败或跳过保留错误提醒', async () => {
  const parsed = ts.createSourceFile('App.tsx', source('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function findRun(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'requestRun') expression = node.initializer.getText(parsed);
    ts.forEachChild(node, findRun);
  }
  findRun(parsed); assert.ok(expression);
  const compiled = ts.transpileModule(`export const run = ${expression};`, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  async function run(mutate) {
    const f = fixtures(); mutate?.(f);
    const notifications = [], results = [], sessionsRef = { current: f.sessions };
    const context = vm.createContext({ exports: {}, ...model, isSessionConnected: sessionModel.isSessionConnected,
      commandMode: 'all', commandTargetIds: [], activeId: 'a', active: f.sessions[0],
      broadcastSubmitting: { current: false }, running: { current: new Map() }, terminalClients: { current: f.clients }, sessionsRef,
      setBroadcastBusy() {}, setBroadcastResult: value => results.push(value),
      setSessions: update => { sessionsRef.current = update(sessionsRef.current); },
      notify: (...args) => notifications.push(args), openNewTerminal: () => { throw new Error('Not expected'); },
    });
    vm.runInContext(compiled, context);
    const success = await context.exports.run('echo ok');
    return { success, notifications, results, f };
  }
  const good = await run(); assert.equal(good.success, true); assert.equal(good.notifications.length, 1); assert.equal(good.notifications[0][1], 'success');
  assert.match(good.notifications[0][0], /已提交 3 个终端/);
  const failed = await run(f => { f.clients.get('b').exec = async () => { throw new Error('Failed'); }; });
  assert.equal(failed.success, false); assert.equal(failed.notifications.length, 1); assert.equal(failed.notifications[0][1], 'error');
  assert.match(failed.notifications[0][0], /已提交 2 个终端.*未自动重试/);
  const skipped = await run(f => { f.sessions[1].connected = false; });
  assert.equal(skipped.success, false); assert.equal(skipped.notifications[0][1], 'error');
  assert.match(skipped.notifications[0][0], /连接不可用/);
});

test('选择范围/目标只修改选择不执行；不可用会话明确标记，忙碌时禁用选择', () => {
  const ui = commandBar({ mode: 'selected' });
  ui.find('Select').props.onChange('single');
  const checkboxes = ui.nodes.filter(item => item.props.type === 'checkbox');
  assert.equal(checkboxes[0].props.checked, true); assert.equal(checkboxes[1].props.checked, false);
  checkboxes[1].props.onChange();
  assert.deepEqual(ui.calls, [['mode', 'single'], ['toggle', 'b']]);
  assert.ok(ui.nodes.some(item => item.type === 'small' && item.props.children === '不可用'));
  const busy = commandBar({ mode: 'selected', busy: true });
  assert.equal(busy.find('Select').props.disabled, true);
  assert.ok(busy.nodes.filter(item => item.props.type === 'checkbox').every(item => item.props.disabled));
});

test('广播仅接入手工/常用命令入口；Agent 与原始终端交互保持单会话', () => {
  const app = source('App.tsx');
  const fill = app.slice(app.indexOf('const fill ='), app.indexOf('const requestRun ='));
  assert.match(fill, /commandMode !== 'single'[\s\S]*setBroadcastDraft\(command\)[\s\S]*return;/);
  assert.match(fill, /client\.write\(command\)/);
  const run = app.slice(app.indexOf('const requestRun ='), app.indexOf('const navigate ='));
  assert.match(run, /resolveTerminalCommandTargets\(sessionsRef\.current, terminalClients\.current/);
  assert.match(run, /terminalClients\.current\.get\(target\.id\) === target\.runtime/);
  assert.match(run, /if \(terminalClients\.current\.get\(target\.id\) !== target\.runtime\) return/);
  const parsed = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let agent = '';
  function findAgent(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'sendMessage') agent = node.initializer.getText(parsed);
    ts.forEachChild(node, findAgent);
  }
  findAgent(parsed);
  assert.match(agent, /const currentSession = active;/);
  // Rust scopes were introduced before the layout change: keep that single target,
  // rather than requiring the historical pre-scope implementation string.
  assert.match(agent, /let terminalSessionId = sshExecutionEnabled \? toolTerminal\?\.terminalSessionId/);
  assert.match(agent, /executionTerminal\(canonicalHistory\?\.session, sessionsRef\.current/);
  assert.match(agent, /: currentSession\?\.kind === 'ssh' && isSessionConnected\(currentSession\)/);
  assert.doesNotMatch(agent, /submitTerminalCommandBatch|resolveTerminalCommandTargets|commandTargetIds|commandMode/);
  const terminal = source('components/RemoteTerminalView.tsx');
  assert.doesNotMatch(terminal, /terminalBroadcast|submitTerminalCommandBatch/);
  assert.match(app, /setCommandMode\('single'\);/);
  assert.match(app, /run=\{command => \{ void requestRun\(command\); \}\}/);
});
