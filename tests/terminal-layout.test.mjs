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
const model = load('state/terminalLayout.ts');
const visible = (...args) => Array.from(model.visibleTerminalIds(...args));
const sessions = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, title: id, kind: 'local', connectionStatus: 'connected', connected: true }));

test('终端隐藏原生白色滚动轨道及箭头，保留 xterm 自有滑块与滚轮处理', () => {
  const css = source('reference.css'), terminal = source('components/RemoteTerminalView.tsx');
  assert.match(css, /\.remote-terminal-screen \.xterm :is\(\.xterm-viewport, \.xterm-scrollable-element\) \{ scrollbar-width: none; \}/);
  assert.match(css, /:is\(\.xterm-viewport, \.xterm-scrollable-element\)::-webkit-scrollbar \{[^}]*display: none;[^}]*width: 0;/s);
  assert.match(css, /:is\(\.xterm-viewport, \.xterm-scrollable-element\)::-webkit-scrollbar-button \{ display: none; \}/);
  assert.match(css, /\.xterm-scrollable-element > \.scrollbar.vertical > \.slider \{[^}]*width: 4px !important;/s);
  assert.doesNotMatch(css, /\.xterm-scrollable-element > \.scrollbar[^}]*display: none/s);
  assert.match(terminal, /scrollback: 5000, scrollOnUserInput: true/);
});

test('页签排序只移动原会话对象，不改变活动 ID、运行时或其他会话；无效目标与同页签不修改', () => {
  const reordered = model.reorderTerminalSessions(sessions, 'a', 'c', true);
  assert.deepEqual(Array.from(reordered, item => item.id), ['b', 'c', 'a', 'd', 'e']);
  assert.equal(reordered[2], sessions[0]); assert.equal(reordered[0], sessions[1]);
  assert.deepEqual(Array.from(model.reorderTerminalSessions(sessions, 'd', 'b', false), item => item.id), ['a', 'd', 'b', 'c', 'e']);
  assert.equal(model.reorderTerminalSessions(sessions, 'a', 'a'), sessions);
  assert.equal(model.reorderTerminalSessions(sessions, 'missing', 'b'), sessions);
  assert.equal(model.reorderTerminalSessions(sessions, 'a', 'missing'), sessions);
});

test('单窗口/左右/上下/网格自动选择不同终端；关闭、排序和新建后补足且不残留重复或失效窗格', () => {
  const ids = sessions.map(item => item.id);
  assert.deepEqual(visible(ids, 'c', 'single', []), ['c']);
  for (const layout of ['columns', 'rows']) assert.deepEqual(visible(ids, 'c', layout, []), ['c', 'a']);
  assert.deepEqual(visible(ids, 'c', 'grid', []), ['c', 'a', 'b', 'd']);
  assert.deepEqual(visible(ids, 'c', 'columns', ['a', 'c']), ['a', 'c']);
  assert.deepEqual(visible(['e', 'd', 'c', 'b', 'a'], 'a', 'grid', ['a', 'b', 'c', 'd']), ['a', 'b', 'c', 'd']);
  assert.deepEqual(visible(['a', 'c', 'd'], 'a', 'grid', ['a', 'b', 'c', 'd']), ['a', 'c', 'd']);
  assert.deepEqual(visible(ids, 'e', 'columns', ['a', 'b']), ['e', 'b']);
  assert.deepEqual(visible(['a'], 'a', 'grid', ['a', 'a', 'missing']), ['a']);
  assert.deepEqual(visible([], '', 'grid', ['missing']), []);
});

test('点击已显示终端只激活它，点击其他页签替换当前窗格；窗格选择已有终端时交换而非重复', () => {
  assert.deepEqual(Array.from(model.selectTerminalPane(['a', 'b'], 'a', 'b')), ['a', 'b']);
  assert.deepEqual(Array.from(model.selectTerminalPane(['a', 'b'], 'b', 'c')), ['a', 'c']);
  assert.deepEqual(Array.from(model.replaceTerminalPane(['a', 'b', 'c', 'd'], 'b', 'd')), ['a', 'd', 'c', 'b']);
  assert.deepEqual(Array.from(model.replaceTerminalPane(['a', 'b'], 'b', 'c')), ['a', 'c']);
});

