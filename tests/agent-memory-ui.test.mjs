import { loadToastErrorHooks } from './helpers/toast-errors.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/AgentMemory.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const all = node => Array.isArray(node) ? node.flatMap(all) : node?.props ? [node, ...all(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' ? node : '';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const identity = { host: 'server', port: 22, username: 'user', hostKey: 'key' };
const target = { connectionId: 'ssh', identity };
const base = { id: 'memory', revision: 3, title: '日志位置', content: '/var/log', kind: 'procedure', scope: 'global', enabled: true,
  target: null, source: { kind: 'userConfirmed', sessionId: 'original', agentId: 'original-model' }, createdAt: 1, updatedAt: 2, applicable: true };
const settle = () => new Promise(setImmediate);

function harness(overrides = {}, scope = { agentId: '', sessionId: '' }, component = 'AgentMemoryDialog') {
  const slots = [], pendingEffects = [], cleanups = new Map(); let cursor = 0, tree;
  const calls = { errors: [], lists: [], saves: [], deletes: [], notices: [] };
  const api = {
    projects: async () => [{ id: 'p', name: '测试服务器', identity, connectionId: 'ssh' }],
    memories: async () => ({ target: null, items: [] }),
    saveMemory: async (_agent, _chat, input) => ({ ...base, ...input, revision: input.revision + 1 }),
    deleteMemory: async () => null,
    ...overrides,
  };
  const agentApi = { ...api,
    memories(...args) { calls.lists.push(args); return api.memories(...args); },
    saveMemory(...args) { calls.saves.push(args); return api.saveMemory(...args); },
    deleteMemory(...args) { calls.deletes.push(args); return api.deleteMemory(...args); },
  };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useId() { return `memory-${cursor++}`; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i];
      if (!old || deps.some((dep, j) => !Object.is(dep, old[j]))) { slots[i] = deps; pendingEffects.push(() => { cleanups.get(i)?.(); cleanups.set(i, effect()); }); } },
  };
  const node = (type, props) => ({ type, props });
  const leaf = () => null;
  const context = vm.createContext({ exports: {}, Error, TextEncoder, crypto, Date, document: { body: {} }, require(name) {
    if (name === '../state/useToastError') return loadToastErrorHooks(hooks,(message,type)=>calls.errors.push({message,type}));if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === 'react-dom') return { createPortal: children => node('portal', { children }) };
    if (name === '../api/agent') return { agentApi };
    if (name === './Ui') return { Icon: leaf, Modal: 'modal', Toggle: 'toggle' };
    if (name === './Select') return { Select: 'select' };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected import ${name}`);
  } });
  vm.runInContext(compiled, context);
  function render() { cursor = 0; tree = context.exports[component]({ scope, onClose() {}, onNotice: message => calls.notices.push(message) }); while (pendingEffects.length) pendingEffects.shift()(); return tree; }
  const find = predicate => all(tree).find(predicate);
  const button = label => find(node => node.type === 'button' && text(node) === label);
  render();
  return { calls, render, find, button, text: () => text(tree), unmount() { cleanups.forEach(fn => fn?.()); },
    input(label, value) { find(node => node.props['aria-label'] === label).props.onChange({ target: { value } }); render(); },
    submit() { find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
  };
}

test('记忆入口在空白对话可用，打开时使用 Portal，不创建聊天或请求模型', () => {
  const h = harness({}, { agentId: '', sessionId: '' }, 'AgentMemoryButton');
  assert.equal(h.calls.lists.length, 0);
  h.find(node => node.props['aria-label'] === '管理长期记忆').props.onClick(); h.render();
  assert.ok(h.find(node => node.type === 'portal'));
});

test('空白范围可保存全局记忆，发送可编辑字段且使用原生返回的版本', async () => {
  const h = harness(); await settle(); h.render(); h.button('新建记忆').props.onClick(); h.render();
  assert.deepEqual(Array.from(h.find(node => node.props.label === '生效范围').props.options, option => option.value), ['global', 'project:p']);
  assert.equal(h.find(node => node.props.label === '生效范围').props.value, 'global');
  h.input('记忆标题', ' 偏好 '); h.input('记忆内容', ' 中文回答 '); h.submit();
  await settle(); h.render();
  const [agent, chat, input, project] = h.calls.saves[0];
  assert.equal(agent, ''); assert.equal(chat, ''); assert.equal(project, undefined);
  assert.deepEqual(Object.keys(input).sort(), ['content', 'enabled', 'id', 'kind', 'revision', 'scope', 'title']);
  assert.equal(input.title, '偏好'); assert.equal(input.content, '中文回答'); assert.equal(input.revision, 0);
  assert.match(h.calls.notices[0], /已添加长期记忆/);
  assert.match(h.text(), /偏好/); assert.equal(h.find(node => node.type === 'form'), undefined);
});

test('当前项目直接作为管理上下文，创建服务器记忆时不同时发送 sessionId', async () => {
  const h = harness({ memories: async () => ({ target, items: [] }) }, { agentId: '', sessionId: '', projectId: 'p' });
  await settle(); h.render();
  assert.deepEqual(h.calls.lists.at(-1), ['', '', 'p']);
  h.button('新建记忆').props.onClick(); h.render();
  assert.equal(h.find(node => node.props.label === '查看范围'), undefined);
  assert.deepEqual(Array.from(h.find(node => node.props.label === '生效范围').props.options, option => option.value), ['global', 'server']);
  h.input('记忆标题', '服务路径'); h.input('记忆内容', '/srv'); h.submit(); await settle(); h.render();
  assert.equal(h.calls.saves[0][2].scope, 'server'); assert.equal(h.calls.saves[0][3], 'p'); assert.equal(h.calls.saves[0][1], '');
});

test('新建时只切换生效范围，当前项目仍作为保存上下文', async () => {
  const h = harness({ memories: async () => ({ target, items: [] }) }, { agentId: '', sessionId: '', projectId: 'p' });
  await settle(); h.render(); h.button('新建记忆').props.onClick(); h.render();
  const effective = h.find(node => node.props.label === '生效范围');
  effective.props.onChange('global'); h.render();
  assert.equal(h.find(node => node.props.label === '生效范围').props.value, 'global');
  effective.props.onChange('server'); h.render();
  assert.equal(h.find(node => node.props.label === '生效范围').props.value, 'server');
});

test('启停同步防重入，保存前不乐观修改状态，只发送原版本及可编辑字段', async () => {
  const saving = deferred();
  const h = harness({ memories: async () => ({ target: null, items: [base] }), saveMemory: () => saving.promise });
  await settle(); h.render(); const toggle = h.find(node => node.type === 'toggle');
  toggle.props.onChange(false); toggle.props.onChange(false); h.render();
  assert.equal(h.calls.saves.length, 1); assert.equal(h.find(node => node.type === 'toggle').props.value, true);
  assert.equal(h.find(node => node.type === 'toggle').props.disabled, true);
  assert.equal(h.calls.saves[0][2].revision, 3); assert.equal('source' in h.calls.saves[0][2], false);
  saving.resolve({ ...base, enabled: false, revision: 4 }); await settle(); h.render();
  assert.equal(h.find(node => node.type === 'toggle').props.value, false);
});

test('版本冲突保留编辑文字，刷新后保留文字并采用新版本', async () => {
  let current = base;
  const h = harness({ memories: async () => ({ target: null, items: [current] }), saveMemory: async () => { throw Object.assign(new Error('stale'), { code: 'AGENT_MEMORY_CHANGED' }); } });
  await settle(); h.render(); h.find(node => node.props['aria-label'] === '编辑记忆：日志位置').props.onClick(); h.render();
  h.input('记忆内容', '保留的输入'); h.submit(); await settle(); h.render();
  assert.equal(h.find(node => node.props['aria-label'] === '记忆内容').props.value, '保留的输入');
  assert.match(h.calls.errors.at(-1).message, /其他窗口更改/);
  current = { ...base, revision: 7 }; h.button('刷新').props.onClick(); h.render(); await settle(); h.render();
  h.submit(); await settle();
  assert.equal(h.calls.saves[1][2].revision, 7); assert.equal(h.calls.saves[1][2].content, '保留的输入');
});

test('身份不匹配的服务器记录不可编辑，删除需要确认且使用返回版本', async () => {
  const foreign = { ...base, id: 'foreign', title: '其他服务器', scope: 'server', target, applicable: false };
  const h = harness({ projects: async () => [], memories: async () => ({ target: null, items: [base, foreign] }) });
  await settle(); h.render();
  assert.equal(h.find(node => node.props['aria-label'] === '编辑记忆：其他服务器').props.disabled, true);
  h.find(node => node.props['aria-label'] === '删除记忆：日志位置').props.onClick(); h.render();
  assert.ok(h.find(node => node.type === 'modal' && node.props.title === '删除长期记忆？'));
  assert.equal(h.find(node => node.type === 'modal' && node.props.title === '长期记忆').props.active, false);
  assert.equal(h.calls.deletes.length, 0); h.button('确认删除').props.onClick(); await settle(); h.render();
  assert.deepEqual(h.calls.deletes[0], ['', '', 'memory', 3]);
  assert.match(h.calls.notices[0], /已删除长期记忆/);
  assert.doesNotMatch(h.text(), /日志位置/);
});

test('普通对话可筛选并编辑其他服务器项目，保存时只提交该项目上下文', async () => {
  const server = { ...base, id: 'server-memory', title: 'WSL 目录', scope: 'server', target, applicable: false };
  const h = harness({ memories: async () => ({ target: null, items: [base, server] }),
    saveMemory: async (_agent, _session, input) => ({ ...server, ...input, revision: input.revision + 1 }),
  }, { agentId: 'general-model', sessionId: 'general-chat' });
  await settle(); h.render();
  h.find(node => node.props.label === '筛选生效范围').props.onChange('project:p'); h.render();
  assert.equal(h.find(node => node.props['aria-label'] === '编辑记忆：日志位置'), undefined);
  const edit = h.find(node => node.props['aria-label'] === '编辑记忆：WSL 目录');
  assert.equal(edit.props.disabled, false); edit.props.onClick(); h.render();
  assert.equal(h.find(node => node.props.label === '生效范围').props.value, 'project:p');
  h.input('记忆内容', '/srv/wsl'); h.submit(); await settle(); h.render();
  const [agent, session, input, project] = h.calls.saves[0];
  assert.equal(agent, ''); assert.equal(session, ''); assert.equal(project, 'p');
  assert.equal(input.scope, 'server'); assert.equal(input.content, '/srv/wsl'); assert.equal(input.revision, 3);
  assert.equal('target' in input, false); assert.equal('source' in input, false);
});

test('服务器记忆改为全局时仍使用原服务器项目验证归属', async () => {
  const server = { ...base, title: 'WSL 目录', scope: 'server', target, applicable: false };
  const h = harness({ memories: async () => ({ target: null, items: [server] }) });
  await settle(); h.render(); h.find(node => node.props['aria-label'] === '编辑记忆：WSL 目录').props.onClick(); h.render();
  h.find(node => node.props.label === '生效范围').props.onChange('global'); h.render(); h.submit(); await settle();
  assert.equal(h.calls.saves[0][2].scope, 'global'); assert.equal(h.calls.saves[0][3], 'p');
  assert.equal(h.calls.saves[0][1], '');
});

test('分页只显示当前页，搜索与状态筛选回到第一页', async () => {
  const records = Array.from({ length: 9 }, (_, index) => ({ ...base, id: `memory-${index}`, title: `记录${index}`, enabled: index !== 0 }));
  const h = harness({ memories: async () => ({ target: null, items: records }) });
  await settle(); h.render();
  assert.ok(h.find(node => node.props['aria-label'] === '编辑记忆：记录0'));
  assert.equal(h.find(node => node.props['aria-label'] === '编辑记忆：记录8'), undefined);
  h.button('下一页').props.onClick(); h.render();
  assert.ok(h.find(node => node.props['aria-label'] === '编辑记忆：记录8'));
  assert.equal(h.find(node => node.props['aria-label'] === '编辑记忆：记录0'), undefined);
  h.input('搜索记忆', '记录0');
  assert.ok(h.find(node => node.props['aria-label'] === '编辑记忆：记录0'));
  assert.equal(h.button('下一页').props.disabled, true);
  h.find(node => node.props.label === '筛选启用状态').props.onChange('enabled'); h.render();
  assert.equal(h.find(node => node.type === 'article'), undefined);
  h.button('清除筛选').props.onClick(); h.render();
  assert.ok(h.find(node => node.props['aria-label'] === '编辑记忆：记录0'));
});

test('读取失败可重试，UTF-8 超长内容在发送前拒绝，卸载后异步响应不写新范围', async () => {
  let failed = true;
  const h = harness({ memories: async () => { if (failed) throw new Error('读取失败'); return { target: null, items: [] }; } });
  await settle(); h.render(); assert.match(h.calls.errors.at(-1).message, /读取失败/); failed = false;
  h.button('刷新').props.onClick(); h.render(); await settle(); h.render(); h.button('新建记忆').props.onClick(); h.render();
  h.input('记忆标题', '中'.repeat(41)); h.input('记忆内容', '内容'); h.submit(); h.render();
  assert.equal(h.calls.saves.length, 0); assert.match(h.calls.errors.at(-1).message, /过长/); h.unmount();
});
