import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const output=ts.transpileModule(readFileSync(new URL('../src/components/AgentPanel.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function all(node){if(Array.isArray(node))return node.flatMap(all);return node?.props?[node,...all(node.props.children)]:[];}
const leaf=()=>null;
function panel(){
  const slots=[],effects=[];let cursor=0;const requests=[],steers=[];let finish;
  const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial});},useEffect(effect,deps){const i=cursor++;if(!slots[i]||deps.some((value,j)=>value!==slots[i][j])){slots[i]=deps;effects.push(effect);}},useLayoutEffect(effect,deps){hooks.useEffect(effect,deps);},useImperativeHandle(){},useSyncExternalStore(_subscribe,get){return get();}};
  const context=vm.createContext({exports:{},crypto,Date,Error,Set,Map,Promise,window:{addEventListener(){},removeEventListener(){}},requestAnimationFrame:fn=>fn(),require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='./Ui')return{Icon:leaf,Badge:leaf,AccentIcon:leaf};
    if(name==='./AgentExecution')return{AgentExecution:leaf,ExecutionContext:{Provider:leaf}};
    if(name==='../state/chatAttachments')return{validateChatContent:text=>text.trim()?'':'请输入消息',chatAttachmentPolicy:{extensions:[]}};
    return new Proxy({},{get:()=>leaf});
  }});
  vm.runInContext(output,context);
  const props={chatDraft:{subscribe:()=>()=>{},getSnapshot:()=>[],ready:()=>[],clear(){},attach(){}},draftScope:1,messages:[],busy:false,stopping:false,disabled:false,collapsed:false,localTerminal:false,connected:false,history:{external:true,sessions:[],toggle(){}},models:[{agentId:'model',agentName:'test'}],agentAvailability:{ready:true},clear(){},stop(){assert.fail('queue must never stop the current turn');},send:async(text)=>{requests.push(text);return await new Promise(resolve=>{finish=resolve;});},steer:async(...args)=>{steers.push(args);}};
  let tree;
  const render=()=>{cursor=0;tree=context.exports.AgentPanel(props);let limit=0;while(effects.length){if(++limit>100)throw Error('effect loop');effects.shift()();}return tree;};
  const find=predicate=>all(tree).find(predicate);
  const type=text=>find(n=>n.type==='textarea').props.onChange({target:{value:text}});
  const submit=()=>find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
  render();render();
  return{props,requests,steers,render,find,type,submit,finish:success=>finish(success)};
}
test('Sending clears immediately, keeps editing enabled, and a busy follow-up enters the queue',async()=>{
  const p=panel();p.type('first');p.render();p.submit();p.render();p.render();
  assert.deepEqual(p.requests,['first']);assert.equal(p.find(n=>n.type==='textarea').props.value,'');
  p.props.busy=true;p.props.messages=[{id:'turn-1',role:'assistant',text:''}];p.render();
  assert.equal(p.find(n=>n.type==='textarea').props.disabled,false);
  p.type('next');p.render();p.submit();p.render();
  assert.equal(p.find(n=>n.type==='textarea').props.value,'');assert.deepEqual(p.requests,['first']);
  assert.ok(p.find(n=>n.props['aria-label']==='删除排队消息'));
  p.props.busy=false;p.finish(true);await new Promise(setImmediate);p.render();p.render();
  assert.deepEqual(p.requests,['first','next']);p.finish(true);await new Promise(setImmediate);
});
test('Steering submits one pinned input without stopping, and removes it only after its committed receipt',async()=>{
  const p=panel();p.props.busy=true;p.props.messages=[{id:'running-turn',role:'assistant',text:'working'}];p.render();
  p.type('只讨论');p.render();p.submit();p.render();
  p.find(n=>n.props['aria-label']==='立即提交').props.onClick();await new Promise(setImmediate);p.render();
  assert.equal(p.steers.length,1);assert.equal(p.steers[0][1],'只讨论');assert.equal(p.steers[0][2],'running-turn');assert.deepEqual(p.requests,[]);
  assert.ok(p.find(n=>n.props.className==='composer-queue-item is-submitted'));
  p.props.messages=[{id:p.steers[0][0],role:'user',text:'只讨论'},{id:'running-turn',role:'assistant',text:'working'}];p.render();p.render();
  assert.ok(!p.find(n=>n.props.className==='composer-queue-item is-submitted'));
});
test('Deleting queued messages and changing scope never send them to a different conversation',()=>{
  const p=panel();p.props.busy=true;p.render();p.type('remove me');p.render();p.submit();p.render();
  p.find(n=>n.props['aria-label']==='删除排队消息').props.onClick();p.render();
  assert.ok(!p.find(n=>n.props.className==='composer-queue-item is-queued'));
  p.type('old conversation');p.render();p.submit();p.render();p.props.draftScope=2;p.props.busy=false;p.render();p.render();
  assert.deepEqual(p.requests,[]);
});
test('A lost steering response stays unconfirmed and cannot be edited or automatically replayed',async()=>{
  const p=panel();p.props.busy=true;p.props.messages=[{id:'turn',role:'assistant',text:''}];p.props.steer=async()=>{throw Error('connection lost');};p.render();p.type('uncertain');p.render();p.submit();p.render();
  p.find(n=>n.props['aria-label']==='立即提交').props.onClick();await new Promise(setImmediate);p.render();
  assert.ok(p.find(n=>n.props.className==='composer-queue-item is-unconfirmed'));
  assert.equal(p.find(n=>n.props['aria-label']==='编辑排队消息').props.disabled,true);
  assert.equal(p.find(n=>n.props['aria-label']==='删除排队消息').props.disabled,true);
  p.props.busy=false;p.render();assert.deepEqual(p.requests,[]);
});
