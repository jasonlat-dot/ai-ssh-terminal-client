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
  const slots = [], effects = [], listeners = new Map(); let cursor = 0, tree;
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
  }, { window: { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) } });
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
    blur: () => { listeners.get('blur')(); render(); },
    unmount: () => { for (const slot of slots) slot?.cleanup?.(); } };
}

for (const [unit, options, start, min, toMinimum] of [
  ['pixels', { min: 220, max: 450, defaultValue: 260, reservePixels: 280 }, 260, 220, 940],
  ['percent', { minPixels: 300, reservePixels: 360, reserveSelector: '.central-workspace' }, 22, 25, 900],
]) {
  test(`${unit}：向右低于最小宽度只预提示，松开才收起，保留最后宽度，重新展开不重置`, () => {
    const ui = divider({ unit, ...options });
    assert.equal(ui.state.width, start);
    ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: toMinimum });
    assert.equal(ui.state.width, min); assert.equal(ui.state.collapsed, false);
    ui.event('onPointerMove', { clientX: toMinimum + 1 });
    assert.equal(ui.state.collapsed, false); assert.equal(ui.state.width, min);
    assert.equal(ui.state.collapseCount, 0); assert.equal(ui.captures.size, 1);
    assert.match(ui.tree().props.className, /collapse-pending/);
    assert.match(ui.tree().props['aria-valuetext'], /松开鼠标收起/);
    assert.ok(ui.tree().props.children.find(child => child?.props?.className === 'panel-collapse-hint'));
    ui.event('onPointerUp', { pointerId: 2, clientX: toMinimum + 1 });
    assert.equal(ui.state.collapseCount, 0); assert.equal(ui.captures.size, 1);
    ui.event('onPointerUp', { clientX: toMinimum + 1 });
    assert.equal(ui.state.collapsed, true); assert.equal(ui.state.width, min);
    assert.equal(ui.state.collapseCount, 1); assert.equal(ui.captures.size, 0);
    assert.equal(ui.tree().props.tabIndex, -1);
    ui.event('onPointerMove', { clientX: 300 }); assert.equal(ui.state.width, min);
    ui.state.collapsed = false; ui.render(); assert.equal(ui.state.width, min);
    ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 840 });
    assert.ok(ui.state.width > min); assert.equal(ui.state.collapsed, false);
    ui.event('onPointerUp', { clientX: 840 }); assert.equal(ui.captures.size, 0);
  });
}

test('拖回阈值内撤销收起预告；松手以最终位置为准，不使用上一次 move 的状态', () => {
  const ui = divider({ unit: 'pixels', min: 220, max: 450, collapseLabel: '常用命令' });
  ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 1000 });
  assert.match(ui.tree().props['aria-valuetext'], /常用命令/);
  ui.event('onPointerMove', { clientX: 930 });
  assert.equal(ui.state.width, 230); assert.equal(ui.tree().props['aria-valuetext'], undefined);
  assert.doesNotMatch(ui.tree().props.className, /collapse-pending/);
  ui.event('onPointerUp', { clientX: 930 }); assert.equal(ui.state.collapseCount, 0);
  ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 1000 });
  ui.event('onPointerUp', { clientX: 890 });
  assert.equal(ui.state.collapseCount, 0); assert.equal(ui.state.width, 240);
  ui.event('onPointerDown'); ui.event('onPointerUp', { clientX: 1000 });
  assert.equal(ui.state.collapseCount, 1); assert.equal(ui.state.width, 220);
});

test('连接管理向左缩小：越过最小宽度先预提示，放开才收起，重新展开保留宽度', () => {
  const ui = divider({ side: 'left', unit: 'pixels', min: 194, max: 360, collapseLabel: '连接管理' });
  ui.state.width = 224; ui.render();
  assert.match(ui.tree().props.title, /向左缩至/);
  ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 870 });
  assert.equal(ui.state.width, 194); assert.equal(ui.state.collapseCount, 0);
  assert.equal(ui.tree().props['aria-valuetext'], undefined);
  ui.event('onPointerMove', { clientX: 869 });
  assert.equal(ui.state.collapseCount, 0); assert.equal(ui.captures.size, 1);
  assert.match(ui.tree().props['aria-valuetext'], /松开鼠标收起连接管理，向右拖回可取消/);
  assert.ok(ui.tree().props.children.find(child => child?.props?.className === 'panel-collapse-hint'));
  ui.event('onPointerUp', { pointerId: 2, clientX: 869 }); assert.equal(ui.state.collapseCount, 0);
  ui.event('onPointerUp', { clientX: 869 }); assert.equal(ui.state.collapseCount, 1);
  assert.equal(ui.captures.size, 0); assert.equal(ui.state.width, 194);
  ui.state.collapsed = false; ui.render();
  ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 950 });
  assert.equal(ui.state.width, 244); assert.equal(ui.state.collapsed, false);
  ui.event('onPointerUp', { clientX: 950 }); assert.equal(ui.state.collapseCount, 1);
});

