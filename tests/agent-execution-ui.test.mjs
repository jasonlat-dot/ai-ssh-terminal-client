import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source=readFileSync(new URL('../src/components/AgentExecution.tsx',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness(api={}){
  const slots=[],effects=[],timers=[];let cursor=0;const contexts=new Map();
  const hooks={createContext:value=>({value}),useContext:context=>context.value,
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useRef(initial){const index=cursor++;return slots[index]??(slots[index]={current:initial});},
    useEffect(effect,deps){const index=cursor++;if(!slots[index]||deps.some((value,i)=>value!==slots[index][i])){slots[index]=deps;effects.push(effect);}}};
  const context=vm.createContext({exports:{},Date,Error,JSON,Map,Array,Number,TextDecoder,Uint8Array,AbortController,document:{addEventListener(){},removeEventListener(){},activeElement:null},
    setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout(){},
    require(name){if(name==='react')return hooks;if(name==='react-dom')return {createPortal:children=>children};if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='../api/agent')return {agentApi:api};if(name==='./Ui')return {Icon:()=>null};if(name==='./CopyTextButton')return {CopyTextButton:()=>null};if(name.endsWith('.css'))return {};throw new Error(name);}});
  vm.runInContext(output,context);
  return {module:context.exports,timers,render(name,props){cursor=0;return context.exports[name](props);},flush(){while(effects.length)effects.shift()();}};
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
test('D5 raw byte viewer preserves cross-range non UTF-8 data through hex and marks lossy text',()=>{
  const h=harness();const decoded=h.module.decodeOutput({bytes:[0xe6,0xb1,0x89,0xff],offset:0,nextOffset:4,eof:true,size:4,channel:'stdout'});
  assert.equal(decoded.lossy,true);assert.equal(decoded.hex,'e6 b1 89 ff');assert.match(decoded.text,/汉/);
  assert.equal(h.module.outputReferences({outputs:[{id:'a',channel:'stdout',size:4,sha256:'hash'},{id:'bad',channel:'stdin',size:4}]}).length,1);
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
test('D5 unknown tool output with retained original references remains readable without claiming execution succeeded',()=>{
  const h=harness();const tree=h.render('NativeToolOutput',{output:JSON.stringify({ok:false,error:'result_unknown',data:{outputs:[{id:'raw',channel:'stderr',size:100,sha256:'hash'}]}})});
  assert.match(text(tree),/工具未完成/);assert.match(text(tree),/result_unknown/);
  assert.ok(all(tree).some(n=>n.props.reference?.id==='raw'));
});
test('Pending approval is portaled into the composer without duplicating its history card',async()=>{
  const changes=[];const h=harness({executionRequests:async()=>[receipt],executionPolicy:async()=>({mode:'confirm',revision:0})});
  const props={scope,approvalTarget:{},onPendingChange:value=>changes.push(value)};h.render('AgentExecution',props);h.flush();await new Promise(setImmediate);
  const tree=h.render('AgentExecution',props);h.flush();assert.equal(changes.at(-1),true);
  const cards=all(tree).filter(n=>n.type===h.module.ApprovalCard);assert.equal(cards.length,1);
  assert.ok(all(tree).some(n=>n.props.className==='composer-approval'));
});
test('Execution output is combined, raw byte viewers stay collapsed and empty channels stay hidden',()=>{
  const h=harness();const tree=h.render('NativeToolOutput',{output:JSON.stringify({ok:true,data:{exitCode:0,stdout:'Docker version',stderr:'',outputs:[{id:'out',channel:'stdout',size:14,sha256:'hash'},{id:'empty',channel:'stderr',size:0,sha256:'hash'}]}})});
  assert.match(text(tree),/Docker version/);assert.doesNotMatch(text(tree),/stdout|stderr/);
  const details=all(tree).find(n=>n.props.className==='execution-output-details');assert.ok(details);assert.ok(!details.props.open);
  assert.equal(all(tree).filter(n=>n.props.reference).length,1);
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
  assert.match(text(tree),/独立审查工具操作/);assert.match(text(tree),/当前任务的工具操作不再请求批准/);
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
