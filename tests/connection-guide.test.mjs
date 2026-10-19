import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/components/ConnectionGuide.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const node = (type, props) => ({ type, props });
const context = vm.createContext({ exports: {}, document: { body: {} }, require(name) {
  if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
  if (name === 'react-dom') return { createPortal: content => content };
  if (name === './Ui') return { Icon: 'icon', AccentIcon: 'accent', Modal: 'modal' };
  if (name === './Select') return { Select: 'select' };
  if (name.endsWith('.css')) return {};
  throw new Error(name);
} });
vm.runInContext(compiled, context);

const hosts = [{ id: 'A', name: '服务器 A', user: 'tester', address: 'a.test', port: 22 }, { id: 'B', name: '服务器 B', user: 'tester', address: 'b.test', port: 2222 }];
const projects = [{ id: 'PA', name: '项目 A', connectionId: 'A' }, { id: 'PB', name: '项目 B', connectionId: 'B' }];
function render(patch = {}) {
  const calls = [];
  const props = { state: { open: true, step: 0, task: null, connectionId: '', projectId: '' }, hosts, projects,
    modelReady: true, connected: false, busy: false, error: '',
    ...Object.fromEntries(['Close', 'Step', 'Connection', 'Project', 'CreateConnection', 'CreateProject', 'Models', 'Start', 'Finish']
      .map(name => [`on${name}`, value => calls.push([name, value])])), ...patch };
  const tree = context.exports.ConnectionGuide(props);
  const all = item => Array.isArray(item) ? item.flatMap(all) : item?.props ? [item, ...all(item.props.children)] : [];
  const nodes = all(tree);
  const text = item => Array.isArray(item) ? item.map(text).join('') : item?.props ? text(item.props.children) : typeof item === 'string' ? item : '';
  const button = label => nodes.find(item => item.type === 'button' && text(item) === label);
  return { calls, props, nodes, tree, button, text: text(tree), steps: nodes.filter(item => item.type === 'li').map(item => item.props.children) };
}

test('A fresh user starts with SSH configuration; project and server-chat steps remain unavailable', () => {
  const view = render({ hosts: [], projects: [] });
  assert.equal(view.button('下一步：创建项目').props.disabled, true);
  assert.equal(view.steps[1].props.disabled, true);
  assert.equal(view.steps[2].props.disabled, true);
  view.button('新建 SSH 连接').props.onClick();
  assert.deepEqual(view.calls, [['CreateConnection', undefined]]);
});

test('Existing connections can be reused without creating or connecting anything on render', () => {
  const view = render({ state: { step: 0, connectionId: 'B', projectId: '' } });
  assert.equal(view.button('下一步：创建项目').props.disabled, false);
  assert.deepEqual(view.calls, []);
  view.nodes.find(item => item.type === 'select').props.onChange('A');
  view.button('下一步：创建项目').props.onClick();
  assert.deepEqual(view.calls, [['Connection', 'A'], ['Step', 1]]);
});

test('Only projects bound to the chosen SSH connection can advance the guide', () => {
  const view = render({ state: { step: 1, connectionId: 'A', projectId: 'PB' } });
  assert.equal(view.button('下一步：开始对话').props.disabled, true);
  assert.equal(view.steps[2].props.disabled, true);
  const options = view.nodes.find(item => item.type === 'select').props.options;
  assert.deepEqual(Array.from(options, item => item.value), ['PA']);
  const valid = render({ state: { step: 1, connectionId: 'A', projectId: 'PA' } });
  assert.equal(valid.button('下一步：开始对话').props.disabled, false);
});

test('Missing models lead to model settings and never start a server conversation', () => {
  const view = render({ state: { step: 2, connectionId: 'A', projectId: 'PA' }, modelReady: false });
  assert.equal(view.button('创建服务器对话').props.disabled, true);
  view.button('配置模型').props.onClick();
  assert.deepEqual(view.calls, [['Models', undefined]]);
});

test('Creating a conversation is explicit; failed or disconnected connections never show successful examples', () => {
  const view = render({ state: { step: 2, connectionId: 'B', projectId: 'PB' }, error: '连接失败' });
  assert.deepEqual(view.calls, []);
  view.button('创建服务器对话').props.onClick();
  assert.deepEqual(view.calls, [['Start', undefined]]);
  assert.equal(view.button('进入服务器对话'), undefined);
  assert.equal(view.props.error, '连接失败');
  const disconnected = render({ state: { step: 3, connectionId: 'B', projectId: 'PB' } });
  assert.equal(disconnected.button('进入服务器对话'), undefined);
  assert.match(disconnected.text, /连接已断开/);
});

test('Ready examples fill the draft through Finish, without starting or sending another request', () => {
  const view = render({ state: { step: 3, connectionId: 'A', projectId: 'PA' }, connected: true });
  assert.ok(view.button('进入服务器对话'));
  view.button('查看这台服务器的磁盘使用情况').props.onClick();
  assert.deepEqual(view.calls, [['Finish', '查看这台服务器的磁盘使用情况']]);
  assert.match(view.text, /由你确认后发送/);
});

test('Pending work prevents duplicate actions while the user can still dismiss the guide', () => {
  const view = render({ state: { step: 2, connectionId: 'A', projectId: 'PA' }, busy: true });
  assert.equal(view.button('正在准备…').props.disabled, true);
  assert.ok(view.steps.every(step => step.props.disabled));
  view.tree.props.onClose();
  assert.deepEqual(view.calls, [['Close', undefined]]);
});
