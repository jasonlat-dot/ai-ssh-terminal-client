import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const compile = input => ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const listing = (path, names = ['folder', '.hidden', '中文.txt']) => ({ path, truncated: false,
  entries: names.map((name, i) => ({ name, directory: i === 0, symlink: false, size: 12 })) });
function harness() {
  const slots = [], effects = [], jobs = new Map(), events = new Map(), requests = [], saved = new Map(), copies = [];
  let cursor = 0, timerId = 0, tree, managerOpens = 0;
  let cwd = { path: '/home', revision: 1 };
  const runtime = { sessionId: 'one', directorySnapshot: () => cwd, subscribeDirectory: () => () => {},
    directoryList: (path, signal) => new Promise((resolve, reject) => requests.push({ path, signal, resolve, reject })) };
  let props = { runtime, title: '测试服务器', local: false, connected: true, visible: true, openFiles: () => managerOpens++, copy: async path => copies.push(path) };
  const document = { hidden: false, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
    useEffect(callback, deps) { const i = cursor++; const old = slots[i];
      if (!old || deps.some((dep, index) => !Object.is(dep, old.deps[index]))) {
        old?.cleanup?.(); const effect = { deps }; slots[i] = effect; effects.push(() => { effect.cleanup = callback(); });
      }
    },
  };
  const context = vm.createContext({ exports: {}, AbortController, document,
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    setTimeout: (fn, delay) => { jobs.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => jobs.delete(id),
    require: name => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith('terminalDirectory')) return directory;
      if (name.endsWith('terminalResources')) return { resourceBytes: value => `${value} B` };
      if (name === './Ui') return { Icon: 'icon', IconButton: 'icon-button' };
      if (name.endsWith('.css')) return {};
      throw new Error(name);
    },
  });
  vm.runInContext(compile(source('state/terminalDirectory.ts')), context); const directory = context.exports; context.exports = {};
  vm.runInContext(compile(source('components/TerminalFileSidebar.tsx')), context);
  const all = value => Array.isArray(value) ? value.flatMap(all) : value?.props ? [value, ...all(value.props.children)] : [];
  const render = (patch = {}) => { props = { ...props, ...patch }; cursor = 0; tree = context.exports.TerminalFileSidebar(props); while (effects.length) effects.shift()(); return tree; };
  render();
  return { requests, copies, saved, events, render, runtime, nodes: () => all(tree), managerOpens: () => managerOpens,
    find: predicate => all(tree).find(predicate),
    async tick() { const pending = [...jobs]; jobs.clear(); for (const [, job] of pending) job.fn(); await flush(); render(); },
    cwd(path, access = {}) { cwd = { ...cwd, ...access, path, revision: cwd.revision + 1 }; render(); },
    visibility(hidden) { document.hidden = hidden; events.get('visibilitychange')?.(); render(); },
    stop() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('目录跟随切换、文件单击、手动浏览、恢复跟随与管理传输均绑定当前终端', async () => {
  const ui = harness(); await ui.tick(); assert.equal(ui.requests[0].path, '/home');
  ui.requests[0].resolve(listing('/home')); await flush(); ui.render();
  const entry = name => ui.find(node => node.props.title === name);
  assert.ok(entry('.hidden')); entry('中文.txt').props.onClick(); ui.render();
  ui.find(node => node.props.label === '复制选中文件路径').props.onClick(); await flush();
  assert.deepEqual(ui.copies, ['/home/中文.txt']);
  entry('folder').props.onClick(); ui.render(); await ui.tick();
  assert.equal(ui.requests.at(-1).path, '/home/folder');
  const follow = () => ui.find(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(follow().props.checked, false);
  ui.requests.at(-1).resolve(listing('/home/folder', [])); await flush(); ui.render();
  ui.cwd('/opt'); await ui.tick(); assert.equal(ui.requests.at(-1).path, '/home/folder', '自由浏览不会被新提示符抢走');
  follow().props.onChange({ target: { checked: true } }); ui.render(); await ui.tick();
  assert.equal(ui.requests.at(-1).path, '/opt');
  ui.find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes('管理与传输')).props.onClick();
  assert.equal(ui.managerOpens(), 1); ui.stop();
});

test('快速 cd、断线、隐藏侧栏及切换会话取消旧请求，迟到结果不能污染清单', async () => {
  const ui = harness(); await ui.tick(); const first = ui.requests[0];
  ui.cwd('/opt'); assert.ok(first.signal.aborted); await ui.tick(); const second = ui.requests[1];
  first.resolve(listing('/wrong', ['private-file'])); await flush(); ui.render();
  assert.ok(!ui.nodes().some(node => node.props.title === 'private-file'));
  second.resolve(listing('/opt')); await flush(); ui.render();
  ui.render({ visible: false }); const count = ui.requests.length; await ui.tick(); assert.equal(ui.requests.length, count);
  ui.render({ visible: true }); await ui.tick(); const third = ui.requests.at(-1);
  ui.render({ connected: false }); assert.ok(third.signal.aborted);
  ui.render({ connected: true, runtime: { ...ui.runtime, sessionId: 'other', directorySnapshot: () => ({ path: '/srv', revision: 1 }) } });
  await ui.tick(); third.resolve(listing('/old')); await flush(); ui.render();
  assert.ok(!ui.nodes().some(node => node.props.value === '/old')); ui.stop();
});

test('目录权限错误可重试，未知目录不冒充终端位置；未连接和本地终端有明确空态', async () => {
  const ui = harness(); ui.cwd(''); await ui.tick(); assert.equal(ui.requests[0].path, '');
  ui.requests[0].reject(new Error('权限不足')); await flush(); ui.render();
  assert.ok(ui.find(node => node.props.role === 'alert'));
  ui.find(node => node.type === 'button' && node.props.children === '重试').props.onClick(); ui.render(); await ui.tick();
  assert.equal(ui.requests.length, 2); ui.stop();
  const local = harness(); local.render({ local: true }); await local.tick(); assert.equal(local.requests.length, 0); local.stop();
});
test('页面隐藏取消采集，恢复后即使旧请求迟到也只有一个轮询，不显示旧目录', async () => {
  const ui = harness(); await ui.tick(); const old = ui.requests[0];
  ui.visibility(true); assert.equal(old.signal.aborted, true);
  await ui.tick(); assert.equal(ui.requests.length, 1);
  ui.visibility(false); await ui.tick(); assert.equal(ui.requests.length, 2);
  old.resolve(listing('/late')); await flush(); ui.render();
  ui.requests[1].resolve(listing('/home')); await flush(); ui.render();
  await ui.tick(); assert.equal(ui.requests.length, 3); ui.stop();
});

test('自由浏览也随退出 root 撤销读取，立即清除旧身份文件并拒绝迟到结果', async () => {
  const ui = harness();
  ui.cwd('/root', { access: 'root', accessKey: 'root-shell-one' }); await ui.tick();
  ui.requests.at(-1).resolve(listing('/root', ['root-private-file'])); await flush(); ui.render();
  assert.ok(ui.find(node => node.props.title === 'root-private-file'));
  ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: false } });
  ui.render(); await ui.tick(); const pending = ui.requests.at(-1);
  ui.cwd('/home/user', { access: 'login', accessKey: 'login-shell' }); ui.render();
  assert.equal(pending.signal.aborted, true);
  assert.ok(!ui.find(node => node.props.title === 'root-private-file'));
  pending.resolve(listing('/root', ['late-private-file'])); await flush(); ui.render();
  assert.ok(!ui.find(node => node.props.title === 'late-private-file'));
  await ui.tick(); assert.equal(ui.requests.at(-1).path, '/root');
  ui.stop();
});