function workspace() {
  const slots = []; let cursor = 0, tree, pointedAt = null;
  const calls = [], selected = [], timers = [], captures = new Set(), effects = [], listeners = new Map();
  const list = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 500 }) };
  const hooks = {
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }]; },
    useEffect(callback, deps) { const index = cursor++; if (!(index in slots)) { slots[index] = deps; effects.push(callback); } },
  };
  const node = (type, props) => ({ type, props });
  const leaf = () => null;
  const { TerminalWorkspace } = load('components/Workspace.tsx', name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === 'react-dom') return { createPortal: content => content };
    if (name === './Select') return { Select: leaf };
    if (name === './Ui') return { AccentIcon: leaf, Badge: leaf, Icon: leaf, IconButton: leaf };
    if (name === '../data/mock') return { commandCategoryIcon: () => 'terminal' };
    if (name === './TerminalWelcome') return { TerminalWelcome: leaf };
    if (name === '../state/terminalSessions') return { isSessionConnected: session => session.connected };
    throw new Error(name);
  }, { document: { body: {}, elementFromPoint: () => pointedAt && ({ closest: () => pointedAt }) },
    window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
    setTimeout: callback => timers.push(callback) });
  const props = { sessions: sessions.slice(0, 3), activeId: 'a', remoteViews: null, layout: 'columns', visibleIds: ['a', 'b'],
    select: id => selected.push(id), reorder: (...args) => calls.push(args), changeLayout: layout => calls.push(layout), close() {}, add() {} };
  function all(node = tree) {
    if (Array.isArray(node)) return node.flatMap(child => all(child ?? null));
    if (!node?.props) return [];
    return [node, ...all(node.props.children ?? null)];
  }
  const render = () => { cursor = 0; tree = TerminalWorkspace(props); effects.splice(0).forEach(callback => callback()); };
  const element = { closest: () => list, setPointerCapture: id => captures.add(id),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 138 }), querySelector: () => ({ focus() {} }),
    hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  function event(tabIndex, name, extra = {}) {
    const target = all().filter(node => ['onClick', 'onKeyDown'].includes(name) ? node.props.role === 'tab' : node.props['data-terminal-id'])[tabIndex];
    target.props[name]({ button: 0, isPrimary: true, target: { closest: () => null },
      pointerId: 1, clientX: 10, clientY: 10, currentTarget: element, preventDefault() {}, ...extra }); render();
  }
  render();
  return { calls, selected, captures, props, all, event, render, listeners,
    point(id, left = 100, width = 100) { pointedAt = { dataset: { terminalId: id }, closest: () => list, getBoundingClientRect: () => ({ left, width }) }; },
    flushTimers() { timers.splice(0).forEach(callback => callback()); } };
}

test('多个 SSH 页签按下后由外层捕获指针，未拖动松手也能切换且后续 click 不重复激活', () => {
  const ui = workspace();
  ui.props.sessions = sessions.slice(0, 3).map(session => ({ ...session, kind: 'ssh', connectionId: 'host-' + session.id }));
  ui.props.layout = 'single'; ui.props.visibleIds = ['a'];
  ui.props.select = id => { ui.selected.push(id); ui.props.activeId = id; ui.props.visibleIds = [id]; };
  ui.render();
  // A captured pointer-up belongs to the outer tab; Chromium need not click
  // the inner role=tab button. Deliberately do not synthesize that button click.
  for (const index of [1, 2, 0]) {
    const id = ui.props.sessions[index].id;
    ui.event(index, 'onPointerDown', { target: { closest: () => ({ getAttribute: () => 'tab' }) } });
    assert.equal(ui.captures.size, 1);
    ui.event(index, 'onPointerMove', { clientX: 14, clientY: 12 });
    ui.event(index, 'onPointerUp');
    assert.equal(ui.props.activeId, id);
    assert.equal(ui.all().find(node => node.props.role === 'tab' && node.props['aria-selected']).props.children[1].props.children, id);
    assert.equal(ui.captures.size, 0);
    const count = ui.selected.length;
    ui.event(index, 'onClick');
    assert.equal(ui.selected.length, count, 'a trailing button click must not select twice');
    ui.flushTimers();
  }
  assert.deepEqual(ui.selected, ['b', 'c', 'a']);
  // Native keyboard activation still uses the button's click handler.
  ui.event(1, 'onClick', { detail: 0 });
  assert.equal(ui.props.activeId, 'b');
  assert.deepEqual(ui.selected, ['b', 'c', 'a', 'b']);
});

