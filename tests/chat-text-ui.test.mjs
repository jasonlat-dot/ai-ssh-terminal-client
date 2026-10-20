import { loadToastErrorHooks } from './helpers/toast-errors.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function load(path, requireModule, globals = {}) {
  const compiled = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, File, Blob, crypto, AbortController, URL, Error, ...globals });
  vm.runInContext(compiled, context); return context.exports;
}
function state(upload) {
  const policy = load('config/fileUpload.ts', () => { throw new Error('Unexpected policy import'); });
  const queue = load('state/fileUploads.ts', name => {
    if (name === '../api/files.ts') return { uploadFile: upload };
    if (name === '../api/client.ts') return { ApiRequestError: class extends Error {} };
    if (name === '../config/fileUpload.ts') return policy;
    throw new Error(name);
  });
  return load('state/chatAttachments.ts', name => {
    if (name === './fileUploads.ts') return queue;
    throw new Error(name);
  });
}
const result = file => ({ fileId: crypto.randomUUID(), fileName: file.name, size: file.size, contentType: file.type, status: 'UPLOADED', downloadUrl: '', urlExpiresAt: '' });

function composer({ upload = async file => result(file), send = async () => true } = {}) {
  const api = state(upload), chatDraft = new api.ChatAttachmentDraft(new api.AttachmentPreviews());
  const slots = [], effects = [], frames = []; let cursor = 0, tree;
  const ref = { current: null }, props = { ref, chatDraft, draftScope: 1, messages: [], connected: false, localTerminal: false,
    busy: false, stopping: false, disabled: false, collapsed: false, send, stop() {}, clear() {},
    agentAvailability: { ready: true, loading: false, error: '', retry() {} },
    history: { sessions: [], activeSessionId: '', open: false, loading: false, loadingSessionId: '', error: '', toggle() {}, refresh() {}, select() {} } };
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) { const index = cursor++, previous = slots[index];
      if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i]))) {
        const effect = { deps, cleanup: null }; slots[index] = effect; effects.push(() => { previous?.cleanup?.(); effect.cleanup = callback(); });
      } },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
    useImperativeHandle(target, create) { target.current = create(); },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const notices=[];
  const leaf = () => null;
  const { AgentPanel } = load('components/AgentPanel.tsx', name => {
    if (name === '../state/useToastError') return loadToastErrorHooks(hooks,(message,type)=>notices.push({message,type}));
    if (name === 'react') return hooks;
    if (name === 'react-dom') return { createPortal: children => children };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === '../state/chatAttachments') return api;
    if (name === '../api/files') return { pickNativeAttachments: async()=>{} };
    if (name.endsWith('.png')) return 'robot.png';
    if (name === './Ui') return { AccentIcon: leaf, Badge: leaf, Icon: leaf };
    if (name === './Select') return { Select: leaf };
    if (name === './MarkdownMessage') return { MarkdownMessage: leaf };
    if (name === './AgentContextStatus') return { AgentContextStatus: leaf };
    if (name === './ChatFailure') return { ChatFailure: leaf };
    if (name === './AgentEmptyState') return { AgentEmptyState: leaf };
    if (name === './AgentMemory') return { AgentMemoryButton: leaf };
    if (name === './ComposerProjectPicker') return { ComposerProjectPicker: leaf };
    if (name === './ModelPicker') return { ModelPicker: leaf };
    if (name === './ComposerReasoningControl') return { ComposerReasoningControl: leaf };
    if (name === './AgentExecution') return { AgentExecution: leaf, NativeToolOutput: leaf, ExecutionContext: { Provider: leaf } };
    if (name === '../state/messageTime') return { messageTime: () => '' };
    if (name === '../state/agentTranscript') return load('state/agentTranscript.ts', () => { throw new Error('Unexpected transcript import'); });
    if (name === './CopyMarkdownButton') return { CopyMarkdownButton: leaf };
    if (name === './CopyTextButton') return { CopyTextButton: leaf };
    if (name === './ChatAttachments') return { DraftAttachments: leaf, MessageAttachments: leaf };
    if (name === '../api/chatErrors') return { chatErrorGuidance: () => '' };
    if (name === '../state/chatMarkdown') return {};
    throw new Error(name);
  }, { requestAnimationFrame: callback => frames.push(callback), cancelAnimationFrame() {}, window: { addEventListener() {}, removeEventListener() {}, setTimeout() { return 1; }, clearTimeout() {} } });
  function find(predicate, node) {
    if (arguments.length === 1) node = tree;
    if (Array.isArray(node)) { for (const child of node) { const found = find(predicate, child); if (found) return found; } return; }
    if (!node?.props) return;
    if (predicate(node)) return node;
    return find(predicate, node.props.children ?? null);
  }
  function render() {
    cursor = 0; tree = AgentPanel(props);
    const field = find(node => node.type === 'textarea');
    field.props.ref.current = { value: field.props.value, style: {}, scrollHeight: 42, focus() {}, setSelectionRange() {} };
    while (effects.length) effects.shift()();
    while (frames.length) frames.shift()();
  }
  render(); render();
  const input = () => find(node => node.type === 'textarea');
  return { notices, api, chatDraft, ref, props, render, find, input,
    change(text) { input().props.onChange({ target: { value: text } }); render(); },
    paste(text, files = [], start = input().props.value.length, end = start) {
      let prevented = false;
      input().props.onPaste({ clipboardData: { items: [], files, getData: () => text },
        currentTarget: { value: input().props.value, selectionStart: start, selectionEnd: end }, preventDefault() { prevented = true; } });
      render(); return prevented;
    },
    async submit() { find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); render(); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); },
  };
}

