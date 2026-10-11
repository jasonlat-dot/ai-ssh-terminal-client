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
  const context = vm.createContext({ exports: {}, require: requireModule, ...globals });
  vm.runInContext(`(function(exports, require) {${compiled}\n})(exports, require);`, context);
  return { api: context.exports, context, compiled };
}
function environment(raw) {
  const key = 'agent-ssh-ui-typography-v1';
  const values = new Map(raw === undefined ? [] : [[key, raw]]), state = { fail: false, writes: [] };
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (state.fail) throw new Error('denied'); state.writes.push(key); values.set(key, value); },
  };
  return { ...load('state/clientTypography.ts', undefined, { localStorage }), values, state };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('本机字体名与 100–1000 整数字重验证；拒绝 CSS、路径及非数字字重', () => {
  const { api } = environment();
  assert.equal(api.normalizeFontFamily(' 微软雅黑 '), '微软雅黑');
  assert.equal(api.normalizeFontFamily('Consolas'), 'Consolas');
  for (const value of ['', 'x'.repeat(81), 'url(x)', 'C:\\Fonts\\font.ttf', 'Arial; color:red', 'Arial,serif', null]) {
    assert.equal(api.normalizeFontFamily(value), null);
  }
  for (const value of [100, 400, 700, 1000]) assert.equal(api.normalizeFontWeight(value), value);
  for (const value of [99, 1001, 700.5, NaN, Infinity, '700', null]) assert.equal(api.normalizeFontWeight(value), null);
});

test('字体及两个字重独立持久化，重启恢复；默认恢复不修改配色、壁纸及后端', () => {
  const { api, values, state } = environment();
  assert.deepEqual(plain(api.readClientTypography()), { family: null, normalWeight: null, boldWeight: null, error: null });
  assert.equal(api.setClientFontFamily('Consolas'), true);
  assert.equal(api.setClientFontWeight('normalWeight', 700), true);
  assert.equal(api.setClientFontWeight('boldWeight', 1000), true);
  assert.deepEqual(plain(environment(values.get(api.TYPOGRAPHY_KEY)).api.readClientTypography()), plain(api.readClientTypography()));
  api.setClientFontFamily(null);
  assert.equal(api.readClientTypography().normalWeight, 700);
  api.resetClientTypography();
  assert.deepEqual(plain(api.readClientTypography()), { family: null, normalWeight: null, boldWeight: null, error: null });
  assert.ok(state.writes.every(key => key === api.TYPOGRAPHY_KEY));
});

test('存储失败与非法输入保留旧值；合法重试清除错误', () => {
  const { api, state } = environment();
  api.setClientFontFamily('Arial'); state.fail = true;
  assert.equal(api.setClientFontFamily('Consolas'), false);
  assert.equal(api.readClientTypography().family, 'Arial');
  assert.match(api.readClientTypography().error, /保留原设置/);
  assert.equal(api.resetClientTypography(), false);
  assert.equal(api.readClientTypography().family, 'Arial');
  state.fail = false;
  assert.equal(api.setClientFontWeight('normalWeight', 99), false);
  assert.equal(api.readClientTypography().normalWeight, null);
  assert.equal(api.setClientFontFamily('Arial; color:red'), false);
  assert.equal(api.readClientTypography().family, 'Arial');
  assert.equal(api.setClientFontWeight('normalWeight', 500), true);
  assert.equal(api.readClientTypography().error, null);
});

test('损坏配置和未知版本回退；个别非法字段不覆盖合法设置', () => {
  assert.equal(environment('{bad').api.readClientTypography().family, null);
  const { api } = environment(JSON.stringify({ version: 1, family: 'Consolas', normalWeight: '700', boldWeight: 1000 }));
  assert.equal(api.readClientTypography().family, 'Consolas');
  assert.equal(api.readClientTypography().normalWeight, null);
  assert.equal(api.readClientTypography().boldWeight, 1000);
  assert.equal(environment(JSON.stringify({ version: 9, family: 'Consolas' })).api.readClientTypography().family, null);
});

test('热更新共用存储和订阅，取消订阅后不再通知', () => {
  const { api, context, compiled } = environment(); let delivered = 0;
  const stop = api.subscribeClientTypography(() => delivered++);
  context.exports = {};
  vm.runInContext(`(function(exports, require) {${compiled}\n})(exports, require);`, context);
  context.exports.setClientFontFamily('Arial');
  assert.equal(context.exports.readClientTypography(), api.readClientTypography());
  assert.equal(delivered, 1); stop(); context.exports.resetClientTypography(); assert.equal(delivered, 1);
});

