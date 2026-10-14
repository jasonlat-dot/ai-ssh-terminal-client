import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const p={id:'project-A',name:'A 服务器',connectionId:'A',identity:null};
const q={id:'project-B',name:'B 服务器',connectionId:'B',identity:null};
const a={sessionId:'old-A',agentId:'original-A-model',title:'A 的完整历史',createdAt:1};
const b={sessionId:'old-B',agentId:'B-model',title:'B 的独立历史',createdAt:1};
const g={sessionId:'general',agentId:'general-model',title:'普通解疑',createdAt:1};
function harness(){
 const slots=[],effects=[];let cursor=0,tree;
 const actions=[],api={projects:async()=>[p,q],projectChats:async id=>({items:id===p.id?[a]:id===q.id?[b]:[g],nextAfter:null}),
  createProject:async(name,connectionId)=>{actions.push(['create',name,connectionId]);return {...p,id:'created',name,connectionId};}};
 const props={hosts:[{id:'A',name:'服务器 A',address:'a.test',user:'tester'},{id:'B',name:'服务器 B',address:'b.test',user:'tester'}],project:null,sessionId:'',view:'chat',locked:false,revision:'initial',connected:false,
  newChat:project=>actions.push(['new',project]),openChat:(chat,project)=>actions.push(['open',chat,project]),reconnect:()=>actions.push(['reconnect']),
  changeView:view=>actions.push(['view',view]),activeSection:'chat',navigate:section=>actions.push(['navigate',section]),servers:()=>actions.push(['servers'])};
 const hooks={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];},
  useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useEffect(callback,deps){const i=cursor++,old=slots[i];if(!old||!deps.every((v,n)=>Object.is(v,old.deps[n]))){const next={deps,cleanup:null};slots[i]=next;effects.push(()=>{old?.cleanup?.();next.cleanup=callback();});}},
 };
 const compiled=ts.transpileModule(readFileSync(new URL('../src/components/ProjectChatHistory.tsx',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const context=vm.createContext({exports:{},require:name=>{
  if(name==='react')return hooks;
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='../api/agent')return {agentApi:api};
  if(name==='./Ui')return {Icon:()=>null,Modal:'modal'};
  if(name==='./Select')return {Select:()=>null};
  throw new Error(name);
 }});
 vm.runInContext(compiled,context);
 function render(){cursor=0;tree=context.exports.ProjectChatHistory(props);while(effects.length)effects.shift()();}
 function all(predicate,node){if(arguments.length===1)node=tree;
  if(Array.isArray(node))return node.flatMap(child=>all(predicate,child));
  if(!node?.props)return [];
  return [...(predicate(node)?[node]:[]),...all(predicate,node.props.children)];
 }
 function find(predicate){return all(predicate)[0];}
 function button(label){return find(n=>n.type==='button'&&(n.props['aria-label']===label||n.props.children===label));}
 render();
 return {props,actions,api,render,find,all,button,async settle(){await new Promise(resolve=>setImmediate(resolve));render();}};
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

