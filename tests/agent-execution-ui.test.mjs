import { loadToastErrorHooks } from './helpers/toast-errors.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as toolOutput from '../src/state/toolOutput.ts';

const source=readFileSync(new URL('../src/components/AgentExecution.tsx',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness(api={},extensions={}){
  const slots=[],effects=[],timers=[];let cursor=0;const contexts=new Map();
  const hooks={createContext:value=>({value}),useContext:context=>context.value,
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useRef(initial){const index=cursor++;return slots[index]??(slots[index]={current:initial});},
    useEffect(effect,deps){const index=cursor++;const previous=slots[index];if(!previous||deps.some((value,i)=>value!==previous.deps[i])){slots[index]={deps,cleanup:null};effects.push(()=>{previous?.cleanup?.();slots[index].cleanup=effect();});}}};
  const context=vm.createContext({exports:{},Date,Error,JSON,Map,Array,Number,TextDecoder,Uint8Array,AbortController,document:{addEventListener(){},removeEventListener(){},activeElement:null},
    setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout(){},
    require(name){if(name==='../state/useToastError')return loadToastErrorHooks(hooks);if(name==='react')return hooks;if(name==='react-dom')return {createPortal:children=>children};if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='../state/toolOutput')return toolOutput;if(name==='../api/agent')return {agentApi:api};if(name==='../api/agentExtensions')return {extensionApi:{requests:async()=>[],...extensions}};if(name==='./Ui')return {Icon:()=>null};if(name==='./CopyTextButton')return {CopyTextButton:()=>null};if(name.endsWith('.css'))return {};throw new Error(name);}});
  vm.runInContext(output,context);
  return {module:context.exports,timers,render(name,props){cursor=0;return context.exports[name](props);},flush(){while(effects.length)effects.shift()();},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
function all(node){if(Array.isArray(node))return node.flatMap(all);return node?.props?[node,...all(node.props.children)]:[];}
function text(node){if(Array.isArray(node))return node.map(text).join(' ');return node?.props?text(node.props.children):typeof node==='string'||typeof node==='number'?String(node):'';}
const receipt={id:'approval',callId:'call',binding:{sessionId:'chat',tool:{taskId:'task',target:{connectionId:'a',terminalSessionId:'terminal-a'}},identity:{host:'server-a',port:22,username:'root',hostKey:'SHA256:example'}},task:{id:'task',goal:'inspect',constraints:['不要重启']},command:{command:'printf "汉🙂"\ncheck',timeoutSeconds:30},state:'pending',createdAt:Date.now(),expiresAt:Date.now()+300000,grant:null,result:null};
const scope={agentId:'model',sessionId:'chat',enabled:true,available:true,connected:true,locked:false,target:receipt.binding.identity,terminalId:'terminal-a',toggle:async()=>{}};

test('Command purpose explains simple commands even when old receipts stored the missing-purpose placeholder',()=>{
 const h=harness();
 const purpose=command=>{
  const tree=h.render('ApprovalCard',{receipt:{...receipt,command:{timeoutSeconds:20,...command}},disabled:false,act(){}});
  return text(all(tree).find(n=>n.type==='div'&&all(n).some(child=>child.type==='dt'&&text(child)==='命令用途')));
 };
 for(const explanation of [undefined,null,'','  ','未提供命令用途说明，请核对完整命令。']) {
  assert.match(purpose({command:'df -h',explanation}),/磁盘总量、已用空间、可用空间和使用率/);
  assert.match(purpose({command:'whoami',explanation}),/用户身份/);
  assert.match(purpose({command:'pwd',explanation}),/工作目录/);
 }
 assert.match(purpose({command:'df -h',explanation:'查看挂载文件系统的容量'}),/查看挂载文件系统的容量/);
 for(const command of ['df -h && custom-script','df -h | cat','df\n-h','df -h; whoami'])
  assert.match(purpose({command}),/未附用途说明/);
});

test('D5 approval UI shows exact host/command and distinct once/task/deny/cancel actions',()=>{
  const h=harness();const decisions=[];const tree=h.render('ApprovalCard',{receipt,disabled:false,act:(id,action)=>decisions.push([id,action])});
  assert.match(text(tree).replace(/\s/g,''),/root@server-a:22/);assert.match(text(tree),/printf "汉🙂"\ncheck/);assert.match(text(tree),/手工命令和后台终端输出不会作为工具结果/);
  for(const button of all(tree).filter(n=>n.type==='button'))button.props.onClick();
  assert.deepEqual(decisions.map(d=>d[1]),['cancel','deny','approveOnce','approveOnce','approveTaskCommand']);
  const menu=all(tree).find(n=>n.props.className?.startsWith('execution-approval-menu'));
  assert.ok(menu);assert.match(text(menu),/有效 5 分钟，仅限此服务器与精确命令/);
});
test('D5 expired, admitted and unknown receipts never offer approval as if unexecuted',()=>{
  const h=harness();for(const state of ['expired','admitted','unknown']){
    const tree=h.render('ApprovalCard',{receipt:{...receipt,state},disabled:false,act:()=>assert.fail('cannot approve')});
    assert.ok(!all(tree).some(n=>n.type==='button'&&/仅允许|5 分钟/.test(text(n))));
    if(state!=='expired')assert.match(text(tree),/可能已经执行/);
  }
  assert.equal(h.module.approvalLabel({...receipt,expiresAt:0}),'已过期');
});
test('D5 exact task command grant shows durable revoke status and does not offer stale renewal',()=>{
  const h=harness();const decisions=[];
  let tree=h.render('ApprovalCard',{receipt:{...receipt,state:'completed',grant:{expiresAt:Date.now()+300000,revoked:false}},disabled:false,act:(_,action)=>decisions.push(action)});
  all(tree).find(n=>n.type==='button'&&text(n)==='撤销相同命令授权').props.onClick();assert.deepEqual(decisions,['revoke']);
  tree=h.render('ApprovalCard',{receipt:{...receipt,state:'completed',grant:{expiresAt:Date.now()+300000,revoked:true}},disabled:false,act:()=>assert.fail()});assert.match(text(tree),/已撤销/);assert.ok(!all(tree).some(n=>n.type==='button'));
});
test('原始输出引用过滤掉非法通道和大小',()=>{
  assert.equal(toolOutput.outputReferences({outputs:[{id:'a',channel:'stdout',size:4,sha256:'hash'},{id:'bad',channel:'stdin',size:4},{id:'negative',channel:'stderr',size:-1,sha256:'hash'}]}).length,1);
});

test('D5 pending approval poll opens record panel and routes decisions to the same session',async()=>{
  const requests=[];const actions=[];const h=harness({executionRequests:async(...args)=>{requests.push(args);return [receipt];},executionPolicy:async()=>({mode:'confirm',revision:0}),executionDecision:async(...args)=>{actions.push(args);return true;}});
  h.render('AgentExecution',{scope});h.flush();await new Promise(setImmediate);
  let tree=h.render('AgentExecution',{scope});h.flush();assert.equal(requests[0][0],'model');assert.equal(requests[0][1],'chat');
  const card=all(tree).find(n=>n.type===h.module.ApprovalCard);assert.ok(card);card.props.act('approval','approveOnce');await new Promise(setImmediate);
  assert.deepEqual(actions[0],['model','chat','approval','approveOnce']);
  tree=h.render('AgentExecution',{scope:{...scope,locked:true},policyTarget:{}});
  assert.equal(all(tree).find(n=>n.type===h.module.ExecutionPolicyMenu).props.disabled,true);
});

test('A delayed approval decision stays on its original chat after navigation and cannot clear another approval',async()=>{
 let finish;const actions=[];const pending=new Promise(resolve=>{finish=resolve;});
 const old=harness({executionRequests:async()=>[receipt],executionPolicy:async()=>({mode:'confirm',revision:0}),
  executionDecision:async(...args)=>{actions.push(args);await pending;}});
 const first={scope,approvalTarget:{}};old.render('AgentExecution',first);old.flush();await new Promise(setImmediate);
 const oldTree=old.render('AgentExecution',first);old.flush();
 all(oldTree).find(n=>n.type===old.module.ApprovalCard).props.act('approval','approveOnce');old.unmount();
 const changes=[];const nextReceipt={...receipt,id:'approval-B',binding:{...receipt.binding,sessionId:'chat-B'}};
 const next=harness({executionRequests:async()=>[nextReceipt],executionPolicy:async()=>({mode:'confirm',revision:0})});
 const second={scope:{...scope,agentId:'model-B',sessionId:'chat-B'},approvalTarget:{},onPendingChange:value=>changes.push(value)};
 next.render('AgentExecution',second);next.flush();await new Promise(setImmediate);next.render('AgentExecution',second);next.flush();
 assert.equal(changes.at(-1),true);finish();await new Promise(setImmediate);
 assert.deepEqual(actions,[['model','chat','approval','approveOnce']]);assert.equal(changes.at(-1),true);
 const nextTree=next.render('AgentExecution',second);next.flush();
 assert.equal(all(nextTree).find(n=>n.type===next.module.ApprovalCard).props.receipt.id,'approval-B');next.unmount();
});
test('D5 unknown tool output with retained original references remains readable without claiming execution succeeded',()=>{
  const h=harness();const tree=h.render('NativeToolOutput',{output:JSON.stringify({ok:false,error:'result_unknown',data:{outputs:[{id:'raw',channel:'stderr',size:100,sha256:'hash'}]}})});
  assert.match(text(tree),/工具未完成/);assert.match(text(tree),/result_unknown/);
  assert.match(text(tree),/正在读取完整执行结果/);
  assert.equal(all(tree).some(n=>n.type==='details'),false);
});
test('Pending approval is portaled into the composer without duplicating its history card',async()=>{
  const changes=[];const h=harness({executionRequests:async()=>[receipt],executionPolicy:async()=>({mode:'confirm',revision:0})});
  const props={scope,approvalTarget:{},onPendingChange:value=>changes.push(value)};h.render('AgentExecution',props);h.flush();await new Promise(setImmediate);
  const tree=h.render('AgentExecution',props);h.flush();assert.equal(changes.at(-1),true);
  const cards=all(tree).filter(n=>n.type===h.module.ApprovalCard);assert.equal(cards.length,1);
  assert.ok(all(tree).some(n=>n.props.className==='composer-approval'));
});
test('展开后自动读取完整输出，展示与复制共用文本，关闭后缓存不重复读取',async()=>{
  const calls=[];let renderedCopy;
  const h=harness({executionOutput:async(...args)=>{calls.push(args);return {offset:0,nextOffset:14,size:14,eof:true,channel:'stdout',bytes:Array.from(new TextEncoder().encode('Docker version'))};}});
  h.module.ExecutionContext.value={agentId:'model',sessionId:'chat'};
  const props={active:false,output:JSON.stringify({ok:true,data:{exitCode:0,stdout:'omitted preview',stderr:'',outputs:[{id:'out',channel:'stdout',size:14,sha256:'hash'}]}}),renderActions:(getText,ready)=>{renderedCopy={getText,ready};return null;}};
  h.render('NativeToolOutput',props);h.flush();await new Promise(setImmediate);assert.equal(calls.length,0);
  props.active=true;let tree=h.render('NativeToolOutput',props);h.flush();assert.equal(renderedCopy.ready,false);assert.throws(()=>renderedCopy.getText());
  assert.match(text(tree),/正在读取完整执行结果/);assert.doesNotMatch(text(tree),/omitted preview|查看完整输出|读取原始输出/);
  await new Promise(setImmediate);tree=h.render('NativeToolOutput',props);h.flush();
  assert.match(text(tree),/Docker version/);assert.equal(renderedCopy.ready,true);assert.equal(renderedCopy.getText(),'Docker version');
  assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,5),['model','chat','out',0,14]);
  assert.equal(all(tree).some(node=>node.type==='details'),false);
  props.active=false;h.render('NativeToolOutput',props);h.flush();props.active=true;h.render('NativeToolOutput',props);h.flush();assert.equal(calls.length,1);
});

test('原始输出失败显示重试，阻止复制摘要；重试成功后恢复完整结果',async()=>{
  let fail=true,copy;
  const h=harness({executionOutput:async()=>{if(fail)throw new Error('输出不存在');return {offset:0,nextOffset:2,size:2,eof:true,channel:'stderr',bytes:[111,107]};}});
  h.module.ExecutionContext.value={agentId:'model',sessionId:'chat'};
  const props={output:JSON.stringify({ok:false,data:{stderr:'summary',outputs:[{id:'out',channel:'stderr',size:2,sha256:'hash'}]}}),renderActions:(getText,ready)=>{copy={getText,ready};return null;}};
  h.render('NativeToolOutput',props);h.flush();await new Promise(setImmediate);
  let tree=h.render('NativeToolOutput',props);h.flush();assert.match(text(tree),/输出不存在|已保留的输出摘要/);assert.equal(copy.ready,false);assert.throws(()=>copy.getText());
  fail=false;all(tree).find(node=>node.type==='button'&&text(node)==='重试读取').props.onClick();
  h.render('NativeToolOutput',props);h.flush();await new Promise(setImmediate);tree=h.render('NativeToolOutput',props);h.flush();
  assert.equal(copy.getText(),'ok');assert.doesNotMatch(text(tree),/summary|输出不存在/);
});

test('切换会话或收起时取消旧读取，迟到的旧输出不能替换新结果',async()=>{
  let finishOld,oldSignal;
  const h=harness({executionOutput:async(agent,chat,id,offset,limit,signal)=>{
    if(chat==='old'){oldSignal=signal;return new Promise(resolve=>{finishOld=resolve;});}
    return {offset:0,nextOffset:3,size:3,eof:true,channel:'stdout',bytes:[110,101,119]};
  }});
  const props={output:JSON.stringify({ok:true,data:{outputs:[{id:'out',channel:'stdout',size:3,sha256:'hash'}]}})};
  h.module.ExecutionContext.value={agentId:'model',sessionId:'old'};
  h.render('NativeToolOutput',props);h.flush();
  h.module.ExecutionContext.value={agentId:'model',sessionId:'new'};
  h.render('NativeToolOutput',props);h.flush();assert.equal(oldSignal.aborted,true);await new Promise(setImmediate);
  finishOld({offset:0,nextOffset:3,size:3,eof:true,channel:'stdout',bytes:[111,108,100]});await new Promise(setImmediate);
  const tree=h.render('NativeToolOutput',props);h.flush();assert.match(text(tree),/new/);assert.doesNotMatch(text(tree),/old/);
  h.unmount();
});

test('Composer permission menu presents three distinct modes, current selection and pending state',()=>{
  const changes=[];const h=harness();
  const props={policy:{mode:'auto',revision:3},disabled:false,retry(){},select:mode=>changes.push(mode)};
  let tree=h.render('ExecutionPolicyMenu',props);h.flush();
  const trigger=all(tree).find(n=>n.props['aria-label']==='工具审核边界');
  assert.equal(trigger.props['aria-expanded'],false);
  trigger.props.onClick();
  tree=h.render('ExecutionPolicyMenu',props);h.flush();
  const items=all(tree).filter(n=>n.props.role==='menuitemradio');
  assert.equal(items.length,3);assert.deepEqual(items.map(n=>n.props['aria-checked']),[false,true,false]);
  assert.match(text(tree),/独立审查工具操作/);assert.match(text(tree),/工具操作不再请求批准/);
  items[2].props.onClick();assert.deepEqual(changes,['fullAccess']);
  tree=h.render('ExecutionPolicyMenu',props);assert.equal(all(tree).find(n=>n.props['aria-label']==='工具审核边界').props['aria-expanded'],false);
  tree=h.render('ExecutionPolicyMenu',{...props,disabled:true});
  assert.equal(all(tree).find(n=>n.props['aria-label']==='工具审核边界').props.disabled,true);
});

test('Changing permission mode stays pinned to the current chat and uses the server revision',async()=>{
  const calls=[];const h=harness({
    executionRequests:async()=>[],executionPolicy:async()=>({mode:'confirm',revision:7}),
    setExecutionPolicy:async(...args)=>{calls.push(args);return {mode:args[2].mode,revision:8};},
  });
  const props={scope,policyTarget:{}};
  h.render('AgentExecution',props);h.flush();await new Promise(setImmediate);
  let tree=h.render('AgentExecution',props);h.flush();
  all(tree).find(n=>n.type===h.module.ExecutionPolicyMenu).props.select('auto');
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['model','chat',{mode:'auto',revision:7}]);
  tree=h.render('AgentExecution',props);
  assert.equal(all(tree).find(n=>n.type===h.module.ExecutionPolicyMenu).props.policy.mode,'auto');
});

