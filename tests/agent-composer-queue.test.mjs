import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {loadToastErrorHooks} from './helpers/toast-errors.mjs';

const output=ts.transpileModule(readFileSync(new URL('../src/components/AgentPanel.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function all(node){if(Array.isArray(node))return node.flatMap(all);return node?.props?[node,...all(node.props.children)]:[];}
const leaf=()=>null;
function panel(picker=async()=>{},paste=async()=>null){
  const slots=[],effects=[],notices=[],timers=new Map(),listeners=new Map();let clock=0,timerId=0;let cursor=0;const requests=[],steers=[];let finish;
  const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial});},useEffect(effect,deps){const i=cursor++;if(!slots[i]||deps.some((value,j)=>value!==slots[i][j])){slots[i]=deps;effects.push(effect);}},useLayoutEffect(effect,deps){hooks.useEffect(effect,deps);},useImperativeHandle(){},useSyncExternalStore(_subscribe,get){return get();}};
  const context=vm.createContext({exports:{},crypto,Date,Error,Set,Map,Promise,document:{body:{},activeElement:null},window:{addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,at:clock+ms});return id;},clearTimeout(id){timers.delete(id);}},requestAnimationFrame:fn=>fn(),require(name){
    if(name==='../api/files')return{pickNativeAttachments:picker,pasteNativeAttachments:paste};
    if(name==='react-dom')return{createPortal:node=>node};
    if(name==='react')return hooks;
    if(name==='../state/useToastError')return loadToastErrorHooks(hooks,message=>notices.push(message));
    if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='./Ui')return{Icon:leaf,Badge:leaf,AccentIcon:leaf};
    if(name==='./AgentExecution')return{AgentExecution:leaf,ExecutionContext:{Provider:leaf}};
    if(name==='../state/chatAttachments')return{validateChatContent:text=>text.trim()?'':'请输入消息',chatAttachmentPolicy:{extensions:[]},insertPastedText:(draft,text,start,end)=>({text:draft.slice(0,start)+text+draft.slice(end),cursor:start+text.length})};
    return new Proxy({},{get:()=>leaf});
  }});
  vm.runInContext(output,context);
  const props={chatDraft:{subscribe:()=>()=>{},getSnapshot:()=>[],ready:()=>[],clear(){},attach(){}},draftScope:1,messages:[],busy:false,stopping:false,disabled:false,collapsed:false,localTerminal:false,connected:false,history:{external:true,sessions:[],toggle(){}},models:[{agentId:'model',agentName:'test'}],agentAvailability:{ready:true},clear(){},stop(){assert.fail('queue must never stop the current turn');},send:async(text)=>{requests.push(text);return await new Promise(resolve=>{finish=resolve;});},steer:async(...args)=>{steers.push(args);}};
  let tree,scroller;
  const render=()=>{cursor=0;tree=context.exports.AgentPanel(props);for(const node of all(tree)){if(scroller&&node.props['aria-label']==='聊天记录'&&node.props.ref)node.props.ref.current=scroller;if(node.props.role==='tooltip'&&node.props.ref)node.props.ref.current={getBoundingClientRect:()=>({width:120,height:30})};}let limit=0;while(effects.length){if(++limit>100)throw Error('effect loop');effects.shift()();}return tree;};
  const find=predicate=>all(tree).find(predicate);
  const type=text=>find(n=>n.type==='textarea').props.onChange({target:{value:text}});
  const submit=()=>find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
  render();render();
  return{props,requests,steers,notices,render,find,type,submit,get scroller(){return scroller;},scroll(top,total=1600,visible=400){scroller={scrollTop:top,scrollHeight:total,clientHeight:visible};const list=find(n=>n.props['aria-label']==='聊天记录');list.props.ref.current=scroller;list.props.onScroll();render();},finish:success=>finish(success),advance(ms){clock+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock){timers.delete(id);timer.fn();}},dispatch(name,event){for(const fn of listeners.get(name)??[])fn(event);}};
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
 const picker=p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function');
 assert.equal(picker.props.project,null);assert.equal(picker.props.projects.length,1);
 assert.equal(picker.props.projects[0].id,project.id);
 picker.props.onChange(project.id);p.render();
 assert.equal(p.find(n=>n.type==='textarea').props.disabled,true);
 await new Promise(setImmediate);await new Promise(setImmediate);p.render();p.render();
 assert.deepEqual(selections,[project.id]);
 assert.equal(p.find(n=>n.type==='textarea').props.value,'安装前先检查环境');
 assert.equal(p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function').props.project.id,project.id);
 assert.equal(p.find(n=>n.type==='textarea').props.disabled,false);
 // An ordinary history navigation must still clear the old conversation draft.
 p.props.draftScope=4;p.render();p.render();assert.equal(p.find(n=>n.type==='textarea').props.value,'');
});

