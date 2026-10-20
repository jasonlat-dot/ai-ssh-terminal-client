import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import postcss from 'postcss';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function environment(saved, osDark = false, failStorage = false) {
  const values = new Map(saved === undefined ? [] : [['agent-ssh-theme', saved]]);
  const root = { dataset: {}, style: {} };
  let osReads = 0, state;
  const context = vm.createContext({ exports: {}, document: { documentElement: root },
    localStorage: { getItem: key => { if (failStorage) throw Error('denied'); return values.get(key) ?? null; }, setItem: (key, value) => { if (failStorage) throw Error('denied'); values.set(key, value); } },
    matchMedia: () => { osReads++; return { matches: osDark }; },
    require: name => { assert.equal(name, 'react'); return {
      useState: init => [state ??= init(), value => { state = value; }],
      useLayoutEffect: effect => effect(),
    }; },
  });
  vm.runInContext('window = { matchMedia };', context);
  const compiled = ts.transpileModule(read('src/state/useTheme.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(compiled, context);
  return { root, values, render: () => context.exports.useTheme(), osReads: () => osReads,
    bootstrap: () => vm.runInContext(read('index.html').match(/<script>([\s\S]*?)<\/script>/)[1], context) };
}

test('三个固定主题首次默认柔光白，选择与重启一致，无系统订阅', () => {
  const fresh = environment(undefined, true);
  assert.equal(fresh.render().theme, 'light'); assert.equal(fresh.osReads(), 0);
  for (const theme of ['light', 'dark', 'night']) {
    const env = environment(theme, true); env.bootstrap();
    const firstPaint = JSON.stringify(env.root);
    const hook = env.render();
    assert.equal(hook.theme, theme); assert.equal(JSON.stringify(env.root), firstPaint);
    assert.equal(env.root.dataset.theme, theme === 'light' ? 'light' : 'dark');
    assert.equal(env.root.dataset.themePreference, theme); assert.equal(env.osReads(), 0);
    hook.setTheme('night'); env.render();
    assert.equal(env.values.get('agent-ssh-theme'), 'night');
    assert.equal(environment(env.values.get('agent-ssh-theme')).render().theme, 'night');
  }
});

test('旧跟随系统只迁移一次，损坏或禁用存储不影响启动', () => {
  for (const dark of [false, true]) {
    const env = environment('system', dark); env.bootstrap(); env.render(); env.render();
    assert.equal(env.values.get('agent-ssh-theme'), dark ? 'dark' : 'light');
    assert.equal(env.osReads(), 1);
    const withoutBootstrap = environment('system', dark); withoutBootstrap.render(); withoutBootstrap.render();
    assert.equal(withoutBootstrap.osReads(), 1);
  }
  for (const saved of ['invalid', undefined]) assert.equal(environment(saved, true).render().theme, 'light');
  const denied = environment('night', true, true); denied.bootstrap();
  const hook = denied.render(); assert.equal(hook.theme, 'light');
  hook.setTheme('night'); denied.render(); assert.equal(denied.root.dataset.themePreference, 'night');
});

test('主题浮层点击不会冒泡到标题栏拖动，鼠标和键盘选择均更新主题与存储', () => {
  const env = environment('dark'); env.render();
  const slots = []; let cursor = 0, focused = 0, dragging = 0;
  const node = (type, props) => ({ type, props });
  const context = vm.createContext({ exports: {}, document: { body: {} }, require: name => {
    if (name === 'react') return {
      useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef: initial => { const i = cursor++; return slots[i] ??= { current: initial }; },
      useId: () => 'theme', useEffect() {}, useLayoutEffect() {},
    };
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === 'react-dom') return { createPortal: child => child };
    if (name === './Ui') return { Icon() {} };
    if (name.endsWith('.css')) return {};
    throw Error(name);
  } });
  vm.runInContext(ts.transpileModule(read('src/components/Select.tsx'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, context);
  const options = [{ value: 'light', label: '柔光白' }, { value: 'dark', label: '暮雾灰' }, { value: 'night', label: '夜幕黑' }];
  const render = () => { cursor = 0; const theme = env.render(); return context.exports.Select({ value: theme.theme, onChange: theme.setTheme, options }).props.children; };
  let [trigger] = render(); trigger.props.ref.current = { focus: () => focused++ };
  trigger.props.onClick(); let [, menu] = render();
  let prevented = false, stopped = false;
  menu.props.onMouseDown({ preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  if (!stopped) dragging++;
  assert.ok(prevented && stopped); assert.equal(dragging, 0);
  menu.props.children[2].props.onClick(); [trigger, menu] = render();
  assert.equal(menu, false); assert.equal(trigger.props.children[0].props.children, '夜幕黑');
  assert.equal(env.root.dataset.themePreference, 'night'); assert.equal(env.values.get('agent-ssh-theme'), 'night'); assert.equal(focused, 1);
  const key = value => { trigger.props.onKeyDown({ key: value, preventDefault() {}, stopPropagation() {} }); [trigger] = render(); };
  key('ArrowDown'); key('Home'); key('Enter');
  assert.equal(env.root.dataset.theme, 'light'); assert.equal(env.values.get('agent-ssh-theme'), 'light');
});

test('夜幕黑样式只覆盖命名主题颜色，保留壁纸与现有动效、布局', () => {
  const css = postcss.parse(read('src/night-theme.css'));
  css.walkAtRules(rule => assert.fail(`Unexpected at-rule ${rule.name}`));
  css.walkRules(rule => {
    for (const selector of rule.selectors) assert.match(selector, /:root\[data-theme='dark'\]\[data-theme-preference='night'\]/);
    rule.walkDecls(decl => {
      assert.ok(decl.prop.startsWith('--') || /^(color|background(?:-image|-color)?|border-color|box-shadow|fill|stroke)$/.test(decl.prop), `No layout or motion override: ${decl.prop}`);
      if (/^(background|box-shadow)/.test(decl.prop)) {
        for (const selector of rule.selectors) assert.ok(selector.includes(":not([data-wallpaper='true'])"), selector);
      }
    });
  });
  const properties = new Map();
  css.walkRules(rule => { if (rule.selector === ":root[data-theme='dark'][data-theme-preference='night']") rule.walkDecls(decl => properties.set(decl.prop, decl.value)); });
  assert.equal(properties.get('--bg'), '#101216');
  assert.equal(properties.get('--theme-panel'), '#22262d');
  assert.equal(properties.get('--terminal-canvas-bg'), '#161a20');
  assert.equal(properties.get('--ui-accent'), '#a8bce2');
});
