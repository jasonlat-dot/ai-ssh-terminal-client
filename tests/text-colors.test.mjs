import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function load(path, requireModule, globals = {}) {
  const compiled = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, ...globals });
  vm.runInContext(`(function(exports, require) {\n${compiled}\n})(exports, require);`, context);
  return { api: context.exports, context, compiled };
}
function environment(raw) {
  const values = new Map(raw === undefined ? [] : [['agent-ssh-ui-text-colors-v1', raw]]);
  const state = { fail: false, writes: [] };
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { if (state.fail) throw new Error('denied'); state.writes.push(key); values.set(key, value); },
  };
  const loaded = load('state/clientTextColors.ts', () => { throw new Error('Unexpected import'); }, { localStorage });
  return { ...loaded, state, values, localStorage };
}
const plain = value => JSON.parse(JSON.stringify(value));
function root(theme = 'light') {
  const values = new Map(), attributes = [];
  const dataset = new Proxy({ theme, wallpaper: 'true' }, {
    set(target, name, value) { attributes.push(name); target[name] = value; return true; },
  });
  return { dataset, values, attributes, style: { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) } };
}

test('默认跟随主题；HEX 校验支持三/六位，不接受透明色、CSS 函数或注入', () => {
  const { api } = environment();
  assert.deepEqual(plain(api.readClientTextColors().palettes), { light: { primary: null, secondary: null }, dark: { primary: null, secondary: null } });
  assert.equal(api.normalizeTextColor(' #AbC '), '#aabbcc');
  assert.equal(api.normalizeTextColor('#AA1122'), '#aa1122');
  for (const invalid of ['red', 'transparent', '#11223344', '#12', 'var(--text)', '#123; background:url(x)', null, 123]) {
    assert.equal(api.normalizeTextColor(invalid), null);
  }
});

test('浅深主题及主辅角色独立，重启恢复；恢复当前主题不清除另一主题或壁纸偏好', () => {
  const { api, values, state } = environment();
  api.setClientTextColor('light', 'primary', '#123456');
  api.setClientTextColor('light', 'secondary', '#abc');
  api.setClientTextColor('dark', 'primary', '#ffffff');
  assert.deepEqual(plain(environment(values.get(api.TEXT_COLORS_KEY)).api.readClientTextColors()), plain(api.readClientTextColors()));
  api.resetClientTextColors('light');
  assert.deepEqual(plain(api.readClientTextColors().palettes), { light: { primary: null, secondary: null }, dark: { primary: '#ffffff', secondary: null } });
  assert.ok(state.writes.every(key => key === api.TEXT_COLORS_KEY), '不写主题选择、壁纸、后端地址或终端偏好');
});

test('存储失败及非法输入不覆盖已有颜色，错误明确，重试成功后清除错误', () => {
  const { api, state } = environment();
  api.setClientTextColor('light', 'primary', '#123456');
  const original = plain(api.readClientTextColors().palettes);
  state.fail = true;
  assert.equal(api.setClientTextColor('light', 'primary', '#ffffff'), false);
  assert.deepEqual(plain(api.readClientTextColors().palettes), original);
  assert.match(api.readClientTextColors().error, /保留原配色/);
  assert.equal(api.resetClientTextColors('light'), false);
  assert.deepEqual(plain(api.readClientTextColors().palettes), original);
  state.fail = false;
  assert.equal(api.setClientTextColor('light', 'secondary', 'url(x)'), false);
  assert.deepEqual(plain(api.readClientTextColors().palettes), original);
  assert.equal(api.setClientTextColor('light', 'secondary', '#abcdef'), true);
  assert.equal(api.readClientTextColors().error, null);
});

test('损坏配置回退默认，单个非法字段不丢弃其他合法值，未知版本不生效', () => {
  assert.equal(environment('{bad').api.readClientTextColors().palettes.light.primary, null);
  const { api } = environment(JSON.stringify({ version: 1, palettes: { light: { primary: '#abc', secondary: 'red' } } }));
  assert.equal(api.readClientTextColors().palettes.light.primary, '#aabbcc');
  assert.equal(api.readClientTextColors().palettes.light.secondary, null);
  assert.equal(api.readClientTextColors().palettes.dark.primary, null);
  assert.equal(environment(JSON.stringify({ version: 5, palettes: { light: { primary: '#fff' } } })).api.readClientTextColors().palettes.light.primary, null);
});

test('根节点颜色覆盖跟随实际主题，恢复默认删除覆盖变量，不写终端监听的属性', () => {
  const { api } = environment();
  const element = root();
  api.setClientTextColor('light', 'primary', '#123456');
  api.setClientTextColor('dark', 'secondary', '#abcdef');
  api.applyClientTextColors(element);
  assert.equal(element.values.get('--client-text-primary'), '#123456');
  assert.equal(element.dataset.clientTextSecondary, 'false');
  element.dataset.theme = 'dark'; element.attributes.length = 0;
  api.applyClientTextColors(element);
  assert.equal(element.values.has('--client-text-primary'), false);
  assert.equal(element.values.get('--client-text-secondary'), '#abcdef');
  api.resetClientTextColors('dark'); api.applyClientTextColors(element);
  assert.equal(element.values.size, 0);
  assert.ok(element.attributes.every(name => name === 'clientTextPrimary' || name === 'clientTextSecondary'));
  assert.equal(element.dataset.wallpaper, 'true');
});