test('根订阅只写字体专用属性；跨窗口存储同步，卸载删除监听及变量', () => {
  const env = environment(), variables = new Map(), events = new Map(); let cleanup;
  const root = { dataset: { theme: 'dark', wallpaper: 'true' }, style: {
    setProperty: (key, value) => variables.set(key, value), removeProperty: key => variables.delete(key),
  } };
  const { api } = load('state/useClientTypography.ts', name => {
    if (name === 'react') return { useLayoutEffect: callback => { cleanup = callback(); }, useSyncExternalStore() {} };
    if (name === './clientTypography') return env.api;
    throw new Error(name);
  }, { document: { documentElement: root }, window: {
    addEventListener: (key, value) => events.set(key, value), removeEventListener: key => events.delete(key),
  } });
  api.useApplyClientTypography(); env.api.setClientFontFamily('Consolas'); env.api.setClientFontWeight('normalWeight', 700);
  assert.equal(variables.get('--client-ui-font'), '"Consolas", var(--client-original-font)');
  assert.equal(variables.get('--client-ui-weight-normal'), '700');
  assert.equal(root.dataset.theme, 'dark'); assert.equal(root.dataset.wallpaper, 'true');
  env.values.set(env.api.TYPOGRAPHY_KEY, JSON.stringify({ version: 1, family: 'Arial', boldWeight: 900 }));
  events.get('storage')({ key: env.api.TYPOGRAPHY_KEY });
  assert.equal(variables.get('--client-ui-font'), '"Arial", var(--client-original-font)');
  assert.equal(variables.get('--client-ui-weight-bold'), '900');
  cleanup(); assert.equal(variables.size, 0); assert.equal(events.size, 0);
  assert.deepEqual(root.dataset, { theme: 'dark', wallpaper: 'true' });
});

function controls() {
  const env = environment(), instances = new Map(); let current, tree;
  const node = (type, props, key) => {
    if (typeof type !== 'function') return { type, props: props ?? {} };
    const previous = current, id = `${type.name}:${key ?? props?.role ?? ''}`;
    const instance = instances.get(id) ?? { slots: [] }; instances.set(id, instance);
    current = { ...instance, cursor: 0 }; const result = type(props); current = previous; return result;
  };
  const hooks = {
    useState(initial) { const index = current.cursor++, instance = current;
      if (!(index in instance.slots)) instance.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [instance.slots[index], value => { instance.slots[index] = typeof value === 'function' ? value(instance.slots[index]) : value; }];
    },
    useEffect(callback, deps) { const index = current.cursor++, previous = current.slots[index];
      if (!previous || !deps.every((value, i) => Object.is(value, previous[i]))) { current.slots[index] = deps; callback(); }
    },
  };
  const { api } = load('components/TypographySettings.tsx', name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === '../state/clientTypography') return env.api;
    if (name === '../state/useClientTypography') return { useClientTypography: env.api.readClientTypography };
    throw new Error(name);
  });
  function render() { tree = node(api.TypographySettings, {}); return tree; }
  function find(predicate, candidate = tree) {
    if (Array.isArray(candidate)) { for (const child of candidate) { const found = find(predicate, child); if (found) return found; } return; }
    if (!candidate?.props) return;
    if (predicate(candidate)) return candidate;
    return find(predicate, candidate.props.children ?? null);
  }
  render(); render();
  return { ...env, render, find, input: id => find(node => node.props.id === id),
    change(id, value) { this.input(id).props.onChange({ target: { value } }); render(); render(); } };
}

test('真实字体控件：预设/自定义/恢复默认、无效与部分字重输入、保存失败保留原值', () => {
  const ui = controls();
  ui.change('ui-font-family', 'Consolas'); assert.equal(ui.api.readClientTypography().family, 'Consolas');
  ui.change('ui-normalWeight', '7'); assert.equal(ui.api.readClientTypography().normalWeight, null);
  ui.input('ui-normalWeight').props.onBlur(); ui.render(); assert.equal(ui.input('ui-normalWeight').props['aria-invalid'], true);
  ui.change('ui-normalWeight', '700'); assert.equal(ui.api.readClientTypography().normalWeight, 700);
  ui.change('ui-boldWeight', '1000'); assert.equal(ui.api.readClientTypography().boldWeight, 1000);
  ui.change('ui-font-family', 'custom'); ui.change('ui-custom-font', '自定义字体');
  ui.input('ui-custom-font').props.onBlur(); ui.render(); ui.render();
  assert.equal(ui.api.readClientTypography().family, '自定义字体');
  ui.state.fail = true; ui.change('ui-normalWeight', '500');
  assert.equal(ui.api.readClientTypography().normalWeight, 700); assert.equal(ui.input('ui-normalWeight').props.value, '700');
  ui.state.fail = false;
  ui.find(node => node.type === 'button').props.onClick(); ui.render(); ui.render();
  assert.equal(ui.api.readClientTypography().family, null); assert.equal(ui.find(node => node.type === 'button').props.disabled, true);
});

test('普通字体规则与代码、终端、公式隔离；安装根订阅而不改变终端设置', () => {
  const css = source('client-typography.css');
  assert.match(css, /\.xterm, \.remote-terminal-screen, \.terminal-output, pre, code,[\s\S]*\.katex/);
  assert.match(css, /--font-ui: var\(--client-original-font\)/);
  assert.match(css, /--weight-body: var\(--client-original-weight-body\)/);
  assert.doesNotMatch(css, /--mono:|font-size:|opacity:|:not\(\*\)/);
  assert.match(source('App.tsx'), /useApplyClientTypography\(\)/);
});
