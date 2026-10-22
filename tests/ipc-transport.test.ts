import { RemoteTerminal } from '../src/state/remoteTerminal.ts';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { apiRequest } from '../src/api/client.ts';
import { terminalApi } from '../src/api/terminal.ts';
import { subscribeBuiltinTerminal, usesBuiltinIpc } from '../src/api/builtin.ts';
import { adoptBundledBackendUrl, readBackendUrl, saveBackendUrl, BUILTIN_ENDPOINT } from '../src/config/backend.ts';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis,'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis,'localStorage');
const originalFetch = globalThis.fetch;
const builtinEndpoint = 'ipc://builtin/00000000-0000-4000-8000-000000000001';
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');
  if (originalStorage) Object.defineProperty(globalThis,'localStorage',originalStorage);else Reflect.deleteProperty(globalThis,'localStorage');
  globalThis.fetch=originalFetch;
  adoptBundledBackendUrl(BUILTIN_ENDPOINT);
});
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
type Arguments = Record<string,any>;
function harness(handler: (command:string,args:Arguments)=>unknown) {
  const profiles=[{id:'builtin',kind:'builtin',name:'本地工作区',url:builtinEndpoint,trust:'system',certificatePem:''},
    {id:'remote',kind:'remote',name:'远程',url:'https://retired.example.test',trust:'system',certificatePem:''}];
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>key==='agent-ssh-backend-connections-v2' ? JSON.stringify({version:2,activeId:'remote',profiles}) : null, setItem:()=>undefined}});
  adoptBundledBackendUrl(builtinEndpoint);
  Object.defineProperty(globalThis,'window',{configurable:true,value:{__TAURI_INTERNALS__:{invoke:(command:string,args:Arguments)=>handler(command,{...args,...args.request}),transformCallback:()=>1,unregisterCallback:()=>undefined}}});
  globalThis.fetch=async()=>{throw new Error('desktop IPC must not call WebView fetch');};
  return {restart:()=>adoptBundledBackendUrl('ipc://builtin/00000000-0000-4000-8000-000000000002')};
}

test('legacy remote selection is ignored and local JSON requests use invoke',async()=>{
  const calls:string[]=[];
  harness((command,args)=>{calls.push(command);assert.equal(args.endpoint,'ssh/connection_list');return Promise.resolve([{connectionId:'one'}]);});
  assert.deepEqual(await apiRequest('ssh/connection_list'),[{connectionId:'one'}]);
  assert.deepEqual(calls,['builtin_request']);assert.equal(usesBuiltinIpc(),true);
  assert.equal(readBackendUrl(),builtinEndpoint);
  assert.equal(usesBuiltinIpc('https://retired.example.test'),false);
  assert.throws(()=>saveBackendUrl('https://retired.example.test'));
});
test('terminal operations retain their old instance identity after workspace reinitialization',async()=>{
  const endpoints:string[]=[];
  const context=harness((command,args)=>{assert.equal(command,'builtin_request');assert.equal(args.backendUrl,builtinEndpoint);endpoints.push(args.endpoint);
    return Promise.resolve(args.endpoint.endsWith('/connect') ? {sessionId:'pinned-native',connectionId:'connection',initialOutput:''} : null);});
  await terminalApi.connect('connection','request',new AbortController().signal,builtinEndpoint);
  context.restart();await terminalApi.write('pinned-native','ls\r',builtinEndpoint);
  await terminalApi.close('pinned-native',undefined,builtinEndpoint);
  assert.deepEqual(endpoints,['ssh/terminal/connect','ssh/terminal/write','ssh/terminal/close']);
});
test('native cancellation sends a receipt and prevents late mutation responses updating the UI',async()=>{
  const pending=deferred<unknown>();const calls:string[]=[];
  harness((command)=>{calls.push(command);return command==='builtin_request' ? pending.promise : Promise.resolve();});
  const controller=new AbortController();const request=apiRequest('ssh/create_connection',{method:'POST',body:{},signal:controller.signal});
  controller.abort();pending.resolve({connectionId:'late'});
  await assert.rejects(request,{name:'AbortError'});assert.ok(calls.includes('builtin_cancel'));
});
test('terminal Channel acknowledges only after rendering and ignores events after unsubscribe',async()=>{
  const pending=deferred<void>();const rendered=deferred<void>();const calls:string[]=[];let channel:any;
  harness((command,args)=>{calls.push(command);if(command==='builtin_terminal_subscribe'){channel=args.onEvent;return pending.promise;}return Promise.resolve();});
  let frames=0;
  const stop=subscribeBuiltinTerminal('session',builtinEndpoint,()=>{frames++;return rendered.promise;},error=>{throw error;});
  const receive=channel.onmessage({sequence:1,result:{status:'DATA',output:'汉🙂'}});
  await flush();assert.ok(!calls.includes('builtin_terminal_ack'));
  rendered.resolve();await receive;assert.ok(calls.includes('builtin_terminal_ack'));
  stop();await channel.onmessage({sequence:2,result:{status:'DATA',output:'late'}});assert.equal(frames,1);
  pending.resolve();await flush();assert.ok(calls.includes('builtin_terminal_unsubscribe'));
});
test('HTTP addresses cannot select a network transport or reach native commands',async()=>{
  const calls:string[]=[];
  harness(command=>{calls.push(command);return Promise.resolve();});
  await assert.rejects(apiRequest('ssh/connection_list',{baseUrl:'http://127.0.0.1:8889'}),error=>
    error instanceof Error && (error as {code?:string}).code==='DESKTOP_REQUIRED');
  assert.deepEqual(calls,[]);
});