test('终端短文本追加而非覆盖；长文本只加入卡片，不挤占输入框、不自动发送', async () => {
  let sends = 0; const ui = composer({ send: async () => { sends++; return true; } });
  ui.change('请解释'); assert.equal(ui.ref.current.addText('短命令', 'terminal'), true); ui.render();
  assert.equal(ui.input().props.value, '请解释\n短命令');
  assert.equal(ui.chatDraft.getSnapshot().length, 0);
  const long = '日志输出😀\n'.repeat(40);
  assert.equal(ui.ref.current.addText(long, 'terminal'), true); ui.render(); await ui.settle();
  assert.equal(ui.input().props.value, '请解释\n短命令'); assert.equal(ui.chatDraft.getSnapshot().length, 1);
  assert.equal(ui.chatDraft.ready()[0].textExcerpt.source, 'terminal'); assert.equal(sends, 0);
  ui.props.busy = true; ui.render(); assert.equal(ui.ref.current.addText('继续补充', 'terminal'), true); ui.render();
  assert.equal(ui.input().props.value, '请解释\n短命令\n继续补充'); assert.equal(sends, 0);
  ui.props.disabled = true; ui.render(); assert.equal(ui.ref.current.addText('不能写入', 'terminal'), false);
  assert.equal(ui.input().props.value, '请解释\n短命令\n继续补充');
  ui.chatDraft.clear();
});

test('纯文本 99 字符保留原生粘贴，100 字符使用卡片；混合短文本仍按光标替换且保留其余草稿', async () => {
  const ui = composer(); ui.change('before OLD after');
  assert.equal(ui.paste('x'.repeat(99)), false); assert.equal(ui.chatDraft.getSnapshot().length, 0);
  assert.equal(ui.paste('x'.repeat(100)), true); await ui.settle();
  assert.equal(ui.input().props.value, 'before OLD after');
  assert.equal(ui.chatDraft.ready()[0].textExcerpt.source, 'paste');
  ui.chatDraft.clear();
  assert.equal(ui.paste('new', [new File(['file'], 'note.txt', { type: 'text/plain' })], 7, 10), true);
  assert.equal(ui.input().props.value, 'before new after'); await ui.settle(); ui.chatDraft.clear();
});

test('超限不丢草稿；上传中阻止发送，失败队列保留附件并可恢复编辑后重试', async () => {
  let resolve, sends = 0, succeed = false;
  const ui = composer({ upload: file => new Promise(done => { resolve = () => done(result(file)); }),
    send: async () => { sends++; return succeed; } });
  ui.change('已有问题');
  ui.paste('x'.repeat(100), Array.from({ length: 4 }, (_, i) => new File(['file'], `note${i}.txt`)));
  assert.equal(ui.chatDraft.getSnapshot().length, 0); assert.equal(ui.input().props.value, '已有问题');
  assert.equal(ui.notices.at(-1).type,'error');assert.equal(ui.find(node => node.props.className === 'composer-attachment-error'),undefined);
  ui.paste('x'.repeat(100)); await ui.submit(); assert.equal(sends, 0);
  resolve(); await ui.settle(); await ui.submit(); await ui.settle();
  assert.equal(sends, 1); assert.ok(ui.find(node => node.props.className === 'composer-queue-item is-failed'));
  assert.equal(ui.input().props.value, '');
  ui.find(node => node.props['aria-label'] === '编辑排队消息').props.onClick(); ui.render();
  assert.equal(ui.chatDraft.getSnapshot().length, 1); assert.equal(ui.input().props.value, '已有问题');
  succeed = true; await ui.submit(); await ui.settle(); assert.equal(sends, 2);
  assert.equal(ui.chatDraft.getSnapshot().length, 0); assert.equal(ui.input().props.value, '');
  assert.ok(!ui.find(node => node.props.className?.startsWith('composer-queue-item')));
});

