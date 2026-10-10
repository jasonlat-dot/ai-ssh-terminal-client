import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

function load(source, requireModule, globals = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, ...globals });
  vm.runInContext(compiled, context);
  return context.exports;
}
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

/** 驱动真实组件事件及真实连接持久化代码；只使用内存存储，不触碰用户连接和证书。 */
function connectionHarness({ activeId = 'builtin', tlsFailure = false } = {}) {
  const profiles = [
    { id: 'builtin', kind: 'builtin', name: '内置后端', url: 'https://127.0.0.1:8889', trust: 'system', certificatePem: '' },
    { id: 'remote', kind: 'remote', name: '本地测试服务器', url: 'https://127.0.0.1:8888', trust: 'system', certificatePem: '' },
  ];
  const storage = new Map([['agent-ssh-backend-connections-v2', JSON.stringify({ version: 2, activeId, profiles })]]);
  const writes = [], uses = [], slots = [], tlsIdentities = [];
  let cursor = 0, tree, starts = 0;
  const backend = load(source('config/backend.ts'), () => { throw new Error('Unexpected import'); }, {
    URL, crypto: { randomUUID: () => 'new-remote' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { writes.push(key); storage.set(key, value); } },
  });
  const node = (type, props) => ({ type, props: props ?? {} });
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    // 本组测试关注选择、保存与应用；localUrl 固定，不需要模拟 DOM 或文件选择效果。
    useEffect() { cursor++; },
  };
  const requireModule = name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === '../config/backend') return backend;
    if (name === '../state/runtime') return { isTauriRuntime: () => true };
    if (name === '../api/backendFetch') return { prepareBackendConnectionTls: async () => {
      tlsIdentities.push(backend.activeBackendConnection().id);
      if (tlsFailure && backend.activeBackendConnection().id === 'remote') throw new Error('证书准备失败');
    } };
    if (name === '../api/backendConnectionProbe') return { probeBackendConnection: async () => ({ ok: true, latencyMs: 15 }) };
    if (name === '../api/bundledBackend') return {
      readBundledBackendStatus: async () => ({ status: 'running', backendUrl: profiles[0].url }),
      restartBundledBackend: async () => { starts++; return { status: 'running', backendUrl: profiles[0].url }; },
    };
    if (name === './Select') return { Select: props => node('select-control', props) };
    if (name === './Ui') return { Icon: () => node('svg'), Badge: props => node('span', props) };
    throw new Error(`Unexpected import: ${name}`);
  };
  const { BackendConnectionSettings } = load(source('components/BackendConnectionSettings.tsx'), requireModule,
    { crypto: { randomUUID: () => 'new-remote' } });
  function render() {
    cursor = 0;
    tree = BackendConnectionSettings({ localUrl: profiles[0].url, onUse: url => uses.push(url) });
  }
  function nodes(value) {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (typeof value.type === 'function') return nodes(value.type(value.props));
    return [value, ...nodes(value.props.children)];
  }
  function text(value) {
    if (value == null) return '';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(text).join('');
    return typeof value.type === 'function' ? text(value.type(value.props)) : text(value.props.children);
  }
  const find = predicate => nodes(tree).find(predicate);
  function select(id) {
    find(item => item.type === 'select-control' && item.props.label === '查看或编辑后端连接').props.onChange(id);
    render();
  }
  async function click(label) {
    const button = find(item => item.type === 'button' && text(item) === label);
    assert.ok(button, `找不到按钮 ${label}`);
    assert.ok(!button.props.disabled);
    button.props.onClick();
    for (let i = 0; i < 16; i++) await Promise.resolve();
    render();
  }
  render();
  return { select, click, backend, writes, uses, tlsIdentities, text: () => text(tree), get starts() { return starts; } };
}

test('选择远程只编辑草稿，提示尚未使用，真正活动连接及存储不变', () => {
  const ui = connectionHarness();
  ui.select('remote');
  assert.match(ui.text(), /当前正在使用：内置后端/);
  assert.match(ui.text(), /本地测试服务器：已选择，尚未使用/);
  assert.match(ui.text(), /底部「保存内置后端配置」只保存本机 YAML，不保存或应用此连接/);
  assert.equal(ui.backend.activeBackendConnection().id, 'builtin');
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.tlsIdentities.length, 0);
});

test('保存非活动远程档案不切换后端，保存后仍显示尚未使用', async () => {
  const ui = connectionHarness();
  ui.select('remote');
  await ui.click('保存连接');
  assert.match(ui.text(), /连接已保存/);
  assert.match(ui.text(), /已选择，尚未使用/);
  assert.equal(ui.backend.activeBackendConnection().id, 'builtin');
  assert.equal(ui.uses.length, 0);
  assert.equal(ui.tlsIdentities.length, 0);
});

test('明确使用远程后准备证书并更新当前连接，组件不卸载也不残留待使用提示', async () => {
  const ui = connectionHarness();
  ui.select('remote');
  await ui.click('使用此连接');
  assert.equal(ui.backend.activeBackendConnection().id, 'remote');
  assert.deepEqual(ui.tlsIdentities, ['remote']);
  assert.deepEqual(ui.uses, ['https://127.0.0.1:8888']);
  assert.match(ui.text(), /当前正在使用：本地测试服务器/);
  assert.doesNotMatch(ui.text(), /已选择，尚未使用/);
  assert.equal(ui.starts, 0);
});

test('证书准备失败恢复原活动连接，草稿依然标记未使用而不是成功切换', async () => {
  const ui = connectionHarness({ tlsFailure: true });
  ui.select('remote');
  await ui.click('使用此连接');
  assert.equal(ui.backend.activeBackendConnection().id, 'builtin');
  assert.match(ui.text(), /当前正在使用：内置后端/);
  assert.match(ui.text(), /已选择，尚未使用/);
  assert.match(ui.text(), /证书准备失败/);
  assert.deepEqual(ui.tlsIdentities, ['remote', 'builtin']);
  assert.equal(ui.uses.length, 0);
});

