import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function load(path, requireModule = () => { throw new Error('Unexpected import'); }) {
  const compiled = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule });
  vm.runInContext(compiled, context); return context.exports;
}
const geometry = load('state/panelResize.ts');

test('像素和百分比边界：精确最小值不折叠、小于最小值折叠、最大值预留工作区', () => {
  const commands = geometry.panelBounds(800, 'pixels', 220, 450, 0, 280);
  assert.equal(geometry.resizePanel(220, commands).collapsed, false);
  assert.equal(geometry.resizePanel(219, commands).collapsed, true);
  assert.equal(geometry.resizePanel(800, commands).value, 450);
  assert.equal(geometry.panelBounds(600, 'pixels', 220, 450, 0, 280).max, 320);
  const agent = geometry.panelBounds(1200, 'percent', 18, 50, 300, 640);
  assert.equal(agent.min, 25); assert.equal(agent.factor, 12);
  assert.equal(geometry.resizePanel(24.9, agent).collapsed, true);
  assert.equal(geometry.resizePanel(25, agent).collapsed, false);
  assert.equal(agent.max, 560 / 12);
  assert.equal(geometry.panelBounds(0, 'pixels', 220, 450), null);
  assert.equal(geometry.panelBounds(NaN, 'pixels', 220, 450), null);
  assert.equal(geometry.resizePanel(NaN, commands), null);
});

function divider(overrides = {}) {
  const slots = [], effects = []; let cursor = 0, tree;
  const state = { width: overrides.unit === 'pixels' ? 260 : 22, collapsed: false, changes: [], collapseCount: 0 };
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) { const index = cursor++, previous = slots[index];
      if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i]))) {
        slots[index] = { deps, cleanup: null }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const node = (type, props) => ({ type, props });
  const { PanelDivider } = load('components/PanelDivider.tsx', name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === '../state/panelResize') return geometry;
    throw new Error(name);
  });
  const captures = new Set(), container = {
    getBoundingClientRect: () => ({ width: 1200, left: 0 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 280 }) }),
  };
  const element = { closest: () => container, focus() {},
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id),
  };
  function render() {
    cursor = 0;
    tree = PanelDivider({ value: state.width, collapsed: state.collapsed,
      change(value) { state.width = value; state.changes.push(value); }, collapse() { state.collapsed = true; state.collapseCount++; }, ...overrides });
    while (effects.length) effects.shift()(); return tree;
  }
  function event(name, payload = {}) {
    tree.props[name]({ button: 0, currentTarget: element, pointerId: 1, clientX: 900, preventDefault() {}, ...payload }); render();
  }
  render();
  return { state, captures, event, render, container, tree: () => tree,
    unmount: () => { for (const slot of slots) slot?.cleanup?.(); } };
}

for (const [unit, options, start, min, toMinimum] of [
  ['pixels', { min: 220, max: 450, defaultValue: 260, reservePixels: 280 }, 260, 220, 940],
  ['percent', { minPixels: 300, reservePixels: 360, reserveSelector: '.central-workspace' }, 22, 25, 900],
]) {
  test(`${unit}：向右低于最小宽度收起，保留最后宽度，重新展开不重置`, () => {
    const ui = divider({ unit, ...options });
    assert.equal(ui.state.width, start);
    ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: toMinimum });
    assert.equal(ui.state.width, min); assert.equal(ui.state.collapsed, false);
    ui.event('onPointerMove', { clientX: toMinimum + 1 });
    assert.equal(ui.state.collapsed, true); assert.equal(ui.state.width, min);
    assert.equal(ui.state.collapseCount, 1); assert.equal(ui.captures.size, 0);
    assert.equal(ui.tree().props.tabIndex, -1);
    ui.event('onPointerMove', { clientX: 300 }); assert.equal(ui.state.width, min);
    ui.state.collapsed = false; ui.render(); assert.equal(ui.state.width, min);
    ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 840 });
    assert.ok(ui.state.width > min); assert.equal(ui.state.collapsed, false);
    ui.event('onPointerUp'); assert.equal(ui.captures.size, 0);
  });
}

test('双击默认、键盘调整与吸附收起；取消拖动不残留捕获，非主键/其他指针不修改', () => {
  const ui = divider({ unit: 'pixels', min: 220, max: 450, defaultValue: 260 });
  ui.event('onPointerDown', { button: 2 }); assert.equal(ui.captures.size, 0);
  ui.event('onPointerDown'); ui.event('onPointerMove', { pointerId: 2, clientX: 300 }); assert.equal(ui.state.width, 260);
  ui.event('onPointerMove', { clientX: 850 }); assert.equal(ui.state.width, 310);
  ui.event('onPointerCancel'); ui.event('onPointerMove', { clientX: 750 }); assert.equal(ui.state.width, 310);
  assert.equal(ui.captures.size, 0);
  ui.event('onDoubleClick'); assert.equal(ui.state.width, 260);
  ui.event('onKeyDown', { key: 'End' }); assert.equal(ui.state.width, 450);
  ui.event('onKeyDown', { key: 'Home' }); assert.equal(ui.state.width, 220);
  ui.event('onKeyDown', { key: 'ArrowRight' }); assert.equal(ui.state.collapsed, true); assert.equal(ui.state.width, 220);
  ui.state.collapsed = false; ui.render(); ui.event('onPointerDown'); ui.unmount(); assert.equal(ui.captures.size, 0);
});

test('折叠智能体不会禁用命令侧栏拖动；只改变面板布局，不卸载会话或对话', () => {
  const app = source('App.tsx'), css = source('reference.css'), resize = source('panel-resize.css');
  assert.match(app, /className="command-panel-divider"[\s\S]*collapse=\{\(\) => setCommandCollapsed\(true\)\}/);
  assert.match(app, /controls="agent-panel-content"[\s\S]*collapse=\{\(\) => setAgentCollapsed\(true\)\}/);
  assert.match(css, /\.app-shell\.agent-collapsed > \.panel-divider/);
  assert.doesNotMatch(css, /\.app-shell\.agent-collapsed \.panel-divider/);
  assert.match(resize, /var\(--command-width, 260px\)/);
  assert.match(resize, /\.command-shelf\.collapsed > \.command-panel-divider/);
  assert.doesNotMatch(app, /!agentCollapsed && <AgentPanel|!commandCollapsed && <CommandShelf/);
});