test('Agent binding badge appears on exactly one native terminal even when profiles match',()=>{
 const w=workspace();w.props.sessions=[
  {id:'a',title:'同一服务器',kind:'ssh',connectionId:'shared',terminalSessionId:'native-a',connected:true},
  {id:'b',title:'同一服务器',kind:'ssh',connectionId:'shared',terminalSessionId:'native-b',connected:true},
 ];
 w.props.agentTerminalId='native-b';w.render();
 const badges=w.all().filter(node=>node.props.className==='terminal-agent-binding');assert.equal(badges.length,1);
 const b=w.all().find(node=>node.props['data-terminal-id']==='b');assert.ok(b.props.children.includes(badges[0]));
 assert.equal(w.all().filter(node=>node.props.className==='terminal-agent-binding toolbar-binding').length,0);
 w.props.activeId='b';w.render();assert.equal(w.all().filter(node=>node.props.className==='terminal-agent-binding toolbar-binding').length,1);
 w.props.agentTerminalId=undefined;w.render();assert.equal(w.all().filter(node=>node.props.className?.includes('terminal-agent-binding')).length,0);
});

test('关闭按钮、非主按钮、其他指针松手及取消不激活 SSH 页签，随后普通点击可恢复', () => {
  const ui = workspace();
  ui.event(1, 'onPointerDown', { target: { closest: () => ({ getAttribute: () => null }) } });
  ui.event(1, 'onPointerUp');
  ui.event(1, 'onPointerDown', { button: 2 }); ui.event(1, 'onPointerUp');
  ui.event(1, 'onPointerDown', { isPrimary: false }); ui.event(1, 'onPointerUp');
  assert.equal(ui.captures.size, 0); assert.deepEqual(ui.selected, []);
  ui.event(1, 'onPointerDown');
  ui.event(1, 'onPointerUp', { pointerId: 2 });
  assert.equal(ui.captures.size, 1); assert.deepEqual(ui.selected, []);
  ui.event(1, 'onPointerCancel'); ui.event(1, 'onPointerUp');
  assert.equal(ui.captures.size, 0); assert.deepEqual(ui.selected, []);
  ui.event(1, 'onPointerDown'); ui.event(1, 'onPointerUp');
  assert.deepEqual(ui.selected, ['b']);
  assert.deepEqual(ui.calls, []);
});
test('真实页签指针拖动超过阈值才启动，松手落点决定前后排序，不误选中；取消/丢失捕获/其他指针不修改', () => {
  const ui = workspace(); ui.point('c');
  ui.event(0, 'onPointerDown'); ui.event(0, 'onPointerMove', { clientX: 14 });
  assert.equal(ui.all().some(node => node.props['data-dragging'] === true), false);
  ui.event(0, 'onPointerMove', { clientX: 175 });
  assert.ok(ui.all().find(node => node.props.className === 'terminal-tab-drag-preview'));
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.all().find(node => node.props['data-terminal-id'] === 'c').props['data-drop'], 'after');
  ui.event(0, 'onPointerUp', { clientX: 175 }); ui.event(0, 'onClick');
  assert.deepEqual(ui.calls, [['a', 'c', true]]); assert.equal(ui.selected.length, 0); assert.equal(ui.captures.size, 0);
  assert.equal(ui.all().some(node => node.props.className === 'terminal-tab-drag-preview'), false);
  ui.flushTimers(); ui.event(0, 'onClick'); assert.deepEqual(ui.selected, ['a']);
  ui.event(0, 'onPointerDown'); ui.event(0, 'onPointerMove', { clientX: 125 });
  ui.event(0, 'onPointerCancel', { pointerId: 2 }); assert.equal(ui.captures.size, 1);
  ui.event(0, 'onPointerCancel'); assert.equal(ui.captures.size, 0); assert.equal(ui.calls.length, 1);
  ui.event(0, 'onPointerDown'); ui.event(0, 'onPointerMove', { clientX: 125 }); ui.event(0, 'onLostPointerCapture');
  ui.event(0, 'onPointerUp'); assert.equal(ui.calls.length, 1);
  ui.captures.clear();
  ui.event(0, 'onPointerDown'); ui.event(0, 'onPointerMove', { clientX: 125 }); ui.event(0, 'onKeyDown', { key: 'Escape' });
  assert.equal(ui.captures.size, 0); ui.event(0, 'onPointerUp'); assert.equal(ui.calls.length, 1);
});