test('连接管理向右拖回撤销预告，取消、Esc、失焦与失去捕获都不误收起', () => {
  const ui = divider({ side: 'left', unit: 'pixels', min: 194, max: 360, collapseLabel: '连接管理' });
  ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 820 });
  assert.match(ui.tree().props.className, /collapse-pending/);
  ui.event('onPointerMove', { clientX: 850 }); assert.equal(ui.state.width, 210);
  assert.equal(ui.tree().props['aria-valuetext'], undefined);
  ui.event('onPointerUp', { clientX: 850 }); assert.equal(ui.state.collapseCount, 0);
  for (const cancel of ['onPointerCancel', 'onLostPointerCapture', 'Escape', 'blur']) {
    ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 800 });
    assert.match(ui.tree().props.className, /collapse-pending/);
    if (cancel === 'Escape') ui.event('onKeyDown', { key: 'Escape' });
    else if (cancel === 'blur') ui.blur(); else ui.event(cancel);
    ui.event('onPointerUp', { clientX: 800 });
    assert.equal(ui.state.collapseCount, 0); assert.equal(ui.captures.size, 0);
    assert.doesNotMatch(ui.tree().props.className, /collapse-pending|dragging/);
  }
  ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 800 });
  ui.event('onPointerUp', { clientX: 950 }); assert.equal(ui.state.collapseCount, 0);
});

test('连接管理边界预留真实导航和 Agent 宽度，左右键方向、双击与禁用状态正确', () => {
  const ui = divider({ side: 'left', unit: 'pixels', min: 194, max: 360, defaultValue: 224,
    reservePixels: 364, reserveWidthSelectors: '.activity-bar, .agent-panel' });
  ui.container.getBoundingClientRect = () => ({ width: 1000, left: 0 });
  ui.container.querySelectorAll = selector => {
    assert.equal(selector, '.activity-bar, .agent-panel');
    return [60, 300].map(width => ({ getBoundingClientRect: () => ({ width }) }));
  };
  ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 1200 });
  assert.equal(ui.state.width, 276); ui.event('onPointerUp', { clientX: 1200 });
  ui.event('onDoubleClick'); assert.equal(ui.state.width, 224);
  ui.event('onKeyDown', { key: 'ArrowRight' }); assert.equal(ui.state.width, 234);
  ui.event('onKeyDown', { key: 'ArrowLeft' }); assert.equal(ui.state.width, 224);
  ui.event('onKeyDown', { key: 'Home' }); assert.equal(ui.state.width, 194);
  ui.event('onKeyDown', { key: 'ArrowLeft' }); assert.equal(ui.state.collapseCount, 1);
  ui.event('onPointerDown'); assert.equal(ui.captures.size, 0);
});

test('连接管理拖动复用原侧栏收起状态，不新增网格列，不因 Agent 收起而失效', () => {
  const app = source('App.tsx'), css = source('reference.css'), resize = source('panel-resize.css');
  assert.match(app, /value=\{connectionSidebarWidth\} change=\{setConnectionSidebarWidth\} side="left"/);
  assert.match(app, /controls="connection-sidebar-content"[\s\S]*collapse=\{\(\) => setConnectionSidebarCollapsed\(true\)\}/);
  assert.match(css, /--host-sidebar-width: var\(--connection-sidebar-width, 224px\)/);
  assert.match(css, /--host-sidebar-width: var\(--connection-sidebar-width, 194px\)/);
  assert.match(css, /\.app-shell\.agent-collapsed > \.panel-divider:not\(\.connection-panel-divider\)/);
  assert.match(resize, /\.app-shell > \.connection-panel-divider \{[^}]*grid-column: 2; grid-row: 2/s);
  assert.match(resize, /\.app-shell\.host-sidebar-collapsed > \.connection-panel-divider \{[^}]*visibility: hidden/s);
  assert.match(resize, /\[data-side='left'\] \.panel-collapse-hint \{ left: calc\(100% \+ 10px\); right: auto;/);
  assert.match(source('components/Connections.tsx'), /<aside id="connection-sidebar-content"/);
  assert.doesNotMatch(app, /!connectionSidebarCollapsed && <ConnectionSidebar/);
});

test('预告收起时取消、失去捕获、Esc 或窗口失焦都不折叠，清理提示及捕获', () => {
  for (const cancel of ['onPointerCancel', 'onLostPointerCapture', 'Escape', 'blur']) {
    const ui = divider({ unit: 'pixels', min: 220, max: 450 });
    ui.event('onPointerDown'); ui.event('onPointerMove', { clientX: 1000 });
    if (cancel === 'Escape') ui.event('onKeyDown', { key: 'Escape' });
    else if (cancel === 'blur') ui.blur();
    else ui.event(cancel);
    assert.equal(ui.state.collapsed, false); assert.equal(ui.captures.size, 0);
    assert.equal(ui.tree().props['aria-valuetext'], undefined);
    assert.doesNotMatch(ui.tree().props.className, /dragging|collapse-pending/);
    ui.event('onPointerUp', { clientX: 1000 }); assert.equal(ui.state.collapseCount, 0);
  }
});

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
