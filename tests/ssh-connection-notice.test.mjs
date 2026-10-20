import assert from 'node:assert/strict';
import test,{beforeEach} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as notices from '../src/state/notifications.ts';

const read=path=>readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const attemptCode=compile(read('state/sshConnectAttempt.ts'));
const app=ts.createSourceFile('App.tsx',read('App.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const expressions=new Map();
function visit(node){if(ts.isVariableDeclaration(node)&&['selectHost','openTerminalRuntime','cancelHostConnection'].includes(node.name.getText(app)))expressions.set(node.name.getText(app),node.initializer.getText(app));ts.forEachChild(node,visit);}
visit(app);assert.equal(expressions.size,3);
const appCode=compile([...expressions].map(([name,value])=>`export const ${name}=${value};`).join('\n'));
const pendingNotices=()=>notices.readNotices().filter(notice=>notice.durationMs===0);
beforeEach(()=>{for(const notice of notices.readNotices())notices.dismissNotice(notice.id);});
function clock(){let time=0,sequence=0;const timers=new Map();return {timers,setTimeout(callback,ms){const id=++sequence;timers.set(id,{callback,at:time+ms});return id;},clearTimeout(id){timers.delete(id);},advance(ms){time+=ms;for(const [id,timer]of [...timers])if(timer.at<=time){timers.delete(id);timer.callback();}}};}
function deferred(){let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<14;i++)await Promise.resolve();}
function harness(hosts=[{id:'host',name:'凯平哥',connectTimeout:2}]){
 const time=clock(),calls=[],cancelled=[],closed=[],sessions=[],openingConnections={current:new Map()},opening={current:new Set()};
 const api={connect(...args){const wait=deferred();calls.push({args,...wait});return wait.promise;},cancelConnect(...args){cancelled.push(args);return Promise.resolve();},close(...args){closed.push(args);return Promise.resolve();}};
 const attemptModule=vm.createContext({exports:{},crypto,AbortController,DOMException,Error,Promise,console,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,require(name){if(name==='../api/terminal')return{terminalApi:api};throw new Error(name);}});
 vm.runInContext(attemptCode,attemptModule);
 let connecting=new Set();
 class Runtime{constructor(opened){this.sessionId=opened.sessionId;this.disconnected=false;this.readLoopGeneration=1;}markManuallyClosed(){this.manuallyClosed=true;}}
 const globals={exports:{},crypto,Error,DOMException,hosts,backendUrl:'ipc://original',...notices,SshConnectAttempt:attemptModule.exports.SshConnectAttempt,RemoteTerminal:Runtime,terminalApi:api,openingConnections,opening,
  terminalClients:{current:new Map()},tabLastUsedAt:{current:new Map()},setSessions(update){sessions.splice(0,sessions.length,...update(sessions));},setActiveId(){},setNavigation(){},createSessionFileState(){return{};},setConnectingHostIds(update){connecting=update(connecting);}};
 const context=vm.createContext(globals);vm.runInContext(appCode,context);
 return {...context.exports,time,calls,cancelled,closed,sessions,openingConnections,opening,get connecting(){return connecting;}};
}

test('连接成功立即移除等待提示，并清除超时定时器',async()=>{
 const h=harness();const task=h.selectHost('host');assert.equal(pendingNotices().length,1);
 h.calls[0].resolve({sessionId:'live',initialOutput:'',connectionId:'host'});const session=await task;
 assert.equal(session.terminalSessionId,'live');assert.equal(pendingNotices().length,0);assert.equal(h.time.timers.size,0);
 assert.equal(h.connecting.size,0);assert.equal(h.openingConnections.current.size,0);assert.ok(notices.readNotices().some(n=>n.type==='success'));
 h.time.advance(60000);assert.equal(h.cancelled.length,0);
});
test('服务端失败结束等待提示，展示原始失败原因且释放连接状态',async()=>{
 const h=harness();const task=h.selectHost('host');h.calls[0].reject(new Error('认证失败：密码不正确'));await task;
 assert.equal(pendingNotices().length,0);assert.equal(h.connecting.size,0);assert.equal(h.time.timers.size,0);
 assert.match(notices.readNotices().find(n=>n.type==='error').message,/连接 凯平哥 失败：认证失败：密码不正确/);
 assert.equal(h.cancelled.length,1);
});
test('达到服务器配置的连接超时后移除等待提示并主动取消原请求',async()=>{
 const h=harness();const task=h.selectHost('host');h.time.advance(1999);await flush();assert.equal(pendingNotices().length,1);
 h.time.advance(1);await task;assert.equal(pendingNotices().length,0);assert.equal(h.connecting.size,0);
 assert.match(notices.readNotices().find(n=>n.type==='error').message,/连接超时（2 秒）/);
 assert.equal(h.calls[0].args[2].aborted,true);assert.equal(h.cancelled.length,1);
 assert.deepEqual(h.cancelled[0],['host',h.calls[0].args[1],'ipc://original']);
});
test('超时后迟到的成功会话被关闭，不新增页签或误报成功',async()=>{
 const h=harness();const task=h.selectHost('host');h.time.advance(2000);await task;
 h.calls[0].resolve({sessionId:'late',initialOutput:'',connectionId:'host'});await flush();
 assert.equal(h.sessions.length,0);assert.equal(h.closed.length,1);assert.deepEqual(h.closed[0],['late',undefined,'ipc://original']);
 assert.ok(!notices.readNotices().some(n=>n.type==='success'));assert.equal(pendingNotices().length,0);
});
test('手动取消即使连接 API 不响应 abort 也立即清理，不报连接失败',async()=>{
 const h=harness();const task=h.selectHost('host');h.cancelHostConnection('host');await task;
 assert.equal(pendingNotices().length,0);assert.equal(h.time.timers.size,0);assert.equal(h.connecting.size,0);
 assert.ok(!notices.readNotices().some(n=>n.type==='error'));assert.equal(h.cancelled.length,1);
});
test('相同名称的并发连接各自持有提示，完成其中一个不会关闭另一个',async()=>{
 const h=harness([{id:'a',name:'同名服务器',connectTimeout:2},{id:'b',name:'同名服务器',connectTimeout:2}]);
 const a=h.selectHost('a'),b=h.selectHost('b');assert.equal(pendingNotices().length,2);
 h.calls[0].resolve({sessionId:'a-live'});await a;assert.equal(pendingNotices().length,1);assert.ok(h.connecting.has('b'));
 h.calls[1].resolve({sessionId:'b-live'});await b;assert.equal(pendingNotices().length,0);assert.equal(h.sessions.length,2);
});
test('取消后立即重试不受旧请求清理影响，旧成功不会覆盖新连接',async()=>{
 const h=harness();const old=h.selectHost('host');h.cancelHostConnection('host');const fresh=h.selectHost('host');await old;
 assert.equal(pendingNotices().length,1);assert.equal(h.openingConnections.current.size,1);
 h.calls[0].resolve({sessionId:'old-late'});await flush();assert.equal(pendingNotices().length,1);assert.equal(h.sessions.length,0);
 h.calls[1].resolve({sessionId:'new-live'});await fresh;assert.equal(pendingNotices().length,0);assert.equal(h.sessions[0].terminalSessionId,'new-live');
});
test('未设置连接超时时使用与原生一致的十秒默认值',async()=>{
 const h=harness([{id:'host',name:'默认超时'}]);const task=h.selectHost('host');h.time.advance(9999);await flush();assert.equal(pendingNotices().length,1);
 h.time.advance(1);await task;assert.match(notices.readNotices().find(n=>n.type==='error').message,/连接超时（10 秒）/);
});
test('等待提示手动关闭保持连接进行中，操作结束的关闭函数可重复调用',async()=>{
 const h=harness();const task=h.selectHost('host');notices.dismissNotice(pendingNotices()[0].id);assert.equal(h.calls[0].args[2].aborted,false);
 h.calls[0].resolve({sessionId:'manual-dismiss'});await task;assert.equal(h.sessions.length,1);
 const close=notices.beginNotice('pending');close();close();assert.equal(pendingNotices().length,0);
});
test('持久等待提示不启动自动关闭计时，普通提示仍按原时长关闭',()=>{
 const code=compile(read('components/NotificationToast.tsx'));const effects=[],time=clock();let closes=0;
 const context=vm.createContext({exports:{},setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,require(name){
  if(name==='react')return{useState:initial=>[initial,()=>{}],useRef:value=>({current:value}),useEffect:effect=>effects.push(effect)};
  if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='react-dom')return{createPortal:node=>node};if(name==='../state/notifications')return notices;if(name==='./Ui')return{Icon:()=>null};throw new Error(name);
 }});vm.runInContext(code,context);
 context.exports.NotificationToast({notice:{id:1,type:'info',message:'pending',durationMs:0},close:()=>closes++});effects.splice(0).forEach(effect=>effect());assert.equal(time.timers.size,0);
 context.exports.NotificationToast({notice:{id:2,type:'success',message:'ready'},close:()=>closes++});effects.splice(0).forEach(effect=>effect());assert.equal(time.timers.size,1);time.advance(3500);assert.equal(closes,1);
});


test('重复点击同一服务器复用在途状态，不产生另一条延时等待提示',async()=>{
 const h=harness();const first=h.selectHost('host');await h.selectHost('host');
 assert.equal(h.calls.length,1);assert.equal(notices.readNotices().length,1);
 h.calls[0].resolve({sessionId:'single'});await first;
 assert.equal(pendingNotices().length,0);assert.ok(notices.readNotices().every(n=>n.type==='success'));
});
