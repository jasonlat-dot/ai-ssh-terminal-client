import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { beginFilePointerDrag } from '../src/state/filePointerDrag.ts';

const source = ts.createSourceFile('Sidebar.tsx', readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let fileSource;
function scan(node) {
  if (ts.isVariableDeclaration(node) && ['startFileDrag', 'uploadPaths', 'downloadPaths'].includes(node.name.getText(source))) declarations.set(node.name.getText(source), node.initializer.getText(source));
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'FileSource') fileSource = node.getText(source);
  ts.forEachChild(node, scan);
}
scan(source);
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const listeners = new Map(), transfers = [], hover = [], queues = [], notices = [];
  const localChild = {}, remoteChild = {}, overlay = {};
  let hit = null;
  const document = {
    elementFromPoint: () => hit,
    documentElement: { classList: { add() {}, remove() {} } },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type),
    defaultView: { addEventListener() {}, removeEventListener() {} },
  };
  const context = vm.createContext({ exports: {}, beginFilePointerDrag, document, Set,
    ready: true, conflict: 'SKIP', pointerDragCleanup: {},
    remoteDropSurface: { current: { contains: node => node === remoteChild } },
    localDropSurface: { current: { contains: node => node === localChild } },
    uploadPathsRef: {}, downloadPathsRef: {},
    setPointerDropSide: side => hover.push(side), setTransfersOpen: open => queues.push(open), notify: (...args) => notices.push(args),
    files: { working: false, localLoading: false, remoteLoading: false, local: { path: 'C:\\Downloads' }, remotePath: '/srv/upload',
      transfer: async (...args) => { transfers.push(args); return true; } },
  });
  vm.runInContext(compile([...declarations].map(([name, text]) => `exports.${name} = ${text};`).join('\n')), context);
  context.uploadPathsRef.current = context.exports.uploadPaths;
  context.downloadPathsRef.current = context.exports.downloadPaths;
  const start = { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 0, clientY: 0 };
  const row = { setPointerCapture() {}, releasePointerCapture() {} };
  return { context, transfers, hover, queues, notices, localChild, remoteChild, overlay,
    begin: (side, path) => context.exports.startFileDrag(side, path, start, row),
    move(node) { hit = node; listeners.get('pointermove')?.({ ...start, clientX: 100, clientY: 100, preventDefault() {} }); },
    drop() { listeners.get('pointerup')?.({ ...start }); },
    async flush() { await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('actual file-manager handlers route both directions to their current destination and existing queue', async () => {
  const upload = harness(); upload.begin('local', 'C:\\data.txt'); upload.move(upload.remoteChild);
  assert.equal(upload.hover.at(-1), 'remote'); upload.drop(); await upload.flush();
  assert.deepEqual(upload.transfers, [['UPLOAD', 'C:\\data.txt', '/srv/upload', 'SKIP']]);
  const download = harness(); download.begin('remote', '/srv/report.txt'); download.move(download.localChild);
  assert.equal(download.hover.at(-1), 'local'); download.drop(); await download.flush();
  assert.deepEqual(download.transfers, [['DOWNLOAD', 'C:\\Downloads', '/srv/report.txt', 'FAIL']]);
  assert.equal(download.hover.at(-1), null); assert.deepEqual(download.queues, []); assert.deepEqual(upload.queues, []);
  assert.equal(upload.notices.length, 1); assert.match(upload.notices[0][0], /可在传输队列查看进度/);
});

test('same-side drops, covered targets, cancellation and unavailable sessions cannot transfer', async () => {
  for (const target of ['remoteChild', 'overlay']) {
    const ui = harness(); ui.begin('remote', '/srv/report.txt'); ui.move(ui[target]); ui.drop(); await ui.flush();
    assert.equal(ui.transfers.length, 0);
  }
  const cancelled = harness(); cancelled.begin('remote', '/srv/report.txt'); cancelled.move(cancelled.localChild);
  cancelled.context.pointerDragCleanup.current(); cancelled.drop(); await cancelled.flush(); assert.equal(cancelled.transfers.length, 0);
  for (const patch of [{ working: true }, { localLoading: true }, { remoteLoading: true }, { local: null }]) {
    const ui = harness(); Object.assign(ui.context.files, patch); ui.begin('remote', '/srv/report.txt'); ui.move(ui.localChild); ui.drop(); await ui.flush();
    assert.equal(ui.transfers.length, 0);
  }
});

test('both rendered file lists expose pointer drags and directional drop feedback', () => {
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({ exports: {}, require: () => ({ jsx, jsxs: jsx }),
    useState: initial => [initial, () => {}], useRef: () => ({ current: null }), useEffect() {},
    AccentIcon: 'accent', Badge: 'badge', Icon: 'icon', IconButton: 'icon-button', fileTone: () => 'blue', formatBytes: () => '1 B',
  });
  vm.runInContext(compile(`export ${fileSource}`), context);
  function find(node, predicate) {
    if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
    if (!node?.props) return;
    return predicate(node) ? node : find(node.props.children, predicate);
  }
  for (const side of ['local', 'remote']) {
    const calls = [], path = side === 'local' ? 'C:\\item.txt' : '/srv/item.txt';
    const tree = context.exports.FileSource({ side, title: side, path: '/', parent: null, entries: [{ path, name: 'item.txt', kind: 'FILE' }],
      enabled: true, loading: false, selected: '', select() {}, browse() {}, create() {}, requestDelete() {}, copy() {}, dropActive: true,
      dragStart: (...args) => calls.push(args) });
    find(tree, node => node.props.className?.startsWith('file-row')).props.onPointerDown({ nativeEvent: 'pointer', currentTarget: 'row' });
    assert.deepEqual(calls, [[path, 'pointer', 'row']]);
    assert.ok(find(tree, node => node.props.role === 'status'));
  }
});


test('传输失败仍只通知，不弹出队列；手动队列入口保留', async () => {
  const ui = harness(); ui.context.files.transfer = async () => false;
  await ui.context.exports.uploadPaths(['C:\\a.txt']);
  assert.deepEqual(ui.queues, []); assert.equal(ui.notices.length, 1); assert.equal(ui.notices[0][1], 'error');
  assert.match(readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url),'utf8'), /onClick=\{\(\) => setTransfersOpen\(true\)\}/);
});