test('热更新消费者共用快照和订阅，不让设置颜色与根节点分裂，取消订阅生效', () => {
  const { api, context, compiled } = environment();
  let delivered = 0;
  const stop = api.subscribeClientTextColors(() => delivered++);
  context.exports = {};
  vm.runInContext(`(function(exports, require) {\n${compiled}\n})(exports, require);`, context);
  const refreshed = context.exports;
  refreshed.setClientTextColor('light', 'primary', '#654321');
  assert.equal(api.readClientTextColors(), refreshed.readClientTextColors());
  assert.equal(delivered, 1);
  stop(); refreshed.resetClientTextColors('light');
  assert.equal(delivered, 1);
});

test('根安装监听真实主题与存储变更，卸载清理；不轮询、不写壁纸或主题属性', () => {
  const env = environment(), element = root();
  const events = new Map(), observers = [];
  let cleanup;
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.options = options; this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  const { api } = load('state/useClientTextColors.ts', name => {
    if (name === 'react') return { useLayoutEffect: callback => { cleanup = callback(); }, useSyncExternalStore() {} };
    if (name === './clientTextColors') return env.api;
    throw new Error(name);
  }, { document: { documentElement: element }, MutationObserver: Observer,
    window: { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) } });
  api.useApplyClientTextColors();
  env.api.setClientTextColor('light', 'primary', '#123456');
  assert.equal(element.values.get('--client-text-primary'), '#123456');
  assert.deepEqual(plain(observers[0].options.attributeFilter), ['data-theme']);
  element.dataset.theme = 'dark'; observers[0].callback();
  assert.equal(element.values.has('--client-text-primary'), false);
  env.values.set(env.api.TEXT_COLORS_KEY, JSON.stringify({ version: 1, palettes: { dark: { secondary: '#abc' } } }));
  events.get('storage')({ key: env.api.TEXT_COLORS_KEY });
  assert.equal(element.values.get('--client-text-secondary'), '#aabbcc');
  cleanup();
  assert.equal(events.size, 0); assert.equal(observers[0].disconnected, true);
  assert.equal(element.values.size, 0);
  assert.equal(element.dataset.clientTextPrimary, undefined);
});

/** 实际控件 hook 驱动器，验证不完整 HEX 不被提前提交，不读用户 DOM 或存储。 */
function controlsHarness() {
  const env = environment(), slots = [], effects = [];
  let cursor = 0, tree, theme = 'light';
  const node = (type, props) => ({ type, props: props ?? {} });
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }]; },
    useEffect(callback, deps) { const index = cursor++; if (slots[index] && deps.every((value, i) => value === slots[index][i])) return;
      slots[index] = deps; effects.push(callback); },
  };
  const { api } = load('components/TextColorSettings.tsx', name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name.endsWith('/clientTextColors')) return env.api;
    if (name.endsWith('/useClientTextColors')) return { useClientTextColors: () => ({ ...env.api.readClientTextColors(), theme }) };
    throw new Error(name);
  });
  function expand(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expand);
    if (typeof value.type === 'function') return expand(value.type(value.props));
    return { ...value, props: { ...value.props, children: expand(value.props.children) } };
  }
  function nodes(value) {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(nodes);
    return [value, ...nodes(value.props.children)];
  }
  function text(value) {
    if (value == null) return '';
    if (typeof value !== 'object') return String(value);
    return Array.isArray(value) ? value.map(text).join('') : text(value.props.children);
  }
  function render() { cursor = 0; tree = expand(api.TextColorSettings()); effects.splice(0).forEach(callback => callback()); }
  const input = role => nodes(tree).find(item => item.props.id === `text-${role}-hex`);
  render(); render();
  return { env, input, render, text: () => text(tree), find: predicate => nodes(tree).find(predicate), changeTheme(value) { theme = value; render(); render(); } };
}

