import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createSidebarTransfer,createSidebarUpload,terminalUploadMatches } from '../src/state/terminalUpload.ts';
import {handleTerminalFileDrop} from '../src/state/terminalFileDrop.ts';
import { fileOperationJobs, fileSelection } from '../src/state/terminalFileOperations.ts';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const compile = input => ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const listing = (path, names = ['folder', '.hidden', '中文.txt']) => ({ path, truncated: false,
  entries: names.map((name, i) => ({ name, directory: i === 0, symlink: false, size: 12 })) });
function harness({native=false}={}) {
  const transfers = [], choices = [], notices = [], operations = [];
  const slots = [], effects = [], jobs = new Map(), events = new Map(), requests = [], saved = new Map(), copies = [];
  let cursor = 0, timerId = 0, tree, managerOpens = 0;
  const dragListeners=new Set(),hitCoordinates=[];
  let stoppedDragListeners=0,hit;
  const surface={contains:node=>node===surface};hit=surface;
  let cwd = { path: '/home', revision: 1 };
  const runtime = { sessionId: 'one', directorySnapshot: () => cwd, subscribeDirectory: () => () => {},
    directoryList: (path, signal) => new Promise((resolve, reject) => requests.push({ path, signal, resolve, reject })) };
  let props = { runtime, terminalId: 'tab-one', transfer: request => transfers.push(request), title: '测试服务器', local: false, connected: true, visible: true, openFiles: () => managerOpens++, copy: async path => copies.push(path) };
  const document = { hidden: false,body:{},elementFromPoint:(x,y)=>{hitCoordinates.push([x,y]);return hit;}, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
    useEffect(callback, deps) { const i = cursor++; const old = slots[i];
      if (!old || deps.some((dep, index) => !Object.is(dep, old.deps[index]))) {
        old?.cleanup?.(); const effect = { deps }; slots[i] = effect; effects.push(() => { effect.cleanup = callback(); });
      }
    },
  };
  const context = vm.createContext({ exports: {}, AbortController, document,window:{devicePixelRatio:1.5},
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    setTimeout: (fn, delay) => { jobs.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => jobs.delete(id),
    require: name => {
      if (name === 'react') return react;
      if (name === 'react-dom') return {createPortal:node=>node};
      if (name === '@tauri-apps/api/webview') return {getCurrentWebview:()=>({onDragDropEvent:async listener=>{dragListeners.add(listener);return()=>{dragListeners.delete(listener);stoppedDragListeners++;};}})};
      if (name.endsWith('state/runtime')) return {isTauriRuntime:()=>native};
      if (name.endsWith('terminalFileDrop')) return {handleTerminalFileDrop};
      if (name.endsWith('api/sftp')) return { sftpApi: { pickLocal: directory => new Promise(resolve => choices.push({ directory, resolve })) } };
      if (name.endsWith('notifications')) return { notify: (...args) => notices.push(args) };
      if (name.endsWith('terminalUpload')) return { createSidebarTransfer,createSidebarUpload,terminalUploadMatches };
      if (name === './TerminalUploadConfirm') return {TerminalUploadConfirm:'upload-confirm'};
      if (name.endsWith('terminalFileOperations')) return {fileOperationJobs,fileSelection,runSidebarFileOperation:async(owner,operation,valid)=>{
        if(!valid())throw new Error('访问身份已变化');operations.push({owner,operation});return operation.names.length;
      }};
      if (name === './TerminalFileActions') return {TerminalFileContextMenu:'file-menu',TerminalFileOperationDialog:'file-dialog'};

      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith('terminalDirectory')) return directory;
      if (name.endsWith('terminalResources')) return { resourceBytes: value => `${value} B` };
      if (name === './Ui') return { Icon: 'icon', IconButton: 'icon-button' };
      if (name.endsWith('.css')) return {};
      throw new Error(name);
    },
  });
  vm.runInContext(compile(source('state/terminalDirectory.ts')), context); const directory = context.exports; context.exports = {};
  vm.runInContext(compile(source('components/TerminalFileSidebar.tsx')), context);
  const all = value => Array.isArray(value) ? value.flatMap(all) : value?.props ? [value, ...all(value.props.children)] : [];
  const render = (patch = {}) => { props = { ...props, ...patch }; cursor = 0; tree = context.exports.TerminalFileSidebar(props);tree.props.ref.current=surface; while (effects.length) effects.shift()(); return tree; };
  render();
  return { requests, copies, saved, events, render, runtime, transfers, choices, notices, operations, nodes: () => all(tree), managerOpens: () => managerOpens,
    find: predicate => all(tree).find(predicate),
    async tick() { const pending = [...jobs]; jobs.clear(); for (const [, job] of pending) job.fn(); await flush(); render(); },
    cwd(path, access = {}) { cwd = { ...cwd, ...access, path, revision: cwd.revision + 1 }; render(); },
    visibility(hidden) { document.hidden = hidden; events.get('visibilitychange')?.(); render(); },
    nativeDrop(payload,inside=true){hit=inside?surface:{};for(const listener of dragListeners)listener({payload});render();},
    hitCoordinates,dragListeners,stoppedDragListeners:()=>stoppedDragListeners,
    stop() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('目录跟随切换、文件单击、手动浏览、恢复跟随与管理传输均绑定当前终端', async () => {
  const ui = harness(); await ui.tick(); assert.equal(ui.requests[0].path, '/home');
  ui.requests[0].resolve(listing('/home')); await flush(); ui.render();
  const entry = name => ui.find(node => node.props.title === name);
  assert.ok(entry('.hidden')); entry('中文.txt').props.onClick(); ui.render();
  ui.find(node => node.props.label === '复制选中文件路径').props.onClick(); await flush();
  assert.deepEqual(ui.copies, ['/home/中文.txt']);
  entry('folder').props.onClick(); ui.render(); await ui.tick();
  assert.equal(ui.requests.at(-1).path, '/home/folder');
  const follow = () => ui.find(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(follow().props.checked, false);
  ui.requests.at(-1).resolve(listing('/home/folder', [])); await flush(); ui.render();
  ui.cwd('/opt'); await ui.tick(); assert.equal(ui.requests.at(-1).path, '/home/folder', '自由浏览不会被新提示符抢走');
  follow().props.onChange({ target: { checked: true } }); ui.render(); await ui.tick();
  assert.equal(ui.requests.at(-1).path, '/opt');
  ui.find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes('管理与传输')).props.onClick();
  assert.equal(ui.managerOpens(), 1); ui.stop();
});

test('快速 cd、断线、隐藏侧栏及切换会话取消旧请求，迟到结果不能污染清单', async () => {
  const ui = harness(); await ui.tick(); const first = ui.requests[0];
  ui.cwd('/opt'); assert.ok(first.signal.aborted); await ui.tick(); const second = ui.requests[1];
  first.resolve(listing('/wrong', ['private-file'])); await flush(); ui.render();
  assert.ok(!ui.nodes().some(node => node.props.title === 'private-file'));
  second.resolve(listing('/opt')); await flush(); ui.render();
  ui.render({ visible: false }); const count = ui.requests.length; await ui.tick(); assert.equal(ui.requests.length, count);
  ui.render({ visible: true }); await ui.tick(); const third = ui.requests.at(-1);
  ui.render({ connected: false }); assert.ok(third.signal.aborted);
  ui.render({ connected: true, runtime: { ...ui.runtime, sessionId: 'other', directorySnapshot: () => ({ path: '/srv', revision: 1 }) } });
  await ui.tick(); third.resolve(listing('/old')); await flush(); ui.render();
  assert.ok(!ui.nodes().some(node => node.props.value === '/old')); ui.stop();
});

test('目录权限错误可重试，未知目录不冒充终端位置；未连接和本地终端有明确空态', async () => {
  const ui = harness(); ui.cwd(''); await ui.tick(); assert.equal(ui.requests[0].path, '');
  ui.requests[0].reject(new Error('权限不足')); await flush(); ui.render();
  assert.ok(ui.find(node => node.props.role === 'alert'));
  ui.find(node => node.type === 'button' && node.props.children === '重试').props.onClick(); ui.render(); await ui.tick();
  assert.equal(ui.requests.length, 2); ui.stop();
  const local = harness(); local.render({ local: true }); await local.tick(); assert.equal(local.requests.length, 0); local.stop();
});
test('页面隐藏取消采集，恢复后即使旧请求迟到也只有一个轮询，不显示旧目录', async () => {
  const ui = harness(); await ui.tick(); const old = ui.requests[0];
  ui.visibility(true); assert.equal(old.signal.aborted, true);
  await ui.tick(); assert.equal(ui.requests.length, 1);
  ui.visibility(false); await ui.tick(); assert.equal(ui.requests.length, 2);
  old.resolve(listing('/late')); await flush(); ui.render();
  ui.requests[1].resolve(listing('/home')); await flush(); ui.render();
  await ui.tick(); assert.equal(ui.requests.length, 3); ui.stop();
});

test('自由浏览也随退出 root 撤销读取，立即清除旧身份文件并拒绝迟到结果', async () => {
  const ui = harness();
  ui.cwd('/root', { access: 'root', accessKey: 'root-shell-one' }); await ui.tick();
  ui.requests.at(-1).resolve(listing('/root', ['root-private-file'])); await flush(); ui.render();
  assert.ok(ui.find(node => node.props.title === 'root-private-file'));
  ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: false } });
  ui.render(); await ui.tick(); const pending = ui.requests.at(-1);
  ui.cwd('/home/user', { access: 'login', accessKey: 'login-shell' }); ui.render();
  assert.equal(pending.signal.aborted, true);
  assert.ok(!ui.find(node => node.props.title === 'root-private-file'));
  pending.resolve(listing('/root', ['late-private-file'])); await flush(); ui.render();
  assert.ok(!ui.find(node => node.props.title === 'late-private-file'));
  await ui.tick(); assert.equal(ui.requests.at(-1).path, '/root');
  ui.stop();
});