test('排序支持键盘，布局复用自定义下拉，少于两终端时只提供单窗口', () => {
  const ui = workspace();
  ui.event(1, 'onKeyDown', { ctrlKey: true, shiftKey: true, key: 'ArrowLeft' });
  ui.event(1, 'onKeyDown', { ctrlKey: true, shiftKey: true, key: 'ArrowRight' });
  assert.deepEqual(ui.calls, [['b', 'a', false], ['b', 'c', true]]);
  const select = ui.all().find(node => node.props.label === '终端分屏布局');
  select.props.onChange('grid'); assert.equal(ui.calls.at(-1), 'grid');
  assert.equal(select.props.options.length, 4);
  ui.props.sessions = sessions.slice(0, 1); ui.render();
  assert.equal(ui.all().find(node => node.props.label === '终端分屏布局').props.options.length, 1);
});

test('整张标签空白处支持拖动，关闭按钮不启动；原生拖动被阻止，失焦清理捕获和跟随预览', () => {
  const ui = workspace(); ui.point('c');
  ui.event(0, 'onPointerDown', { target: { closest: () => ({ getAttribute: () => null }) } });
  assert.equal(ui.captures.size, 0);
  let prevented = false;
  ui.event(0, 'onDragStart', { preventDefault: () => { prevented = true; } }); assert.equal(prevented, true);
  ui.event(0, 'onPointerDown', { isPrimary: undefined }); assert.equal(ui.captures.size, 1);
  ui.event(0, 'onPointerMove', { clientX: 175 });
  assert.ok(ui.all().find(node => node.props.className === 'terminal-tab-drag-preview'));
  ui.listeners.get('blur')(); ui.render();
  assert.equal(ui.captures.size, 0); assert.equal(ui.calls.length, 0);
  assert.equal(ui.all().some(node => node.props.className === 'terminal-tab-drag-preview'), false);
});

test('布局及窗格选择均使用已有 Select 浮层，原生 select 已移除；浮层有选中、悬停、圆角与键盘支持', () => {
  const workspace = source('components/Workspace.tsx'), app = source('App.tsx');
  assert.match(workspace, /<Select label="终端分屏布局"/);
  assert.match(app, /<Select label=\{`选择窗格/);
  assert.doesNotMatch(workspace, /<select\b/); assert.doesNotMatch(app, /<select\b/);
  const select = source('components/Select.tsx'), css = source('components/Select.css');
  assert.match(select, /createPortal/); assert.match(select, /role="listbox"/); assert.match(select, /name="check"/);
  assert.match(select, /ArrowDown/); assert.match(select, /Escape/);
  assert.match(css, /\.ui-select-option\.is-active/); assert.match(css, /\.ui-select-option\.is-selected/);
  assert.match(css, /border-radius: var\(--ui-menu-radius\)/);
});

test('分屏仍按 session.id 常驻所有终端，不过滤/复制视图；只在活动可见窗格聚焦，CSS 不强加壁纸底色', () => {
  const app = source('App.tsx'), view = source('components/RemoteTerminalView.tsx'), css = source('components/TerminalLayout.css');
  assert.match(app, /remoteViews=\{sessions\.map\(session/);
  assert.match(app, /<section key=\{session\.id\} className="terminal-session-pane" hidden=\{!visible\}/);
  assert.match(app, /visible=\{visible && navigation === '命令'\} focused=\{session\.id === activeId\}/);
  assert.match(app, /selectTerminalTab\(id, replaceTerminalPane/);
  assert.match(view, /if \(!visible \|\| !focused \|\| unavailable\) return/);
  assert.match(view, /control\?\.matches\('select, button, textarea, input'\)/);
  assert.match(view, /if \(visibleRef.current && focusedRef.current && allowInput.current\) terminal.focus\(\)/);
  assert.match(css, /\.terminal-session-pane\[hidden\]/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /\.terminal-session-pane \{[^}]*background:/);
});

test('更换壁纸入口使用轻蒙版与较小文字，不把原图盖成独立按钮，聚焦仍可辨认', () => {
  const css = source('components/WallpaperCropEditor.css');
  assert.match(source('components/AppearanceSettings.tsx'), /'更换壁纸'/);
  assert.doesNotMatch(source('components/AppearanceSettings.tsx'), /'更换图片'/);
  assert.match(css, /rgb\(8 16 30 \/ 18%\).*rgb\(8 16 30 \/ 34%\)/);
  assert.match(css, /:is\(:hover, :focus-visible\) > :is\(svg, span\) \{ opacity: 1/);
});