test('Project choice can return to text, rejects unknown IDs, and cannot redirect a running or existing conversation',async()=>{
 const p=panel(),selections=[];
 p.props.composerProject={project,projects:[project],locked:false,select:async id=>{selections.push(id);}};
 p.render();p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function').props.onChange('unknown');assert.deepEqual(selections,[]);
 p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function').props.onChange('');await new Promise(setImmediate);p.render();p.render();
 assert.deepEqual(selections,['']);
 p.props.busy=true;p.render();const picker=p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function');assert.equal(picker.props.disabled,true);
 picker.props.onChange('');await new Promise(setImmediate);assert.deepEqual(selections,['']);
 p.props.busy=false;p.props.messages=[{id:'sent',role:'user',text:'已有对话'}];p.render();
 assert.equal(p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function'),undefined);
 assert.equal(p.find(n=>n.props.className==='composer-project-label').props.children,project.name);
});

test('Failed project selection keeps text and unlocks the selector for retry',async()=>{
 const p=panel();let fail=true,calls=0;
 p.props.composerProject={project:null,projects:[project],locked:false,select:async()=>{calls++;if(fail)throw Error('连接失败');}};
 p.type('保留此草稿');p.render();p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function').props.onChange(project.id);
 await new Promise(setImmediate);p.render();p.render();
 assert.equal(p.find(n=>n.type==='textarea').props.value,'保留此草稿');
 assert.equal(p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function').props.disabled,false);
 assert.equal(p.notices.at(-1),'连接失败');
 fail=false;p.find(n=>Array.isArray(n.props.projects)&&typeof n.props.onChange==='function').props.onChange(project.id);await new Promise(setImmediate);p.render();p.render();
 assert.equal(calls,2);assert.equal(p.find(n=>n.props.className==='composer-attachment-error'),undefined);
});

test('Native attachment picker is enabled for Rust models and pins callbacks to the originating draft',async()=>{
 let deliver;const p=panel(async callback=>{deliver=callback;});const attached=[];p.props.chatDraft.attach=files=>attached.push(...files);p.render();
 let button=p.find(n=>n.props['aria-label']==='添加附件');assert.equal(button.props.disabled,false);button.props.onClick();p.render();assert.equal(p.find(n=>n.props['aria-label']==='添加附件').props.disabled,true);
 deliver({fileId:'file-one',fileName:'manual.pdf',size:10,contentType:'application/pdf'});await new Promise(setImmediate);p.render();assert.equal(attached.length,1);
 p.find(n=>n.props['aria-label']==='添加附件').props.onClick();p.props.draftScope=2;p.render();deliver({fileId:'stale',fileName:'private.txt',size:4,contentType:'text/plain'});await new Promise(setImmediate);assert.equal(attached.length,1);
});

test('Native paste imports file references with previews and waits before sending',async()=>{
 let deliver,finish;const p=panel(undefined,callback=>{deliver=callback;return new Promise(resolve=>{finish=resolve;});});const attached=[];
 p.props.chatDraft.attach=files=>attached.push(...files);p.type('看图片');p.render();let prevented=0;
 p.find(n=>n.type==='textarea').props.onKeyDown({key:'v',ctrlKey:true,nativeEvent:{isComposing:false},currentTarget:{value:'看图片',selectionStart:3,selectionEnd:3},preventDefault(){prevented++;}});p.submit();p.render();
 assert.equal(prevented,1);assert.equal(p.find(n=>n.props['aria-label']==='发送消息').props.disabled,true);
 p.submit();assert.equal(p.requests.length,0);
 deliver({fileId:'clipboard-image',fileName:'截图.png',contentType:'image/png',size:20,previewUrl:'data:image/jpeg;base64,preview'});
 finish(null);await new Promise(setImmediate);p.render();assert.equal(attached.length,1);assert.equal(attached[0].previewUrl,'data:image/jpeg;base64,preview');
 assert.equal(p.find(n=>n.type==='textarea').props.value,'看图片');
});
test('Native text paste replaces the selection while stale paste results never enter another conversation',async()=>{
 let finish,deliver;const p=panel(undefined,callback=>{deliver=callback;return new Promise(resolve=>{finish=resolve;});});const attached=[];p.props.chatDraft.attach=files=>attached.push(...files);
 p.type('hello world');p.render();const event={currentTarget:{value:'hello world',selectionStart:6,selectionEnd:11},preventDefault(){}};
 p.find(n=>n.type==='textarea').props.onPaste(event);finish('图片');await new Promise(setImmediate);p.render();assert.equal(p.find(n=>n.type==='textarea').props.value,'hello 图片');
 p.find(n=>n.type==='textarea').props.onPaste(event);p.props.draftScope=2;p.render();p.render();deliver({fileId:'old-image',fileName:'old.png',size:1});finish('old text');await new Promise(setImmediate);p.render();
 assert.equal(attached.length,0);assert.equal(p.find(n=>n.type==='textarea').props.value,'');
});
test('Sent attachments are siblings above the separate user text bubble',()=>{
 const p=panel();p.props.messages=[{id:'user',role:'user',text:'似乎报错了',attachments:[{fileId:'image',fileName:'shot.png',contentType:'image/png',size:1}]}];p.render();
 const group=p.find(n=>n.props.className==='user-message-group');const children=group.props.children.filter(Boolean);
 assert.equal(children[0].props.files[0].fileId,'image');assert.equal(children[1].props.className,'user-message');assert.equal(children[1].props.children[0].props.children,'似乎报错了');
});

test('Creating a project from the composer preserves the draft through creation and later scope changes',async()=>{
 const p=panel();let done,created=0;
 p.props.composerProject={project:null,projects:[],locked:false,select:async()=>{},create:()=>{created++;return new Promise(resolve=>{done=resolve;});}};
 p.type('先保留这个问题');p.render();p.find(n=>Array.isArray(n.props.projects)).props.onCreate();p.render();assert.equal(created,1);assert.equal(p.find(n=>n.type==='textarea').props.disabled,true);
 p.props.draftScope=2;p.render();p.render();p.props.draftScope=3;p.render();p.render();done();await new Promise(setImmediate);p.render();p.render();
 assert.equal(p.find(n=>n.type==='textarea').props.value,'先保留这个问题');assert.equal(p.find(n=>n.type==='textarea').props.disabled,false);
});

test('Native preparation stays on per-file cards instead of a waiting banner and ignores stale progress',async()=>{
 let progress,finish;const p=panel(undefined,(_uploaded,_limit,_bytes,onProgress)=>{progress=onProgress;return new Promise(resolve=>{finish=resolve;});});
 p.find(n=>n.type==='textarea').props.onPaste({currentTarget:{value:'',selectionStart:0,selectionEnd:0},preventDefault(){}});p.render();
 assert.equal(p.find(n=>n.props.className==='composer-attachment-error'),undefined);
 progress({id:'pdf',fileName:'manual.pdf',size:100});progress({id:'image',fileName:'shot.png',size:200});p.render();
 let cards=p.find(n=>Array.isArray(n.props.pending));assert.equal(cards.props.pending.length,2);assert.equal(cards.props.pending[0].fileName,'manual.pdf');
 progress({id:'pdf',fileName:'manual.pdf',size:100,finished:true});p.render();cards=p.find(n=>Array.isArray(n.props.pending));assert.equal(cards.props.pending.length,1);assert.equal(cards.props.pending[0].id,'image');
 p.props.draftScope=2;p.render();p.render();progress({id:'late',fileName:'old.pdf',size:1});p.render();assert.equal(p.find(n=>Array.isArray(n.props.pending)),undefined);
 finish(null);await new Promise(setImmediate);
});

test('Action hints wait 400 ms and quick pointer departure cancels the pending tooltip',()=>{
 const p=panel();const anchor={isConnected:true,matches:()=>false,getBoundingClientRect:()=>({left:100,top:100,bottom:128,width:28})};
 let button=p.find(n=>n.props['aria-label']==='添加附件');button.props.onMouseEnter({currentTarget:anchor});p.advance(399);p.render();assert.equal(p.find(n=>n.props.role==='tooltip'),undefined);
 button.props.onMouseLeave({currentTarget:anchor});p.advance(1);p.render();assert.equal(p.find(n=>n.props.role==='tooltip'),undefined);
 button=p.find(n=>n.props['aria-label']==='添加附件');button.props.onMouseEnter({currentTarget:anchor});p.advance(400);p.render();assert.equal(p.find(n=>n.props.role==='tooltip').props.children,'添加文件等内容');
});
test('Escape and scope changes cancel pending hints; keyboard focus shows its hint immediately',()=>{
 const p=panel();const anchor={isConnected:true,matches:()=>false,getBoundingClientRect:()=>({left:100,top:100,bottom:128,width:28})};
 let button=p.find(n=>n.props['aria-label']==='添加附件');button.props.onMouseEnter({currentTarget:anchor});p.dispatch('keydown',{key:'Escape'});p.advance(400);p.render();assert.equal(p.find(n=>n.props.role==='tooltip'),undefined);
 button=p.find(n=>n.props['aria-label']==='添加附件');button.props.onMouseEnter({currentTarget:anchor});p.props.draftScope=2;p.render();p.advance(400);p.render();assert.equal(p.find(n=>n.props.role==='tooltip'),undefined);
 button=p.find(n=>n.props['aria-label']==='添加附件');button.props.onFocus({currentTarget:anchor});p.render();assert.equal(p.find(n=>n.props.role==='tooltip').props.children,'添加文件等内容');button.props.onBlur();p.render();assert.equal(p.find(n=>n.props.role==='tooltip'),undefined);
});


test('A failed turn already placed in the conversation never returns to the composer queue',async()=>{
 const p=panel();let finish;
 p.props.send=async(text,_files,placed)=>{p.requests.push(text);placed();return await new Promise(resolve=>{finish=resolve;});};
 p.type('inspect cpu');p.render();p.submit();p.render();p.render();
 p.props.messages=[{id:'request:user',role:'user',text:'inspect cpu'},{id:'request',role:'assistant',text:'partial',error:true,errorCode:'MODEL_HTTP_ERROR',errorMessage:'HTTP 400'}];
 finish(false);await new Promise(setImmediate);p.render();p.render();
 assert.equal(p.requests.length,1);
 assert.equal(p.find(n=>n.props['aria-label']==='待发送消息'),undefined);
 assert.ok(p.find(n=>n.props.message?.error&&typeof n.props.restore==='function'));
 assert.equal(p.find(n=>n.type==='textarea').props.value,'');
});

test('A request rejected before placement retains its draft and pauses the remaining queue',async()=>{
 const p=panel();p.props.send=async()=>false;
 p.type('not yet accepted');p.render();p.submit();p.render();await new Promise(setImmediate);p.render();
 assert.ok(p.find(n=>n.props.className==='composer-queue-item is-failed'));
 p.find(n=>n.props['aria-label']==='编辑排队消息').props.onClick();p.render();
 assert.equal(p.find(n=>n.type==='textarea').props.value,'not yet accepted');
});


test('生成中翻看历史时显示浮动加载按钮，点击回到底部并恢复后续流式跟随',()=>{
 const p=panel();p.props.busy=true;p.props.messages=[{id:'reply',role:'assistant',text:'partial'}];p.render();p.render();
 assert.equal(p.find(n=>n.props['aria-label']==='回到最新回复'),undefined);
 p.scroll(200);p.render();
 const button=p.find(n=>n.props['aria-label']==='回到最新回复');assert.ok(button);assert.match(button.props.className,/is-generating/);
 p.props.messages=[{id:'reply',role:'assistant',text:'more output'}];p.render();assert.equal(p.scroller.scrollTop,200);
 button.props.onClick();p.render();assert.equal(p.scroller.scrollTop,p.scroller.scrollHeight);assert.equal(p.find(n=>n.props['aria-label']==='回到最新回复'),undefined);
 p.scroller.scrollHeight=1800;p.props.messages=[{id:'reply',role:'assistant',text:'continued'}];p.render();assert.equal(p.scroller.scrollTop,1800);
});

test('回复结束后保留向下箭头，手动接近底部后隐藏；切换会话不遗留旧状态',()=>{
 const p=panel();p.props.busy=true;p.props.messages=[{id:'reply',role:'assistant',text:'partial'}];p.render();p.scroll(100);p.render();
 p.props.busy=false;p.render();assert.doesNotMatch(p.find(n=>n.props['aria-label']==='回到最新回复').props.className,/is-generating/);
 p.scroll(1160);p.render();assert.equal(p.find(n=>n.props['aria-label']==='回到最新回复'),undefined);
 p.scroll(100);p.render();assert.ok(p.find(n=>n.props['aria-label']==='回到最新回复'));
 p.props.history={...p.props.history,activeSessionId:'other-chat'};p.props.messages=[];p.render();p.render();assert.equal(p.find(n=>n.props['aria-label']==='回到最新回复'),undefined);
});

test('收起面板不展示回到底部按钮，恢复中的请求保留加载状态',()=>{
 const p=panel();p.props.messages=[{id:'reply',role:'assistant',text:'partial'}];p.props.recoveredRunning=true;p.render();p.scroll(100);p.render();
 assert.match(p.find(n=>n.props['aria-label']==='回到最新回复').props.className,/is-generating/);
 p.props.collapsed=true;p.render();assert.equal(p.find(n=>n.props['aria-label']==='回到最新回复'),undefined);
});

test('Busy conversations can select the next model and edit its reasoning without redirecting attachment reads',()=>{
 const p=panel();p.props.busy=true;p.props.history.activeSessionId='chat-A';p.props.selectedModel='next-model';
 p.props.execution={agentId:'running-model',sessionId:'chat-A'};p.props.reasoning={revision:1,onSavingChange(){}};
 p.props.messages=[{id:'user',role:'user',text:'question',attachments:[{id:'file',fileName:'a.txt',size:1}]}];
 let cancelled=0;p.props.nextModel={modelId:'next-model',saving:false,cancel:()=>cancelled++,retry(){}};p.render();
 const picker=p.find(n=>n.props.models&&n.props.value==='next-model');assert.equal(picker.props.disabled,false);
 const reasoning=p.find(n=>n.props.modelId==='next-model');assert.equal(reasoning.props.disabled,false);
 const attachment=p.find(n=>n.props.files&&n.props.scope?.sessionId==='chat-A');assert.equal(attachment.props.scope.agentId,'running-model');
 assert.ok(p.find(n=>n.props.className==='composer-next-model'));
 p.find(n=>n.type==='button'&&n.props.children==='取消切换').props.onClick();assert.equal(cancelled,1);
 p.props.nextModel={...p.props.nextModel,error:'模型暂不可用'};p.render();assert.ok(p.find(n=>n.props.className==='composer-next-model has-error'));
 assert.ok(p.find(n=>n.type==='button'&&n.props.children==='重试'));
});