test('快捷按钮按目录与选中文件启用，上传使用自由浏览位置并抑制重复选择', async () => {
  const ui = harness(), upload = () => ui.find(n => n.props.label === '上传文件到当前目录');
  assert.equal(upload().props.disabled, true); await ui.tick();
  ui.requests[0].resolve(listing('/home')); await flush(); ui.render();
  assert.equal(upload().props.disabled, false);
  assert.equal(ui.find(n => n.props.label === '下载选中文件').props.disabled, true);
  ui.find(n => n.props.title === 'folder').props.onClick(); ui.render(); await ui.tick();
  ui.requests.at(-1).resolve(listing('/home/folder')); await flush(); ui.render();
  upload().props.onClick(); upload().props.onClick(); ui.render(); assert.equal(ui.choices.length, 1);
  assert.equal(ui.choices[0].directory, false); ui.choices[0].resolve(['C:\\a.txt','D:\\b.txt']); await flush(); ui.render();
  assert.equal(ui.transfers.length, 1); assert.equal(ui.transfers[0].target.path, '/home/folder');
  assert.equal(ui.transfers[0].terminalId, 'tab-one'); assert.equal(ui.transfers[0].target.terminalSessionId, 'one');
  assert.equal(upload().props.disabled, false); ui.stop();
});