test('选择内置也不立即切换，明确切回成功才更新活动连接', async () => {
  const ui = connectionHarness({ activeId: 'remote' });
  ui.select('builtin');
  assert.match(ui.text(), /内置后端：已选择，尚未使用/);
  assert.match(ui.text(), /点击「切回内置后端」才会切换/);
  assert.equal(ui.backend.activeBackendConnection().id, 'remote');
  await ui.click('切回内置后端');
  assert.equal(ui.backend.activeBackendConnection().id, 'builtin');
  assert.match(ui.text(), /当前正在使用：内置后端/);
  assert.doesNotMatch(ui.text(), /已选择，尚未使用/);
});

test('独立测试连接成功仍不是保存或切换，待使用提示保留', async () => {
  const ui = connectionHarness();
  ui.select('remote');
  await ui.click('测试连接');
  assert.match(ui.text(), /独立连接测试通过/);
  assert.match(ui.text(), /已选择，尚未使用/);
  assert.equal(ui.backend.activeBackendConnection().id, 'builtin');
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.uses.length, 0);
});

test('内置配置保存成功文案与未保存标记明确限定 YAML，不声称客户端连接已应用', () => {
  const dialog = source('components/BackendSettingsDialog.tsx');
  assert.match(dialog, /内置后端配置已保存，当前连接未改变；未保存或应用上方客户端连接/);
  assert.match(dialog, /内置后端配置暂无未保存修改/);
  const saveTab = dialog.slice(dialog.indexOf('const saveTab = async'), dialog.indexOf('const isTabDirty'));
  assert.match(saveTab, /await saveBundledBackendConfig/);
  assert.doesNotMatch(saveTab, /activateBackendConnection|saveBackendConnection|onSave\(/);
});

/** 加载生产保存栏函数本身，避免测试中复制一份按钮禁用逻辑而遗漏实际回归。 */
function renderSaveBar({ scope = 'proxy', dirty = false, saving = false, onSave = () => {}, onReset = () => {} } = {}) {
  const dialog = source('components/BackendSettingsDialog.tsx');
  const start = dialog.indexOf('function TabSaveBar(');
  const end = dialog.indexOf('function SettingsGroup(', start);
  assert.ok(start >= 0 && end > start);
  const { TabSaveBar } = load(`export ${dialog.slice(start, end)}`, name => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`Unexpected import: ${name}`);
  }, { Icon: () => React.createElement('svg', { 'aria-hidden': true }) });
  const tree = TabSaveBar({ scope, saveLabel: '保存配置', hint: '只保存此分区', dirty, saving, onSave, onReset });
  const buttons = React.Children.toArray(tree.props.children[1].props.children);
  return { html: renderToStaticMarkup(tree), reset: buttons[0], save: buttons[1] };
}

test('所有配置分区无修改时，状态说明与保存、重置的禁用状态一致', () => {
  for (const scope of ['general', 'model', 'proxy', 'storage']) {
    const bar = renderSaveBar({ scope });
    assert.match(bar.html, /暂无未保存修改/);
    assert.equal(bar.save.props.disabled, true);
    assert.equal(bar.reset.props.disabled, true);
    assert.match(bar.html, /class="primary-button" disabled=""/);
  }
  assert.match(renderSaveBar({ scope: 'general' }).html, /内置后端配置暂无未保存修改/);
});

test('修改后启用保存与重置，保存成功或重置后再次禁用', () => {
  let dirty = true, saves = 0;
  const props = { dirty, onSave: () => { saves++; dirty = false; }, onReset: () => { dirty = false; } };
  const edited = renderSaveBar(props);
  assert.equal(edited.save.props.disabled, false);
  assert.equal(edited.reset.props.disabled, false);
  assert.match(edited.html, /有未保存的修改/);
  edited.save.props.onClick();
  assert.equal(saves, 1);
  assert.equal(renderSaveBar({ ...props, dirty }).save.props.disabled, true);
  dirty = true;
  renderSaveBar({ ...props, dirty }).reset.props.onClick();
  assert.equal(renderSaveBar({ ...props, dirty }).save.props.disabled, true);
});

test('有修改但正在保存时禁用两种操作，失败保留修改后仍可重试', () => {
  const busy = renderSaveBar({ dirty: true, saving: true });
  assert.equal(busy.save.props.disabled, true);
  assert.equal(busy.reset.props.disabled, true);
  assert.match(busy.html, /正在保存配置/);
  const retry = renderSaveBar({ dirty: true, saving: false });
  assert.equal(retry.save.props.disabled, false);
  assert.match(retry.html, /有未保存的修改/);
});

test('保存处理入口拦截无修改和保存中提交，分区 ID 与保存栏说明正确对应', () => {
  const dialog = source('components/BackendSettingsDialog.tsx');
  assert.match(dialog, /<TabSaveBar scope=\{activeDefinition\.id\}/);
  const saveTab = dialog.slice(dialog.indexOf('const saveTab = async'), dialog.indexOf('const isTabDirty'));
  assert.match(saveTab, /if \(saving \|\| !isTabDirty\(scope\)\) return;/);
  assert.ok(saveTab.indexOf('!isTabDirty(scope)') < saveTab.indexOf('saveBundledBackendConfig'));
  const css = source('components/BackendSettingsDialog.css');
  assert.match(css, /\.settings-page \.settings-tab-save-actions \.primary-button:disabled \{[^}]*background: var\(--settings-panel-soft\)[^}]*color: var\(--settings-text-muted\)[^}]*cursor: not-allowed/s);
});
