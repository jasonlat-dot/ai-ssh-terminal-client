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
  const context=vm.createContext({exports:{},Date,Error,JSON,Map,Array,Number,TextDecoder,Uint8Array,AbortController,
    setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout(){},
    require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='../api/agent')return {agentApi:api};if(name==='./Ui')return {Icon:()=>null};if(name.endsWith('.css'))return {};throw new Error(name);}});
  vm.runInContext(output,context);
  return {module:context.exports,timers,render(name,props){cursor=0;return context.exports[name](props);},flush(){while(effects.length)effects.shift()();}};
}
function all(node){if(Array.isArray(node))return node.flatMap(all);return node?.props?[node,...all(node.props.children)]:[];}
function text(node){if(Array.isArray(node))return node.map(text).join(' ');return node?.props?text(node.props.children):typeof node==='string'||typeof node==='number'?String(node):'';}
const receipt={id:'approval',callId:'call',binding:{sessionId:'chat',tool:{taskId:'task',target:{connectionId:'a',terminalSessionId:'terminal-a'}},identity:{host:'server-a',port:22,username:'root',hostKey:'SHA256:example'}},task:{id:'task',goal:'inspect',constraints:['不要重启']},command:{command:'printf "汉🙂"\ncheck',timeoutSeconds:30},state:'pending',createdAt:Date.now(),expiresAt:Date.now()+300000,grant:null,result:null};
const scope={agentId:'model',sessionId:'chat',enabled:true,available:true,connected:true,locked:false,target:receipt.binding.identity,terminalId:'terminal-a',toggle:async()=>{}};

test('D5 approval UI shows exact host/command and distinct once/task/deny/cancel actions',()=>{
  const h=harness();const decisions=[];const tree=h.render('ApprovalCard',{receipt,disabled:false,act:(id,action)=>decisions.push([id,action])});
  assert.match(text(tree).replace(/\s/g,''),/root@server-a:22/);assert.match(text(tree),/printf "汉🙂"\ncheck/);assert.match(text(tree),/不继承终端当前目录/);
  for(const button of all(tree).filter(n=>n.type==='button'))button.props.onClick();
  assert.deepEqual(decisions.map(d=>d[1]),['approveOnce','approveTaskCommand','deny','cancel']);
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
test('D5 pending approval poll opens record panel, routes click to same session and keeps execution toggle locked during a turn',async()=>{
  const requests=[];const actions=[];const h=harness({executionRequests:async(...args)=>{requests.push(args);return [receipt];},executionPolicy:async()=>({mode:'confirm',revision:0}),executionDecision:async(...args)=>{actions.push(args);return true;}});
  h.render('AgentExecution',{scope});h.flush();await new Promise(setImmediate);
  let tree=h.render('AgentExecution',{scope});h.flush();assert.equal(requests[0][0],'model');assert.equal(requests[0][1],'chat');
  const card=all(tree).find(n=>n.type===h.module.ApprovalCard);assert.ok(card);card.props.act('approval','approveOnce');await new Promise(setImmediate);
  assert.deepEqual(actions[0],['model','chat','approval','approveOnce']);
  tree=h.render('AgentExecution',{scope:{...scope,locked:true}});assert.equal(all(tree).find(n=>n.type==='button'&&text(n)==='切换文字对话').props.disabled,true);
});
test('D5 unknown tool output with retained original references remains readable without claiming execution succeeded',()=>{
  const h=harness();const tree=h.render('NativeToolOutput',{output:JSON.stringify({ok:false,error:'result_unknown',data:{outputs:[{id:'raw',channel:'stderr',size:100,sha256:'hash'}]}})});
  assert.match(text(tree),/工具未完成/);assert.match(text(tree),/result_unknown/);
  assert.ok(all(tree).some(n=>n.props.reference?.id==='raw'));
});