test('下载选中文件并选择本地目录，取消选择不创建传输任务', async () => {
  const ui = harness(); await ui.tick(); ui.requests[0].resolve(listing('/home')); await flush(); ui.render();
  ui.find(n => n.props.title === '中文.txt').props.onClick(); ui.render();
  const download = () => ui.find(n => n.props.label === '下载选中文件');
  assert.equal(download().props.disabled, false); download().props.onClick(); ui.choices[0].resolve([]); await flush(); ui.render();
  assert.equal(ui.transfers.length, 0); assert.equal(ui.notices.length, 0);
  download().props.onClick(); assert.equal(ui.choices[1].directory, true); ui.choices[1].resolve(['D:\\downloads']); await flush();
  assert.equal(ui.transfers[0].direction, 'DOWNLOAD'); assert.equal(ui.transfers[0].remotePath, '/home/中文.txt');
  assert.deepEqual(ui.transfers[0].paths, ['D:\\downloads']); ui.stop();
});

test('文件选择期间换目录、身份、终端或关闭侧栏不向原目标提交', async () => {
  for (const change of [ui => ui.cwd('/other'), ui => ui.cwd('/home',{accessKey:'new-root'}),
    ui => ui.render({runtime:{...ui.runtime,sessionId:'new'}}), ui => ui.render({visible:false}), ui => ui.stop()]) {
    const ui = harness(); await ui.tick(); ui.requests[0].resolve(listing('/home')); await flush(); ui.render();
    ui.find(n => n.props.label === '上传文件到当前目录').props.onClick(); change(ui);
    ui.choices[0].resolve(['C:\\a.txt']); await flush(); assert.equal(ui.transfers.length, 0); ui.stop();
  }
});