test('HEX 中间输入不写存储，无效值提示，六位即时保存，三位失焦规范化', () => {
  const ui = controlsHarness();
  ui.input('primary').props.onChange({ target: { value: '#1' } }); ui.render();
  assert.equal(ui.env.state.writes.length, 0);
  ui.input('primary').props.onBlur(); ui.render();
  assert.equal(ui.input('primary').props['aria-invalid'], true);
  assert.match(ui.text(), /请输入 #RGB 或 #RRGGBB/);
  ui.input('primary').props.onChange({ target: { value: '#112233' } }); ui.render(); ui.render();
  assert.equal(ui.env.api.readClientTextColors().palettes.light.primary, '#112233');
  assert.equal(ui.input('primary').props['aria-invalid'], false);
  ui.input('secondary').props.onChange({ target: { value: '#abc' } }); ui.render();
  assert.equal(ui.env.api.readClientTextColors().palettes.light.secondary, null);
  ui.input('secondary').props.onBlur(); ui.render(); ui.render();
  assert.equal(ui.env.api.readClientTextColors().palettes.light.secondary, '#aabbcc');
  assert.equal(ui.input('secondary').props.value, '#AABBCC');
});

test('选择器实时保存，浅深主题切换控件正确同步；恢复只影响当前主题', () => {
  const ui = controlsHarness();
  const picker = () => ui.find(item => item.props['aria-label'] === '选择主要文字颜色');
  picker().props.onChange({ target: { value: '#345678' } }); ui.render(); ui.render();
  ui.changeTheme('dark');
  assert.match(ui.text(), /深色主题/);
  assert.equal(picker().props.value, '#dce8f6');
  picker().props.onChange({ target: { value: '#fedcba' } }); ui.render(); ui.render();
  const reset = ui.find(item => item.type === 'button');
  assert.equal(reset.props.disabled, false); reset.props.onClick(); ui.render(); ui.render();
  assert.equal(ui.env.api.readClientTextColors().palettes.dark.primary, null);
  assert.equal(ui.env.api.readClientTextColors().palettes.light.primary, '#345678');
  ui.changeTheme('light');
  assert.equal(ui.input('primary').props.value, '#345678');
});

test('颜色控件保存失败保留原值并显示错误，不假装已采用新颜色', () => {
  const ui = controlsHarness();
  ui.env.state.fail = true;
  ui.input('primary').props.onChange({ target: { value: '#123456' } }); ui.render(); ui.render();
  assert.equal(ui.env.api.readClientTextColors().palettes.light.primary, null);
  assert.equal(ui.input('primary').props.value, '#25364C');
  assert.match(ui.text(), /无法保存文字颜色/);
  ui.env.state.fail = false;
  ui.input('primary').props.onChange({ target: { value: '#123456' } }); ui.render(); ui.render();
  assert.equal(ui.env.api.readClientTextColors().palettes.light.primary, '#123456');
  assert.doesNotMatch(ui.text(), /无法保存文字颜色/);
});

test('普通界面变量覆盖与代码/状态/终端隔离有独立边界，无全元素强制染色或 ANSI 修改', () => {
  const css = source('client-text-colors.css');
  assert.match(css, /--client-original-strong: var\(--theme-text-strong\)/);
  assert.match(css, /--settings-text: var\(--client-text-primary\)/);
  assert.match(css, /--settings-text-muted: var\(--client-text-secondary\)/);
  assert.match(css, /\.xterm, \.remote-terminal-screen, pre, \.markdown-body code, \.markdown-code-card/);
  assert.match(css, /\.primary-button, \.danger-button, \.send-button/);
  assert.match(css, /\[role='alert'\]/);
  assert.doesNotMatch(css, /!important|\*\s*\{|--syntax-/);
  assert.doesNotMatch(source('state/clientTextColors.ts'), /root\.dataset\.(theme|wallpaper)\s*=(?!=)/);
});

test('终端欢迎页的普通标题、说明和指引按钮支持主辅颜色，不改变状态、实色按钮及图标', () => {
  const css = source('client-text-colors.css');
  const primary = css.match(/:root\[data-client-text-primary='true'\]\[data-theme\] \.app-shell :is\(([\s\S]*?)\) \{ color: var\(--client-text-primary\); \}/)?.[1];
  const secondary = css.match(/:root\[data-client-text-secondary='true'\]\[data-theme\] \.app-shell :is\(([\s\S]*?)\) \{ color: var\(--client-text-secondary\); \}/)?.[1];
  assert.ok(primary);
  assert.ok(secondary);
  for (const selector of ['.terminal-welcome h2', '.welcome-features h3', '.welcome-guide']) {
    assert.ok(primary.includes(selector), `${selector} 应跟随主要文字颜色`);
  }
  for (const selector of ['.welcome-description', '.welcome-features p', '.welcome-demo-note']) {
    assert.ok(secondary.includes(selector), `${selector} 应跟随辅助文字颜色`);
  }
  assert.doesNotMatch(primary + secondary, /\.welcome-ready|\.welcome-create|\.welcome-art-label|\.welcome-feature-icon/);
  // 覆盖只在用户设置对应颜色时开启，恢复默认仍由原浅/深主题及 hover 样式负责。
  const original = source('components/TerminalWelcome.css');
  assert.match(original, /\.welcome-create \{ color: white;/);
  assert.match(original, /\.welcome-ready \{[^}]*color: #009f8a/);
  assert.match(original, /:root\[data-theme='dark'\] \.terminal-welcome h2/);
});