test('Failed policy save does not display full access as enabled',async()=>{
  const h=harness({executionRequests:async()=>[],executionPolicy:async()=>({mode:'confirm',revision:1}),setExecutionPolicy:async()=>{throw new Error('策略版本冲突');}});
  const props={scope,policyTarget:{}};
  h.render('AgentExecution',props);h.flush();await new Promise(setImmediate);
  let tree=h.render('AgentExecution',props);
  all(tree).find(n=>n.type===h.module.ExecutionPolicyMenu).props.select('fullAccess');
  await new Promise(setImmediate);
  tree=h.render('AgentExecution',props);
  const menu=all(tree).find(n=>n.type===h.module.ExecutionPolicyMenu);
  assert.equal(menu.props.policy.mode,'confirm');assert.match(menu.props.error,/策略版本冲突/);
});

test('Auto review keeps composer available until the reviewer requests human confirmation',async()=>{
  let current={...receipt,review:null};
  const changes=[];const h=harness({executionRequests:async()=>[current],executionPolicy:async()=>({mode:'auto',revision:2})});
  const statuses=[];
  const props={scope,approvalTarget:{},onPendingChange:value=>changes.push(value),onApprovalChange:(id,pending)=>statuses.push([id,pending])};
  h.render('AgentExecution',props);h.flush();await new Promise(setImmediate);
  let tree=h.render('AgentExecution',props);h.flush();
  assert.equal(changes.at(-1),false);assert.match(text(tree),/正在独立审查/);
  assert.deepEqual(statuses.at(-1),['chat',false]);
  assert.ok(!all(tree).some(n=>n.props.className==='composer-approval'));
  current={...receipt,review:{mode:'auto',decision:'ask',risk:'high',reason:'删除需要确认'}};
  h.timers.shift()();await new Promise(setImmediate);
  tree=h.render('AgentExecution',props);h.flush();
  assert.equal(changes.at(-1),true);assert.ok(all(tree).some(n=>n.props.className==='composer-approval'));
  assert.deepEqual(statuses.at(-1),['chat',true]);
  current={...current,state:'denied'};h.timers.shift()();await new Promise(setImmediate);
  h.render('AgentExecution',props);h.flush();assert.deepEqual(statuses.at(-1),['chat',false]);
});


