import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const dialog = source('components/BackendSettingsDialog.tsx');
const parsed = ts.createSourceFile('BackendSettingsDialog.tsx', dialog, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const layouts = new Map(), fields = new Map();
function discover(node) {
  if (ts.isVariableDeclaration(node) && ['modelFields', 'generalFields', 'tlsStoreFields'].includes(node.name.getText(parsed))) {
    fields.set(node.name.getText(parsed), node.getText(parsed));
  }
  if (ts.isJsxElement(node)) {
    const className = node.openingElement.attributes.properties.find(prop => prop.name?.getText(parsed) === 'className');
    if (className?.initializer && ts.isStringLiteral(className.initializer) && className.initializer.text.startsWith('settings-columns ')) {
      layouts.set(className.initializer.text.split(' ')[1], node.getText(parsed));
    }
  }
  ts.forEachChild(node, discover);
}
discover(parsed);

/** Render the actual JSX blocks without mounting network or platform effects. */
function render(section, overrides = {}) {
  const component = layouts.get(`settings-${section}-layout`); assert.ok(component);
  const jsx = (type, props) => ({ type, props }), changes = [], uses = [], startupCalls = [];
  const context = vm.createContext({ exports: {}, require: name => {
    assert.equal(name, 'react/jsx-runtime'); return { jsx, jsxs: jsx };
  }, SettingsGroup: 'SettingsGroup', BackendConnectionSettings: 'BackendConnectionSettings',
    PathPreviewCard: 'PathPreviewCard', BackendHealthCard: 'BackendHealthCard', Toggle: 'Toggle', Select: 'Select',
    BooleanConfigField: 'BooleanConfigField', ProtocolCard: 'ProtocolCard', MediaTypeEditor: 'MediaTypeEditor', Icon: 'Icon',
    config: { values: {}, sqliteFile: 'db', uploadDirectory: 'files', logDirectory: 'logs' },
    values: { dataDirectory: 'C:/data', serverSslAutoGenerate: 'true', aiSupportedMediaTypes: 'text/plain' },
    renderFields: definitions => jsx('fields', { definitions }), childPath: (...parts) => parts.join('/'),
    bundledUrl: 'https://localhost:8888', currentUrl: 'https://remote.test', bundledHealth: {}, currentHealth: {}, bundledInactiveReason: '',
    autoStartAvailable: true, autoStartEnabled: true, autoStartError: '', settingsStarting: false, backendStatus: { status: 'running' },
    toggleAutoStart: () => startupCalls.push('toggle'), stopManuallyFromSettings: () => startupCalls.push('stop'), startManuallyFromSettings: () => startupCalls.push('start'),
    isTauriRuntime: () => true, healthRefresh: { enabled: true, normalIntervalSeconds: 15, retryIntervalSeconds: 3 },
    HEALTH_NORMAL_INTERVALS: [15, 30], HEALTH_RETRY_INTERVALS: [3, 5], healthRefreshError: '', updateHealthRefresh() {},
    change: (...args) => changes.push(args), onSave: value => uses.push(value), ...overrides,
  });
  const compiled = ts.transpileModule([...fields.values()].map(value => `const ${value};`).join('\n')
    + `\nexport const render = () => (${component});\nexport const keys = modelFields.map(field => field.key);`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInContext(compiled, context);
  const tree = context.exports.render();
  function walk(item) { if (Array.isArray(item)) return item.flatMap(walk); if (!item?.props) return []; return [item, ...walk(item.props.children)]; }
  return { tree, walk, changes, uses, startupCalls, keys: Array.from(context.exports.keys) };
}

test('连接页左侧依次为启动、客户端连接、基础设置，右侧为健康检查及 TLS', () => {
  const ui = render('connections'), columns = ui.tree.props.children;
  assert.equal(columns.length, 2);
  assert.deepEqual(ui.walk(columns[0]).filter(node => node.type === 'SettingsGroup').map(node => node.props.title), ['启动方式', '客户端连接', '基础设置']);
  assert.deepEqual(ui.walk(columns[1]).filter(node => node.type === 'SettingsGroup').map(node => node.props.title), ['服务健康检查', '内置后端 HTTPS']);
  assert.ok(columns.every(node => node.props.className === 'settings-column' && node.props.role === 'group'));
  const connection = ui.walk(columns[0]).find(node => node.type === 'BackendConnectionSettings');
  connection.props.onUse('https://chosen.test'); assert.deepEqual(ui.uses, ['https://chosen.test']);
  assert.equal(ui.walk(columns[1]).find(node => node.props.id === 'settings-health-check').props.title, '服务健康检查');
});

test('启动卡片移至左上后保留自动启动、启动/停止及忙碌禁用行为', () => {
  for (const status of ['running', 'stopped']) {
    const ui = render('connections', { backendStatus: { status } });
    const group = ui.walk(ui.tree.props.children[0]).find(node => node.type === 'SettingsGroup');
    assert.equal(group.props.title, '启动方式');
    const button = ui.walk(group).find(node => node.type === 'button');
    assert.equal(button.props.disabled, false);
    assert.equal(button.props.children[1], status === 'running' ? '停止内置服务' : '启动内置服务');
    button.props.onClick();
    ui.walk(group).find(node => node.type === 'Toggle').props.onChange();
    assert.deepEqual(ui.startupCalls, [status === 'running' ? 'stop' : 'start', 'toggle']);
    const busy = render('connections', { backendStatus: { status }, settingsStarting: true });
    assert.equal(busy.walk(busy.tree.props.children[0]).find(node => node.type === 'button').props.disabled, true);
  }
});

test('缺失本地配置时仍显示客户端连接和健康检查，不渲染不存在的基础/TLS 或启动控件', () => {
  const ui = render('connections', { config: null, autoStartAvailable: false, isTauriRuntime: () => false });
  assert.deepEqual(ui.walk(ui.tree).filter(node => node.type === 'SettingsGroup').map(node => node.props.title), ['客户端连接', '服务健康检查']);
  assert.equal(ui.walk(ui.tree).filter(node => node.type === 'BackendHealthCard').length, 1);
});

test('模型页左侧服务/附件，右侧接口/推理，每个原模型字段完整且只渲染一次', () => {
  const ui = render('model'), columns = ui.tree.props.children;
  assert.deepEqual(ui.walk(columns[0]).filter(node => node.type === 'SettingsGroup').map(node => node.props.title), ['模型渠道', '附件能力']);
  assert.deepEqual(ui.walk(columns[1]).filter(node => node.type === 'SettingsGroup').map(node => node.props.title), ['接口与推理']);
  const keys = column => ui.walk(column).filter(node => node.type === 'fields').flatMap(node => Array.from(node.props.definitions, field => field.key));
  assert.deepEqual(keys(columns[0]), ['aiBaseUrl', 'aiApiKey', 'aiModelName']);
  assert.deepEqual(keys(columns[1]), ['aiCompletionsPath', 'aiEmbeddingsPath', 'aiReasoningEffort']);
  const all = [...keys(columns[0]), ...keys(columns[1])];
  assert.equal(new Set(all).size, all.length); assert.deepEqual(all, ui.keys);
  const media = ui.walk(columns[0]).find(node => node.type === 'MediaTypeEditor');
  media.props.change('text/plain\nimage/png'); assert.deepEqual(ui.changes, [['aiSupportedMediaTypes', 'text/plain\nimage/png']]);
});

test('基础设置保留可编辑端口及数据目录，移除快捷端口和派生路径展示', () => {
  const ui = render('connections');
  const group = ui.walk(ui.tree).find(node => node.type === 'SettingsGroup' && node.props.title === '基础设置');
  const definitions = ui.walk(group).find(node => node.type === 'fields').props.definitions;
  assert.deepEqual(Array.from(definitions, field => field.key), ['serverPort', 'dataDirectory']);
  assert.equal(ui.walk(group).filter(node => node.type === 'PathPreviewCard').length, 0);
  assert.doesNotMatch(dialog, /serverPortPresets|常用端口预设|当前使用自定义端口|settings-derived-paths/);
  assert.match(dialog, /id="backend-setting-serverPort" type="number" value=\{value\}[\s\S]*?min=\{1\} max=\{65535\}/);
  const css = source('components/BackendSettingsDialog.css');
  assert.match(css, /\.settings-builtin-address-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/s);
  assert.match(css, /@container settings-column \(max-width: 520px\) \{\s*\.settings-builtin-address-row \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test('内容区根据实际面板宽度分栏、窄屏单列，卡片不被等高行或旧的 940px 限宽', () => {
  const css = source('components/BackendSettingsDialog.css');
  assert.match(css, /\.settings-content-panel \{[^}]*container-type: inline-size;[^}]*container-name: settings-pane;/s);
  assert.match(css, /\.settings-page \.settings-content > \.settings-columns \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*align-items: start;[^}]*width: 100%;[^}]*max-width: none;[^}]*margin: 0;/s);
  assert.match(css, /@container settings-pane \(min-width: 1100px\) \{\s*\.settings-page \.settings-content > \.settings-columns \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.settings-columns \.settings-group \{[^}]*max-width: none;[^}]*margin: 0;/);
  assert.match(css, /@container settings-column \(max-width: 640px\)/);
  assert.match(css, /@container settings-column \(max-width: 520px\)/);
  assert.match(css, /@container settings-column \(max-width: 360px\)/);
  assert.doesNotMatch(css, /\.settings-column\s*\{[^}]*overflow:\s*(?:auto|scroll|hidden)/s);
});

test('仅两个指定分区扩大保存栏，保留独立底栏、滚动及原保存/重置入口', () => {
  const css = source('components/BackendSettingsDialog.css');
  assert.match(dialog, /<div className="settings-content-panel" data-section=\{activeSection\}>/);
  assert.match(css, /\.settings-content-panel:is\(\[data-section='general'\], \[data-section='model'\]\) \.settings-footer :is\(\.settings-tab-save, \.settings-footer-feedback\) \{[^}]*width: 100%;[^}]*max-width: none;/s);
  assert.match(css, /\.settings-content-panel > \.settings-content \{[^}]*overflow: auto;/s);
  assert.match(dialog, /<TabSaveBar scope=\{activeDefinition\.id\}/);
  assert.match(dialog, /onSave=\{\(\) => void saveTab\(activeSection\)\} onReset=\{\(\) => resetTab\(activeSection\)\}/);
  assert.equal(layouts.size, 2);
});

test('真实旧 flex 规则存在时，新网格规则优先级更高且列/卡片撑满等分轨道', () => {
  const appCss = source('App.css'), css = source('components/BackendSettingsDialog.css');
  const old = appCss.match(/(\.settings-content > div)\s*\{([^}]*)\}/);
  assert.ok(old); assert.match(old[2], /display: flex;/);
  const grid = css.match(/(\.settings-page \.settings-content > \.settings-columns)\s*\{([^}]*)\}/);
  assert.ok(grid); assert.match(grid[2], /display: grid;/);
  // Three classes beat one class + one element, regardless of CSS import order.
  const classes = selector => (selector.match(/\.[\w-]+/g) ?? []).length;
  assert.ok(classes(grid[1]) > classes(old[1]));
  assert.match(grid[2], /justify-content: normal;/);
  assert.match(css, /\.settings-columns > \.settings-column \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*width: 100%;[^}]*justify-self: stretch;/s);
  assert.match(css, /\.settings-columns \.settings-group \{[^}]*width: 100%;[^}]*max-width: none;/);
  assert.doesNotMatch(grid[2], /max-width:\s*\d/);
});