test('Ctrl 点击目录只选择不进入，支持混合多选下载与取消单项选择', async()=>{
  const ui=harness();await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  const entry=name=>ui.find(node=>node.props.title===name),download=()=>ui.find(node=>node.props.label==='下载选中文件');
  entry('folder').props.onClick({ctrlKey:true});ui.render();
  assert.equal(entry('folder').props['aria-selected'],true);assert.equal(download().props.disabled,false);
  entry('中文.txt').props.onClick({ctrlKey:true});ui.render();
  assert.equal(entry('folder').props['aria-selected'],true);assert.equal(entry('中文.txt').props['aria-selected'],true);
  assert.equal(ui.requests.length,1);
  download().props.onClick();ui.choices[0].resolve(['D:\\downloads']);await flush();ui.render();
  assert.deepEqual(Array.from(ui.transfers[0].remotePaths),['/home/folder','/home/中文.txt']);
  entry('folder').props.onClick({ctrlKey:true});ui.render();assert.equal(entry('folder').props['aria-selected'],false);
  assert.equal(entry('中文.txt').props['aria-selected'],true);ui.stop();
});

test('Shift 连选及 Ctrl+A 选择可见项，轮询不丢失选择，换目录清除',async()=>{
  const ui=harness();await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  const entry=name=>ui.find(node=>node.props.title===name);
  entry('folder').props.onClick({ctrlKey:true});ui.render();entry('中文.txt').props.onClick({shiftKey:true});ui.render();
  assert.equal(ui.nodes().filter(node=>node.props['aria-selected']===true&&node.props.role==='option').length,3);
  await ui.tick();ui.requests.at(-1).resolve(listing('/home'));await flush();ui.render();
  assert.equal(entry('folder').props['aria-selected'],true);
  ui.find(node=>node.props['aria-label']==='目录内容').props.onKeyDown({key:'Escape'});ui.render();
  ui.find(node=>node.props['aria-label']==='目录内容').props.onKeyDown({key:'a',ctrlKey:true,preventDefault(){},stopPropagation(){}});ui.render();
  assert.equal(entry('.hidden').props['aria-selected'],true);
  ui.cwd('/other');await ui.tick();ui.requests.at(-1).resolve(listing('/other'));await flush();ui.render();
  assert.equal(entry('folder').props['aria-selected'],false);ui.stop();
});

test('右键已选项保留批量选择，删除先确认且提交准确路径与终端身份',async()=>{
  const ui=harness();await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  const entry=name=>ui.find(node=>node.props.title===name);
  entry('folder').props.onClick({ctrlKey:true});ui.render();entry('中文.txt').props.onClick({ctrlKey:true});ui.render();
  entry('folder').props.onContextMenu({clientX:10,clientY:20,preventDefault(){}});ui.render();
  const menu=ui.find(node=>node.type==='file-menu');assert.equal(menu.props.caption,'已选 2 项');
  assert.equal(menu.props.actions.find(action=>action.label==='重命名').disabled,true);
  menu.props.actions.find(action=>action.danger).run();ui.render();
  assert.equal(ui.operations.length,0);const dialog=ui.find(node=>node.type==='file-dialog');assert.equal(dialog.props.kind,'delete');
  dialog.props.confirm('');dialog.props.confirm('');await flush();ui.render();
  assert.equal(ui.operations.length,1);assert.deepEqual(Array.from(ui.operations[0].operation.names),['folder','中文.txt']);
  assert.equal(ui.operations[0].owner,ui.runtime);assert.equal(ui.operations[0].operation.path,'/home');
  assert.ok(!ui.find(node=>node.type==='file-dialog'));ui.stop();
});

test('右键未选项改为单选，重命名校验及过期确认不执行文件操作',async()=>{
  const ui=harness();await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  const entry=name=>ui.find(node=>node.props.title===name);
  entry('folder').props.onClick({ctrlKey:true});ui.render();
  entry('中文.txt').props.onContextMenu({clientX:10,clientY:20,preventDefault(){}});ui.render();
  ui.find(node=>node.type==='file-menu').props.actions.find(action=>action.label==='重命名').run();ui.render();
  let dialog=ui.find(node=>node.type==='file-dialog');assert.deepEqual(Array.from(dialog.props.names),['中文.txt']);
  dialog.props.confirm('../escape');await flush();ui.render();assert.equal(ui.operations.length,0);
  dialog=ui.find(node=>node.type==='file-dialog');assert.ok(dialog.props.error);
  ui.cwd('/root',{access:'root',accessKey:'root-new'});dialog.props.confirm('new.txt');await flush();ui.render();
  assert.equal(ui.operations.length,0);ui.stop();
});

