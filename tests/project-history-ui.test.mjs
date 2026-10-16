import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {historyPreviewPosition,historyPreviewTime} from '../src/state/historyPreview.ts';
const p={id:'project-A',name:'A 服务器',connectionId:'A',identity:null};
const q={id:'project-B',name:'B 服务器',connectionId:'B',identity:null};
const a={sessionId:'old-A',agentId:'original-A-model',title:'A 的完整历史',createdAt:1};
const b={sessionId:'old-B',agentId:'B-model',title:'B 的独立历史',createdAt:1};
const g={sessionId:'general',agentId:'general-model',title:'普通解疑',createdAt:1};
function harness(){
 const slots=[],effects=[],timers=new Map(),listeners=new Map();let cursor=0,tree,timerId=0;
 const window={innerWidth:1200,innerHeight:800,
  setTimeout(callback){const id=++timerId;timers.set(id,callback);return id;},clearTimeout(id){timers.delete(id);},
  addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},removeEventListener(name,callback){listeners.get(name)?.delete(callback);},
  getComputedStyle(){return {fontFamily:'Microsoft YaHei UI'};}};
 const actions=[],api={projects:async()=>[p,q],projectChats:async id=>({items:id===p.id?[a]:id===q.id?[b]:[g],nextAfter:null}),
  createProject:async(name,connectionId)=>{actions.push(['create',name,connectionId]);return {...p,id:'created',name,connectionId};}};
 const props={hosts:[{id:'A',name:'服务器 A',address:'a.test',user:'tester'},{id:'B',name:'服务器 B',address:'b.test',user:'tester'}],project:null,sessionId:'',view:'chat',locked:false,revision:'initial',connected:false,
  newChat:project=>actions.push(['new',project]),openChat:(chat,project)=>actions.push(['open',chat,project]),reconnect:()=>actions.push(['reconnect']),
  changeView:view=>actions.push(['view',view]),activeSection:'chat',navigate:section=>actions.push(['navigate',section]),servers:()=>actions.push(['servers'])};
 const hooks={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];},
  useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useId(){return 'history-preview';},
  useEffect(callback,deps){const i=cursor++,old=slots[i];if(!old||!deps.every((v,n)=>Object.is(v,old.deps[n]))){const next={deps,cleanup:null};slots[i]=next;effects.push(()=>{old?.cleanup?.();next.cleanup=callback();});}},
  useLayoutEffect(callback,deps){hooks.useEffect(callback,deps);},
 };
 const compiled=ts.transpileModule(readFileSync(new URL('../src/components/ProjectChatHistory.tsx',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const context=vm.createContext({exports:{},window,document:{body:{}},require:name=>{
  if(name==='react')return hooks;
  if(name==='react-dom')return {createPortal:content=>content};
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='../api/agent')return {agentApi:api};
  if(name==='./Ui')return {Icon:()=>null,Modal:'modal'};
  if(name==='./Select')return {Select:()=>null};
  if(name==='../state/historyPreview')return {historyPreviewPosition,historyPreviewTime};
  throw new Error(name);
 }});
 vm.runInContext(compiled,context);
 function render(){cursor=0;tree=context.exports.ProjectChatHistory(props);
  const card=find(n=>n.props.role==='tooltip');
  if(card)card.props.ref.current={getBoundingClientRect:()=>({width:352,height:124}),contains:node=>!!node?.insidePreview};
  while(effects.length)effects.shift()();}
 function all(predicate,node){if(arguments.length===1)node=tree;
  if(Array.isArray(node))return node.flatMap(child=>all(predicate,child));
  if(!node?.props)return [];
  return [...(predicate(node)?[node]:[]),...all(predicate,node.props.children)];
 }
 function find(predicate){return all(predicate)[0];}
 function button(label){return find(n=>n.type==='button'&&(n.props['aria-label']===label||n.props.children===label));}
 render();
 return {props,actions,api,render,find,all,button,runTimers(){const pending=[...timers.values()];timers.clear();pending.forEach(callback=>callback());},emit(name,event={}){listeners.get(name)?.forEach(callback=>callback(event));},unmount(){slots.forEach(slot=>slot?.cleanup?.());},async settle(){await new Promise(resolve=>setImmediate(resolve));render();}};
}
test('Sidebar groups persisted A/B/general history and clicks retain exact session/model/project',async()=>{
 const ui=harness();await ui.settle();
 const rows=ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row'));
 assert.equal(rows.length,3);
 rows[0].props.onClick();assert.equal(ui.actions[0][0],'open');
 assert.equal(ui.actions[0][1].sessionId,'old-A');assert.equal(ui.actions[0][1].agentId,'original-A-model');assert.equal(ui.actions[0][2].id,'project-A');
 rows[2].props.onClick();assert.equal(ui.actions[1][2],null);
 ui.find(n=>n.type==='button'&&n.props.className==='project-name').props.onClick();
 assert.equal(ui.actions[2][1].sessionId,'old-A');assert.ok(ui.actions.every(a=>a[0]!=='new'));
});
test('Existing history menu keeps general/project new-chat actions distinct and locks history during generation',async()=>{
 const ui=harness();await ui.settle();
 ui.find(n=>n.props.className==='workspace-new-chat').props.onClick();assert.equal(ui.actions[0][1],null);
 ui.button('在 A 服务器 新建对话').props.onClick();assert.equal(ui.actions[1][1].id,'project-A');
 ui.props.project=p;ui.props.sessionId=a.sessionId;ui.props.locked=true;ui.render();
 assert.equal(ui.props.sessionId,'old-A');assert.equal(ui.button('在 A 服务器 新建对话').props.disabled,true);
 assert.ok(ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row')).every(n=>n.props.disabled));
});
test('Creating project chooses only a saved server then starts its own conversation',async()=>{
 const ui=harness();await ui.settle();ui.button('新建项目').props.onClick();ui.render();
 const dialog=ui.find(n=>n.type==='modal');assert.ok(dialog);
 ui.find(n=>n.type==='input').props.onChange({target:{value:'测试项目'}});
 ui.find(n=>n.props.label==='项目服务器').props.onChange('B');ui.render();
 ui.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 await ui.settle();
 assert.equal(ui.actions[0][0],'create');assert.equal(ui.actions[0][1],'测试项目');assert.equal(ui.actions[0][2],'B');
 assert.equal(ui.actions[1][0],'new');assert.equal(ui.actions[1][1].connectionId,'B');
 assert.equal(ui.find(n=>n.type==='modal'),undefined);
});
test('History loading failure is visible and does not create or connect chats',async()=>{
 const ui=harness();ui.api.projects=async()=>{throw new Error('数据库暂不可用');};ui.props.revision='retry';ui.render();await ui.settle();
 assert.ok(ui.find(n=>n.props.role==='alert'));assert.equal(ui.actions.length,0);
});

test('Project previews show five titles, reveal more without refetching, and collapse independently',async()=>{
 const ui=harness();await ui.settle();let fetches=0;
 const items=Array.from({length:12},(_,i)=>({...a,sessionId:'a-'+i,title:'服务器任务 '+i}));
 ui.api.projectChats=async id=>{fetches++;return {items:id===p.id?items:id===q.id?[b]:[g],nextAfter:null};};
 ui.props.revision='many';ui.render();await ui.settle();
 const rows=()=>ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row'),ui.find(n=>n.props.id==='project-chats-project-A'));
 assert.equal(rows().length,5);assert.equal(fetches,3);
 assert.equal(ui.find(n=>n.props.className==='agent-history-item'),undefined);
 for(const row of rows())assert.equal(row.props.children[0].props.className,'project-chat-title');
 ui.button('显示更多A 服务器记录').props.onClick();ui.render();
 assert.equal(rows().length,10);assert.equal(fetches,3);
 ui.button('显示更多A 服务器记录').props.onClick();ui.render();
 assert.equal(rows().length,12);assert.equal(ui.button('显示更多A 服务器记录'),undefined);
 ui.button('收起A 服务器记录').props.onClick();ui.render();assert.equal(rows().length,5);
 ui.button('收起A 服务器').props.onClick();ui.render();
 assert.equal(ui.find(n=>n.props.id==='project-chats-project-A'),undefined);
 assert.ok(ui.find(n=>n.props.id==='project-chats-project-B'));
});

test('Selected older conversation remains visible in a compact preview with exact routing',async()=>{
 const ui=harness();await ui.settle();
 const items=Array.from({length:12},(_,i)=>({...a,sessionId:'a-'+i,title:'任务 '+i}));
 ui.api.projectChats=async id=>({items:id===p.id?items:[],nextAfter:null});
 ui.props.project=p;ui.props.sessionId='a-11';ui.props.revision='older';ui.render();await ui.settle();
 const group=ui.find(n=>n.props.id==='project-chats-project-A');
 assert.equal(ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row'),group).length,5);
 const selected=ui.find(n=>n.props['aria-current']==='page');assert.equal(selected.props['aria-label'],'任务 11');
 selected.props.onClick();assert.equal(ui.actions[0][1].sessionId,'a-11');assert.equal(ui.actions[0][2].id,p.id);
 ui.button('显示更多A 服务器记录').props.onClick();ui.render();
 ui.button('收起A 服务器记录').props.onClick();ui.render();
 assert.equal(ui.find(n=>n.props['aria-current']==='page').props['aria-label'],'任务 11');
});

test('Show more uses the server cursor and deduplicates overlapping pages',async()=>{
 const ui=harness();await ui.settle();const calls=[];
 const items=Array.from({length:5},(_,i)=>({...a,sessionId:'a-'+i,title:'任务 '+i}));
 ui.api.projectChats=async(id,after)=>{
  calls.push([id,after]);
  if(id!==p.id)return {items:[],nextAfter:null};
  return after?{items:[items[4],{...a,sessionId:'a-5'},{...a,sessionId:'a-6'}],nextAfter:null}:{items,nextAfter:'cursor-a'};
 };
 ui.props.revision='paged';ui.render();await ui.settle();
 ui.button('显示更多A 服务器记录').props.onClick();await ui.settle();
 assert.deepEqual(calls.at(-1),[p.id,'cursor-a']);
 const group=ui.find(n=>n.props.id==='project-chats-project-A');
 assert.equal(ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row'),group).length,7);
 assert.equal(ui.button('显示更多A 服务器记录'),undefined);
});

test('Pagination failure keeps visible records and permits an explicit retry',async()=>{
 const ui=harness();await ui.settle();let fail=true;
 const items=Array.from({length:5},(_,i)=>({...a,sessionId:'a-'+i}));
 ui.api.projectChats=async(id,after)=>{
  if(id!==p.id)return {items:[],nextAfter:null};
  if(after&&fail)throw new Error('历史分页暂不可用');
  return after?{items:[{...a,sessionId:'older'}],nextAfter:null}:{items,nextAfter:'next'};
 };
 ui.props.revision='failure';ui.render();await ui.settle();
 ui.button('显示更多A 服务器记录').props.onClick();await ui.settle();
 assert.ok(ui.find(n=>n.props.role==='alert'));assert.equal(ui.actions.length,0);
 assert.equal(ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row')).length,5);
 fail=false;ui.button('显示更多A 服务器记录').props.onClick();await ui.settle();
 assert.equal(ui.find(n=>n.props.role==='alert'),undefined);
 assert.equal(ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row')).length,6);
});

test('Composer project choices receive only projects returned by the successful history refresh',async()=>{
 const ui=harness(),lists=[];await ui.settle();ui.props.projectsChanged=projects=>lists.push(projects);
 ui.props.revision='share-projects';ui.render();await ui.settle();
 assert.equal(lists.length,1);assert.deepEqual(lists[0],[p,q]);
 ui.api.projects=async()=>{throw new Error('offline');};ui.props.revision='failed-refresh';ui.render();await ui.settle();
 assert.equal(lists.length,1);
});

test('Deleting a history conversation requires confirmation and passes exact model/session IDs',async()=>{
 const ui=harness();await ui.settle();const calls=[],removed=[];
 ui.api.deleteChat=async(...args)=>{calls.push(args);};ui.props.deleted=chat=>removed.push(chat);
 ui.button('删除对话：A 的完整历史').props.onClick();ui.render();
 assert.equal(calls.length,0);assert.ok(ui.find(n=>n.type==='modal'&&n.props.title==='删除对话？'));
 ui.find(n=>n.props.className==='project-confirm-delete').props.onClick();ui.render();await ui.settle();
 assert.deepEqual(calls,[['original-A-model','old-A']]);assert.equal(removed[0].sessionId,'old-A');
 assert.equal(ui.find(n=>n.type==='modal'),undefined);
});

test('Deletion is disabled during generation and a failure keeps records with an explicit retry',async()=>{
 const ui=harness();await ui.settle();let calls=0;
 ui.api.deleteChat=async()=>{calls++;throw new Error('正在生成，不能删除');};
 ui.props.locked=true;ui.render();assert.equal(ui.button('删除对话：A 的完整历史').props.disabled,true);
 ui.button('删除对话：A 的完整历史').props.onClick();ui.render();assert.equal(ui.find(n=>n.type==='modal'),undefined);
 ui.props.locked=false;ui.render();ui.button('删除对话：A 的完整历史').props.onClick();ui.render();
 ui.find(n=>n.props.className==='project-confirm-delete').props.onClick();await ui.settle();
 assert.equal(calls,1);assert.ok(ui.find(n=>n.props.role==='alert'));
 assert.ok(ui.find(n=>n.props.className==='project-confirm-delete'));
 assert.equal(ui.all(n=>n.type==='button'&&n.props.className?.includes('project-chat-row')).length,3);
 ui.props.locked=true;ui.render();assert.equal(ui.find(n=>n.props.className==='project-confirm-delete').props.disabled,true);
});

test('A running conversation in another project cannot be deleted from a stale idle view',async()=>{
 const ui=harness();await ui.settle();
 ui.api.projectChats=async id=>({items:id===p.id?[{...a,running:true}]:[],nextAfter:null});
 ui.props.revision='running';ui.render();await ui.settle();
 assert.equal(ui.button('删除对话：A 的完整历史').props.disabled,true);
});

test('Project actions use compose next to more, and removal explains that conversations are retained',async()=>{
 const ui=harness();await ui.settle();const calls=[],removed=[];
 ui.api.deleteProject=async id=>{calls.push(id);};ui.props.removed=project=>removed.push(project);
 const compose=ui.button('在 A 服务器 新建对话');assert.equal(compose.props.children.props.name,'edit');
 const menu=ui.find(n=>n.props.label==='项目选项：A 服务器');assert.equal(menu.props.displayValue,'⋯');
 assert.equal(menu.props.options[0].label,'移除项目');
 assert.match(menu.props.options[0].description,/保留聊天记录/);
 ui.api.deleteChat=async()=>assert.fail('removing a group must never delete a conversation');
 menu.props.onChange('remove');ui.render();assert.equal(calls.length,0);
 assert.ok(ui.find(n=>n.type==='modal'&&n.props.title==='移除项目？'));
 assert.ok(ui.find(n=>n.type==='p'&&typeof n.props.children==='string'&&n.props.children.includes('未分组对话')));
 ui.find(n=>n.props.className==='project-confirm-delete').props.onClick();ui.render();await ui.settle();
 assert.deepEqual(calls,[p.id]);assert.equal(removed[0].id,p.id);
 assert.equal(ui.find(n=>n.type==='modal'),undefined);
});

test('Approval badges follow exact conversations and live resolution overrides stale history',async()=>{
 const ui=harness();await ui.settle();
 ui.api.projectChats=async id=>({items:id===p.id?[{...a,awaitingApproval:true}]:id===q.id?[b]:[g],nextAfter:null});
 ui.props.revision='approval';ui.render();await ui.settle();
 const statuses=()=>ui.all(n=>n.props.role==='status');
 assert.equal(statuses().length,1);assert.equal(statuses()[0].props['aria-label'],'等待审批');
 const row=ui.find(n=>n.props['aria-label']===a.title);assert.ok(ui.all(n=>n.props.role==='status',row).length);
 ui.props.approvalState={sessionId:a.sessionId,pending:false};ui.render();assert.equal(statuses().length,0);
 ui.props.approvalState={sessionId:b.sessionId,pending:true};ui.render();assert.equal(statuses().length,2);
 assert.equal(ui.all(n=>n.props.role==='status',ui.find(n=>n.props['aria-label']===b.title)).length,1);
 ui.props.approvalState={sessionId:b.sessionId,pending:false};ui.render();assert.equal(statuses().length,1);
});

test('Running conversations show a spinner, keep selected styling, and clear live state without waiting for history',async()=>{
 const ui=harness();await ui.settle();
 ui.props.sessionId=a.sessionId;ui.props.activeRunning=true;ui.props.locked=true;ui.render();
 const row=ui.find(n=>n.props['aria-label']===a.title);
 assert.match(row.props.className,/active/);assert.equal(row.props['aria-current'],'page');
 assert.equal(ui.all(n=>n.props['aria-label']==='对话进行中',row).length,1);
 assert.equal(ui.all(n=>n.props['aria-label']==='对话进行中',ui.find(n=>n.props['aria-label']===b.title)).length,0);
 ui.props.approvalState={sessionId:a.sessionId,pending:true};ui.render();
 assert.equal(ui.all(n=>n.props['aria-label']==='等待审批').length,1);
 assert.equal(ui.all(n=>n.props['aria-label']==='对话进行中').length,0);
 ui.props.approvalState={sessionId:a.sessionId,pending:false};ui.props.activeRunning=false;ui.render();
 assert.equal(ui.all(n=>n.props.role==='status').length,0);
 ui.api.projectChats=async id=>({items:id===p.id?[{...a,running:true}]:id===q.id?[{...b,running:true}]:[],nextAfter:null});
 ui.props.revision='persisted-running';ui.render();await ui.settle();
 assert.equal(ui.all(n=>n.props['aria-label']==='对话进行中',ui.find(n=>n.props['aria-label']===a.title)).length,0);
 assert.equal(ui.all(n=>n.props['aria-label']==='对话进行中',ui.find(n=>n.props['aria-label']===b.title)).length,1);
});

test('Busy projects cannot be removed; failed removal keeps the project and permits a retry',async()=>{
 const ui=harness();await ui.settle();let calls=0;
 ui.api.deleteProject=async()=>{calls++;throw new Error('项目中有任务正在运行');};
 ui.props.locked=true;ui.render();
 const locked=ui.find(n=>n.props.label==='项目选项：A 服务器');assert.equal(locked.props.disabled,true);
 locked.props.onChange('remove');ui.render();assert.equal(ui.find(n=>n.type==='modal'),undefined);
 ui.props.locked=false;ui.render();ui.find(n=>n.props.label==='项目选项：A 服务器').props.onChange('remove');ui.render();
 ui.find(n=>n.props.className==='project-confirm-delete').props.onClick();await ui.settle();
 assert.equal(calls,1);assert.ok(ui.find(n=>n.props.role==='alert'));
 assert.ok(ui.find(n=>n.props.label==='项目选项：A 服务器'));
 assert.ok(ui.find(n=>n.type==='modal'));
});

function hoverAnchor(){return {isConnected:true,querySelector:()=>null,getBoundingClientRect:()=>({left:70,right:300,top:100,bottom:134})};}
function hoverEntry(ui,anchor,pointerType='mouse'){
 ui.find(n=>n.props.className==='project-chat-entry').props.onPointerEnter({pointerType,currentTarget:{querySelector:()=>anchor}});
}

test('Hover preview replaces native title, appears after a delay, and stays open while the pointer enters the card',async()=>{
 const ui=harness();await ui.settle();const anchor=hoverAnchor();
 const row=ui.button(a.title);assert.equal(row.props.title,undefined);
 hoverEntry(ui,anchor);ui.render();assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);
 ui.runTimers();ui.render();ui.render();
 const card=ui.find(n=>n.props.role==='tooltip');assert.ok(card);assert.equal(card.props.style.visibility,'visible');
 assert.equal(card.props.style.left,310);assert.equal(card.props.style.fontFamily,'Microsoft YaHei UI');
 assert.equal(ui.find(n=>n.type==='strong'&&n.props.children===a.title).props.children,a.title);
 assert.equal(ui.button(a.title).props['aria-describedby'],card.props.id);
 assert.ok(ui.find(n=>n.type==='span'&&n.props.children===p.name));
 assert.match(ui.find(n=>n.type==='time').props['aria-label'],/^创建于 /);
 ui.emit('pointerdown',{target:{nodeType:1,insidePreview:true}});ui.emit('scroll',{target:{nodeType:1,insidePreview:true}});ui.render();
 assert.ok(ui.find(n=>n.props.role==='tooltip'));
 ui.find(n=>n.props.className==='project-chat-entry').props.onPointerLeave();
 card.props.onPointerEnter();ui.runTimers();ui.render();assert.ok(ui.find(n=>n.props.role==='tooltip'));
 ui.find(n=>n.props.role==='tooltip').props.onPointerLeave();ui.runTimers();ui.render();
 assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);assert.equal(ui.actions.length,0);
});

test('Keyboard focus previews immediately; escape, outside pointer, scroll, resize and window blur dismiss it',async()=>{
 const ui=harness();await ui.settle();const anchor=hoverAnchor();
 for(const [event,payload] of [['keydown',{key:'Escape'}],['pointerdown',{target:{}}],['scroll',{target:{}}],['resize',{}],['blur',{}]]){
  ui.button(a.title).props.onFocus({currentTarget:anchor});ui.render();ui.render();
  assert.ok(ui.find(n=>n.props.role==='tooltip'));ui.emit(event,payload);ui.render();
  assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined,event);
 }
 // Scrolling while the opening delay is pending must cancel it too.
 hoverEntry(ui,anchor);ui.emit('scroll',{target:{}});ui.runTimers();ui.render();
 assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);
});

test('An open preview follows adjacent rows immediately, including disabled running history rows',async()=>{
 const ui=harness();await ui.settle();ui.props.locked=true;ui.render();
 hoverEntry(ui,hoverAnchor());ui.runTimers();ui.render();ui.render();
 assert.equal(ui.find(n=>n.type==='strong').props.children,a.title);
 const anchor=hoverAnchor();
 ui.all(n=>n.props.className==='project-chat-entry')[1].props.onPointerEnter({pointerType:'mouse',currentTarget:{querySelector:()=>anchor}});
 ui.render();ui.render();assert.equal(ui.find(n=>n.type==='strong').props.children,b.title);
 assert.equal(ui.actions.length,0);
});

test('Touch, quick pointer departure, detached rows and unmount never leave a delayed popup behind',async()=>{
 const ui=harness();await ui.settle();const anchor=hoverAnchor();
 hoverEntry(ui,anchor,'touch');ui.runTimers();ui.render();assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);
 hoverEntry(ui,anchor);ui.find(n=>n.props.className==='project-chat-entry').props.onPointerLeave();ui.runTimers();ui.render();
 assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);
 hoverEntry(ui,anchor);anchor.isConnected=false;ui.runTimers();ui.render();assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);
 anchor.isConnected=true;hoverEntry(ui,anchor);ui.unmount();ui.runTimers();ui.render();assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);
});

