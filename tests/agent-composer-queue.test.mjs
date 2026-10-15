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

const project={id:'existing-project',name:'测试服务器',connectionId:'saved-ssh',identity:{host:'example.test',port:22,username:'tester',hostKey:'test-key'}};

test('Empty new chat offers text or existing SSH projects and preserves the draft across connection and history scopes',async()=>{
 const p=panel(),selections=[];
 p.props.composerProject={project:null,projects:[project],locked:false,select:async id=>{
  selections.push(id);p.props.draftScope=2;p.render();p.render();
  await new Promise(setImmediate);
  p.props.draftScope=3;p.props.composerProject.project=project;p.render();p.render();
 }};
 p.type('安装前先检查环境');p.render();
 const picker=p.find(n=>n.props.label==='新对话连接');
 assert.equal(picker.props.value,'');assert.equal(picker.props.options.length,2);
 assert.equal(picker.props.options[0].label,'文字对话');
 assert.equal(picker.props.options[1].value,project.id);
 picker.props.onChange(project.id);p.render();
 assert.equal(p.find(n=>n.type==='textarea').props.disabled,true);
 await new Promise(setImmediate);await new Promise(setImmediate);p.render();p.render();
 assert.deepEqual(selections,[project.id]);
 assert.equal(p.find(n=>n.type==='textarea').props.value,'安装前先检查环境');
 assert.equal(p.find(n=>n.props.label==='新对话连接').props.value,project.id);
 assert.equal(p.find(n=>n.type==='textarea').props.disabled,false);
 // An ordinary history navigation must still clear the old conversation draft.
 p.props.draftScope=4;p.render();p.render();assert.equal(p.find(n=>n.type==='textarea').props.value,'');
});

test('Project choice can return to text, rejects unknown IDs, and cannot redirect a running or existing conversation',async()=>{
 const p=panel(),selections=[];
 p.props.composerProject={project,projects:[project],locked:false,select:async id=>{selections.push(id);}};
 p.render();p.find(n=>n.props.label==='新对话连接').props.onChange('unknown');assert.deepEqual(selections,[]);
 p.find(n=>n.props.label==='新对话连接').props.onChange('');await new Promise(setImmediate);p.render();p.render();
 assert.deepEqual(selections,['']);
 p.props.busy=true;p.render();const picker=p.find(n=>n.props.label==='新对话连接');assert.equal(picker.props.disabled,true);
 picker.props.onChange('');await new Promise(setImmediate);assert.deepEqual(selections,['']);
 p.props.busy=false;p.props.messages=[{id:'sent',role:'user',text:'已有对话'}];p.render();
 assert.equal(p.find(n=>n.props.label==='新对话连接'),undefined);
 assert.equal(p.find(n=>n.props.className==='composer-project-label').props.children,project.name);
});

test('Failed project selection keeps text and unlocks the selector for retry',async()=>{
 const p=panel();let fail=true,calls=0;
 p.props.composerProject={project:null,projects:[project],locked:false,select:async()=>{calls++;if(fail)throw Error('连接失败');}};
 p.type('保留此草稿');p.render();p.find(n=>n.props.label==='新对话连接').props.onChange(project.id);
 await new Promise(setImmediate);p.render();p.render();
 assert.equal(p.find(n=>n.type==='textarea').props.value,'保留此草稿');
 assert.equal(p.find(n=>n.props.label==='新对话连接').props.disabled,false);
 assert.equal(p.find(n=>n.props.className==='composer-attachment-error').props.children,'连接失败');
 fail=false;p.find(n=>n.props.label==='新对话连接').props.onChange(project.id);await new Promise(setImmediate);p.render();p.render();
 assert.equal(calls,2);assert.equal(p.find(n=>n.props.className==='composer-attachment-error'),undefined);
});