const nativeDropEvent=(type='drop')=>({type,position:{x:300,y:150},paths:['C:\\a.txt','D:\\folder']});
test('侧栏原生拖入显示目标提示，松开先确认，确认只创建一次现有队列请求',async()=>{
  const ui=harness({native:true});await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  ui.nativeDrop(nativeDropEvent('enter'));assert.ok(ui.find(node=>node.props.className==='terminal-file-drop-hint'));
  assert.deepEqual(ui.hitCoordinates.at(-1),[200,100]);
  ui.nativeDrop(nativeDropEvent());const confirm=ui.find(node=>node.type==='upload-confirm');
  assert.ok(confirm);assert.equal(confirm.props.request.target.path,'/home');assert.equal(ui.transfers.length,0);
  assert.deepEqual(confirm.props.request.paths,['C:\\a.txt','D:\\folder']);
  confirm.props.onConfirm();confirm.props.onConfirm();ui.render();
  assert.equal(ui.transfers.length,1);assert.equal(ui.transfers[0].terminalId,'tab-one');assert.equal(ui.transfers[0].target.terminalSessionId,'one');
  assert.equal(ui.managerOpens(),0,'queue does not open the full file manager');ui.stop();assert.equal(ui.dragListeners.size,0);
});

test('侧栏自由浏览使用显示目录，命令运行和轮询不将拖入目标改成 Shell cwd',async()=>{
  const ui=harness({native:true});await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  ui.find(node=>node.props.title==='folder').props.onClick();ui.render();await ui.tick();ui.requests.at(-1).resolve(listing('/home/folder'));await flush();ui.render();
  ui.cwd('/different-shell-cwd',{running:true});
  await ui.tick(); // Keep an ordinary polling request in flight while dropping.
  ui.nativeDrop(nativeDropEvent());let confirm=ui.find(node=>node.type==='upload-confirm');
  assert.ok(confirm);assert.equal(confirm.props.request.target.path,'/home/folder');
  confirm.props.onConfirm();ui.render();assert.equal(ui.transfers.length,1);assert.equal(ui.transfers[0].target.path,'/home/folder');ui.stop();
});

test('拖入确认可以取消；确认期间切换目录、身份、终端或隐藏侧栏不上传',async()=>{
  for(const change of [ui=>ui.cwd('/other'),ui=>ui.cwd('/home',{accessKey:'new-root'}),ui=>ui.render({runtime:{...ui.runtime,sessionId:'replacement'}}),ui=>ui.render({visible:false}),ui=>ui.render({connected:false}),ui=>ui.stop()]){
    const ui=harness({native:true});await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
    ui.nativeDrop(nativeDropEvent());const confirm=ui.find(node=>node.type==='upload-confirm');assert.ok(confirm);
    change(ui);confirm.props.onConfirm();ui.render();assert.equal(ui.transfers.length,0);ui.stop();
  }
  const ui=harness({native:true});await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  ui.nativeDrop(nativeDropEvent());ui.find(node=>node.type==='upload-confirm').props.onClose();ui.render();assert.equal(ui.transfers.length,0);assert.ok(!ui.find(node=>node.type==='upload-confirm'));ui.stop();
});

test('其他窗格或浮层上的拖放、目录未就绪、本地终端和隐藏侧栏不会接收文件',async()=>{
  const ui=harness({native:true});ui.nativeDrop(nativeDropEvent());assert.ok(!ui.find(node=>node.type==='upload-confirm'));
  await ui.tick();ui.requests[0].resolve(listing('/home'));await flush();ui.render();
  ui.nativeDrop(nativeDropEvent('enter'));ui.nativeDrop(nativeDropEvent('over'),false);assert.ok(!ui.find(node=>node.props.className==='terminal-file-drop-hint'));
  ui.nativeDrop(nativeDropEvent(),false);assert.ok(!ui.find(node=>node.type==='upload-confirm'));
  ui.nativeDrop({type:'leave'});ui.render({visible:false});assert.equal(ui.dragListeners.size,0);
  ui.nativeDrop(nativeDropEvent());assert.equal(ui.transfers.length,0);ui.stop();
  const local=harness({native:true});local.render({local:true});await flush();assert.equal(local.dragListeners.size,0);local.stop();
});

test('关闭发生在原生监听注册完成之前，也会释放迟到的监听',async()=>{
  const ui=harness({native:true});assert.equal(ui.dragListeners.size,1);ui.stop();await flush();
  assert.equal(ui.dragListeners.size,0);assert.equal(ui.stoppedDragListeners(),1);
});