test('文本卡片使用紧凑摘要、字符数、准备状态及移除入口；内容按纯文本转义', () => {
  const api = state(async file => result(file));
  const policy = load('config/fileUpload.ts', () => { throw new Error('Unexpected import'); });
  const { DraftAttachments } = load('components/ChatAttachments.tsx', name => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: children => children };
    if (name === 'react/jsx-runtime') return runtime;
    if (name.endsWith('.css')) return {};
    if (name === '../state/chatAttachments') return api;
    if (name === '../config/fileUpload') return policy;
    if (name === './DownloadButton') return { DownloadButton: () => null };
    if (name === './CopyTextButton') return { CopyTextButton: () => null };
    if (name === '../api/agent') return { agentApi: {} };
    if (name === '../api/files') return { readNativeAttachmentPreview() {} };
    if (name === './Ui') return { fileTone: () => 'blue', Icon: () => React.createElement('svg'),
      Badge: ({ children }) => React.createElement('span', null, children), IconButton: ({ label }) => React.createElement('button', { 'aria-label': label }) };
    throw new Error(name);
  });
  const html = renderToStaticMarkup(React.createElement(DraftAttachments, { items: [{ id: 'text', name: 'terminal.txt', size: 200, status: 'uploading',
    textExcerpt: { source: 'terminal', characters: 100, preview: '<script>终端内容</script>' } }], draft: {}, locked: false, report() {} }));
  assert.match(html, /终端选中文本 · 100 字符/); assert.match(html, /正在添加文本/);
  assert.match(html, /移除附件 terminal.txt/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test('本地与 SSH 共用选区入口，读取 xterm 选区而非页面选择；新增入口不自动执行命令', () => {
  const terminal = source('components/RemoteTerminalView.tsx'), app = source('App.tsx');
  assert.match(terminal, /term\.current\?\.getSelection\(\)/);
  assert.match(terminal, /terminal-selection-action[\s\S]*添加到对话/);
  assert.match(terminal, /disabled: !hasSelection \|\| !canAddToAgent/);
  assert.match(app, /local=\{session.kind === 'local'\}[\s\S]*addToAgent=/);
  assert.match(app, /agentComposer.current\?\.addText\(text, 'terminal'\)/);
  assert.match(app, /setAgentCollapsed\(false\)/);
  const handler = terminal.match(/const addSelectionToAgent = [\s\S]*?\n  };/)?.[0];
  assert.ok(handler); assert.doesNotMatch(handler, /\.paste\(|\.write\(|\.send\(/);
});

test('恢复中的原生会话禁止发送，刷新和停止只调用显式入口；停止等待期间禁止重复操作', () => {
  const ui = composer(); let stops = 0, refreshes = 0;
  ui.props.models = [{agentId:'model',agentName:'日常模型',modelName:'test'}];
  ui.props.selectedModel = 'model'; ui.props.recoveredRunning = true; ui.props.disabled = true;
  ui.props.stopRecovered = () => { stops++; }; ui.props.refreshCurrent = () => { refreshes++; };
  ui.render();
  assert.equal(ui.input().props.disabled, true);
  const controls = ui.find(node => node.props.className === 'agent-recovery-controls');
  assert.ok(controls);
  const refresh = ui.find(node => node.type === 'button' && node.props.onClick === ui.props.refreshCurrent);
  const stop = ui.find(node => node.type === 'button' && node.props.onClick === ui.props.stopRecovered);
  assert.equal(!!refresh.props.disabled, false); assert.equal(!!stop.props.disabled, false);
  refresh.props.onClick(); stop.props.onClick(); assert.equal(refreshes,1); assert.equal(stops,1);
  ui.props.stopping = true; ui.render();
  assert.equal(ui.find(node => node.props.onClick === ui.props.stopRecovered).props.disabled,true);
  assert.equal(ui.find(node => node.props.onClick === ui.props.refreshCurrent).props.disabled,true);
});

test('停止后可恢复原请求而不自动发送；已有草稿不会被覆盖，新请求成功才清空', async () => {
  let sends = 0; const ui = composer({send:async text => { sends++; assert.equal(text,'原始问题'); return true; }});
  ui.props.models = [{agentId:'model',agentName:'模型'}];
  ui.props.messages = [{id:'r:user',role:'user',text:'原始问题'},
    {id:'r',role:'assistant',text:'部分回复',summary:'已停止生成。'}];
  ui.render();
  const restore = () => ui.find(node => node.props.className === 'chat-restore-request');
  ui.change('当前草稿'); restore().props.onClick(); ui.render();
  assert.equal(ui.input().props.value,'当前草稿'); assert.equal(sends,0);
  assert.equal(ui.notices.at(-1).type,'error');assert.equal(ui.find(node => node.props.className === 'composer-attachment-error'),undefined);
  ui.change(''); restore().props.onClick(); ui.render();
  assert.equal(ui.input().props.value,'原始问题'); assert.equal(sends,0);
  await ui.submit(); assert.equal(sends,1); assert.equal(ui.input().props.value,'');
});

test('切换会话后旧发送回执不能清空新草稿或锁住新会话', async () => {
  let finish; const ui = composer({send:() => new Promise(resolve => { finish=resolve; })});
  ui.change('旧会话请求'); await ui.submit();
  ui.props.draftScope=2; ui.props.history.activeSessionId='new-session'; ui.render(); ui.render();
  ui.change('新会话草稿');
  finish(true); await ui.settle();
  assert.equal(ui.input().props.value,'新会话草稿'); assert.equal(ui.input().props.disabled,false);
});
test('聊天绑定说明沿用标题状态灯并提供完整名称提示，不受当前页签描述覆盖', () => {
  const ui = composer();
  ui.props.targetLabel = '原服务器 A · 已断开';
  ui.props.host = { name: '当前服务器 B' };
  ui.props.connected = false;
  ui.props.localTerminal = true;
  ui.render();
  const label = ui.find(node => node.type === 'small' && node.props.title === ui.props.targetLabel);
  assert.equal(label.props.children[1], '原服务器 A · 已断开');
  assert.match(label.props.children[0].props.className, /offline/);
  ui.props.connected = true;
  ui.props.targetLabel = '原服务器 A · 已绑定';
  ui.render();
  const connected = ui.find(node => node.type === 'small' && node.props.title === ui.props.targetLabel);
  assert.equal(connected.props.children[1], '原服务器 A · 已绑定');
  assert.doesNotMatch(connected.props.children[0].props.className, /offline/);
});

test('范围选择与服务器按钮只触发显式切换，忙碌/离线时锁定且不发送内容', () => {
  const ui=composer();const selected=[],servers=[];
  ui.props.models=[{agentId:'model',agentName:'文本模型'}];
  ui.props.scopeControls={value:'general',options:[{value:'general',label:'普通对话'},{value:'a',label:'A 任务'}],
    select:id=>selected.push(id),useServer:value=>servers.push(value),serverAvailable:true,serverName:'A',locked:false,serverTask:true,general:true};
  ui.render();
  assert.ok(ui.find(node=>node.type==='i' && node.props.className==='status-dot general'));
  ui.find(node=>node.props.label==='对话范围').props.onChange('a');
  const action=ui.find(node=>node.props.title==='在独立上下文中讨论 A');
  action.props.onClick();
  assert.deepEqual(selected,['a']);assert.deepEqual(servers,[false]);
  ui.props.scopeControls.serverAvailable=false;ui.render();
  assert.equal(ui.find(node=>node.props.title==='在独立上下文中讨论 A').props.disabled,true);
  assert.equal(ui.find(node=>node.props.label==='对话范围').props.disabled,false);
  ui.props.scopeControls.locked=true;ui.render();
  assert.equal(ui.find(node=>node.props.label==='对话范围').props.disabled,true);
  assert.equal(ui.input().props.value,'');
});

test('外置会话侧栏在生成时仍可收起，切换不清空草稿、不重复渲染历史弹层', () => {
  const ui = composer(); let toggles = 0, clears = 0;
  ui.props.history.external = true;
  ui.props.history.open = true;
  ui.props.history.toggle = () => { toggles++; };
  ui.props.clear = () => { clears++; };
  ui.change('保留尚未发送的草稿');
  ui.props.busy = true; ui.render();
  const toggle = ui.find(node => node.type === 'button' && node.props['aria-label'] === '切换会话侧栏');
  assert.equal(toggle.props.disabled, false);
  assert.equal(toggle.props['aria-controls'], 'workspace-sidebar-content');
  toggle.props.onClick(); ui.render();
  assert.equal(toggles, 1);
  assert.equal(clears, 0);
  assert.equal(ui.input().props.value, '保留尚未发送的草稿');
  assert.equal(ui.find(node => node.props.id === 'agent-history-list'), undefined);
});