test('Previewing an ungrouped conversation keeps its real history and closes before navigation',async()=>{
 const ui=harness();await ui.settle();const anchor=hoverAnchor();
 ui.button(g.title).props.onFocus({currentTarget:anchor});ui.render();ui.render();
 assert.ok(ui.find(n=>n.type==='span'&&n.props.children==='未分组对话'));
 ui.button(g.title).props.onClick();ui.render();assert.equal(ui.find(n=>n.props.role==='tooltip'),undefined);
 assert.equal(ui.actions[0][1].sessionId,g.sessionId);assert.equal(ui.actions[0][2],null);
});


test('Composer creation requests open the existing project dialog and cancellation completes the request',async()=>{
 const ui=harness();await ui.settle();let finished=0;ui.props.creationFinished=()=>finished++;ui.props.createRequest=1;ui.render();ui.render();
 const modal=ui.find(n=>n.type==='modal'&&n.props.title==='新建服务器项目');assert.ok(modal);modal.props.onClose();ui.render();assert.equal(finished,1);
 assert.equal(ui.find(n=>n.type==='modal'&&n.props.title==='新建服务器项目'),undefined);
});

test('An idle selected chat can be deleted despite a stale running list entry, and clears only after confirmation',async()=>{
 const ui=harness();await ui.settle();const calls=[],removed=[];
 ui.api.projectChats=async id=>({items:id===p.id?[{...a,running:true}]:id===q.id?[b]:[g],nextAfter:null});
 ui.props.project=p;ui.props.sessionId=a.sessionId;ui.props.activeRunning=false;ui.props.revision='stale-running';ui.props.deleted=chat=>removed.push(chat);
 ui.api.deleteChat=async(...args)=>{calls.push(args);};ui.render();await ui.settle();
 assert.equal(ui.button('删除对话：'+a.title).props.disabled,false);ui.button('删除对话：'+a.title).props.onClick();ui.render();assert.equal(calls.length,0);
 const confirm=ui.find(n=>n.props.className==='project-confirm-delete');assert.equal(confirm.props.disabled,false);confirm.props.onClick();await ui.settle();assert.deepEqual(calls,[[a.agentId,a.sessionId]]);assert.equal(removed[0].sessionId,ui.props.sessionId);assert.equal(ui.find(n=>n.type==='modal'),undefined);
});
test('Live generation blocks deletion even with a stale idle list, including a confirmation already open',async()=>{
 const ui=harness();await ui.settle();let calls=0;ui.api.deleteChat=async()=>{calls++;};
 ui.props.sessionId=a.sessionId;ui.props.activeRunning=true;ui.render();assert.equal(ui.button('删除对话：'+a.title).props.disabled,true);ui.button('删除对话：'+a.title).props.onClick();ui.render();assert.equal(ui.find(n=>n.type==='modal'),undefined);
 ui.props.activeRunning=false;ui.render();ui.button('删除对话：'+a.title).props.onClick();ui.render();assert.ok(ui.find(n=>n.type==='modal'));
 ui.props.activeRunning=true;ui.render();const confirm=ui.find(n=>n.props.className==='project-confirm-delete');assert.equal(confirm.props.disabled,true);confirm.props.onClick();await ui.settle();assert.equal(calls,0);
});
test('Deletion confirmation rechecks refreshed background chat state rather than its opening snapshot',async()=>{
 const ui=harness();await ui.settle();let calls=0;ui.api.deleteChat=async()=>{calls++;};ui.button('删除对话：'+a.title).props.onClick();ui.render();
 ui.api.projectChats=async id=>({items:id===p.id?[{...a,running:true}]:[],nextAfter:null});ui.props.revision='became-running';ui.render();await ui.settle();
 const confirm=ui.find(n=>n.props.className==='project-confirm-delete');assert.equal(confirm.props.disabled,true);confirm.props.onClick();await ui.settle();assert.equal(calls,0);
});