test('E3 MCP confirmation occupies the composer and routes an exact one-call decision to its session',async()=>{
  const item={id:'mcp-approval',sessionId:'chat',callId:'mcp-call',toolName:'call_mcp_tool',arguments:{argumentsJson:{query:'hello'}},destination:'MCP demo / lookup',task:{goal:'inspect'},state:'pending',expiresAt:Date.now()+300000};
  const actions=[],changes=[];const h=harness({executionRequests:async()=>[],executionPolicy:async()=>({mode:'confirm',revision:0})},{requests:async()=>[item],decide:async(...args)=>{actions.push(args);return true;}});
  const props={scope,approvalTarget:{},onPendingChange:value=>changes.push(value)};
  h.render('AgentExecution',props);h.flush();await new Promise(setImmediate);
  let tree=h.render('AgentExecution',props);h.flush();assert.equal(changes.at(-1),true);
  const card=all(tree).find(n=>n.type?.name==='ExtensionApprovalCard');assert.ok(card);
  const contents=card.type(card.props);assert.match(text(contents),/MCP demo \/ lookup/);assert.match(text(contents),/hello/);
  card.props.act('mcp-approval',true);await new Promise(setImmediate);assert.deepEqual(actions[0],['model','chat','mcp-approval',true]);
  tree=h.render('AgentExecution',{...props,scope:{...scope,sessionId:'other'}});assert.ok(!all(tree).some(n=>n.type?.name==='ExtensionApprovalCard'));
});