test('补全目录和 AI 请求绑定原工作区，重新初始化后不切换实例',async()=>{
 const endpoints:string[]=[];
 const context=harness((command,args)=>{assert.equal(command,'builtin_request');assert.equal(args.backendUrl,builtinEndpoint);endpoints.push(args.endpoint);return Promise.resolve(args.endpoint==='agent/terminal_completion'?{suffix:'ormat'}:[]);});
 const runtime=new RemoteTerminal({sessionId:'pinned',connectionId:'connection',initialOutput:'',completionNonce:'a'.repeat(32)},true,builtinEndpoint);
 context.restart();
 await runtime.completionEntries('/opt/shop',new AbortController().signal);
 await runtime.completionRequest('profile',{prefix:'docker ps --f',cwd:''},new AbortController().signal);
 assert.deepEqual(endpoints,['ssh/terminal/completion_entries','agent/terminal_completion']);
});

test('目录跟随和补全任一开启就携带 Bash 集成，全部关闭才使用普通连接',async()=>{
 const bodies:Arguments[]=[];
 harness((_command,args)=>{bodies.push(args.body);return Promise.resolve({sessionId:'new',connectionId:'connection',initialOutput:''});});
 const storage=globalThis.localStorage;const original=storage.getItem;
 storage.getItem=(key:string)=>key==='shellpilot:terminal-completion:v1'?JSON.stringify({enabled:true,aiEnabled:false}):original(key);
 await terminalApi.connect('connection','enabled',new AbortController().signal,builtinEndpoint);
 assert.match(bodies[0].shellIntegration.nonce,/^[a-f0-9]{32}$/);assert.ok(bodies[0].shellIntegration.script.includes('__spc_snapshot'));
 storage.getItem=(key:string)=>key==='shellpilot:terminal-directory-follow:v1'?'false':original(key);
 await terminalApi.connect('connection','disabled',new AbortController().signal,builtinEndpoint);
 assert.equal(bodies[1].shellIntegration,undefined);
 storage.getItem=original;
 await terminalApi.connect('connection','directory-only',new AbortController().signal,builtinEndpoint);
 assert.match(bodies[2].shellIntegration.script,/D;\$REPLY/);
});

test('左侧文件列表固定原终端与工作区身份，目录报告独立于输出视图订阅', async () => {
 const calls:Arguments[]=[];
 const context=harness((_command,args)=>{calls.push(args);return Promise.resolve({path:'/opt',entries:[],truncated:false});});
 const nonce='b'.repeat(32),report=`\x1b]777;spc;${nonce};D;${Buffer.from('/opt').toString('hex')}\x07`;
 const runtime=new RemoteTerminal({sessionId:'original',connectionId:'host',initialOutput:report,completionNonce:nonce},true,builtinEndpoint);
 assert.equal(runtime.directorySnapshot().path,'/opt');
 context.restart(); await runtime.directoryList('/opt',new AbortController().signal);
 assert.equal(calls[0].backendUrl,builtinEndpoint); assert.equal(calls[0].endpoint,'ssh/terminal/directory');
 assert.equal(calls[0].params.sessionId,'original'); assert.equal(calls[0].params.path,'/opt');
 await runtime.adoptDirectoryNonce('c'.repeat(32));
 assert.equal(calls[1].backendUrl,builtinEndpoint);
 assert.equal(calls[1].endpoint,'ssh/terminal/directory_integration');
 assert.equal(calls[1].body.sessionId,'original');
});
