import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {executionTerminal,prepareExecutionBinding} from '../src/state/executionBinding.ts';
import {isSessionConnected} from '../src/state/terminalSessions.ts';

const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function action(name,globals){
 let arrow;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(app)===name)arrow=node.initializer;ts.forEachChild(node,visit);}
 visit(app);assert.ok(arrow,`${name} exists`);
 const code=ts.transpileModule(`exports.action=${arrow.getText(app)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const context=vm.createContext({exports:{},crypto,AbortController,DOMException,console,Error,Date,...globals});vm.runInContext(code,context);return context.exports.action;
}
const model={agentId:'model',agentName:'test',toolsAvailable:true};
const project={id:'project',name:'server',connectionId:'saved-ssh'};
const terminal={id:'tab',kind:'ssh',connectionId:'saved-ssh',terminalSessionId:'native-terminal',connected:true,connectionStatus:'connected'};

test('Selecting a project connects but never creates or opens a persistent history session',async()=>{
 const connected=[],cleared=[];
 const choose=action('newProjectChat',{
  selectedAgent:model,selectedAgentRef:{current:model},agentModels:[model],projectLocked:false,scopeSwitchRef:{current:false},skipModelReset:{current:''},
  setScopeSwitching(){},setAgentCollapsed(){},setActiveProject(){},setProjectTerminalId(){},setSelectedAgent(){},clearChat(){cleared.push(true);},
  connectProject:async p=>{connected.push(p.id);return terminal;},notify:()=>assert.fail('unexpected error'),
  agentApi:new Proxy({},{get:()=>()=>assert.fail('project selection must not create history')}),
  selectChatSession:()=>assert.fail('selection must not open a new persistent session'),
 });
 await choose(project);assert.deepEqual(connected,['project']);assert.equal(cleared.length,1);
 await choose(null);assert.deepEqual(connected,['project']);
});

test('First message creates the selected project session and binds tools to its exact terminal',async()=>{
 const calls=[],chatId={current:''};let messages=[];
 const session={id:'created-chat',agentId:'model',userId:'default',revision:0,scope:{rootId:'created-chat',kind:'server',connectionId:'saved-ssh',originTerminalId:'native-terminal',identity:null},task:null};
 const bound={...session,task:{id:'task',status:'active',goal:'test',constraints:[],target:{connectionId:'saved-ssh',terminalSessionId:'native-terminal'}}};
 const api={userId:'default',
  projectChat:async(...args)=>{calls.push(['create-project',...args]);return session;},
  createSession:()=>assert.fail('must not create a general session'),
  bindExecution:async(...args)=>{calls.push(['bind',...args]);return bound;},
  chatStream:async body=>{calls.push(['stream',body.sessionId,body.terminalSessionId,body.executionEnabled]);},
 };
 const send=action('sendMessage',{
  reasoningSavingRef:{current:false},toolsEnabled:true,sshExecutionEnabled:false,draftExecutionPolicy:'confirm',
  chatting:{current:false},stopPending:{current:false},scopeSwitchRef:{current:false},historyLoadingId:'',recoveredRunning:false,agentLoading:false,agentLoadError:'',
  activeProject:project,projectTerminalId:terminal.terminalSessionId,active:terminal,sessions:[terminal],sessionsRef:{current:[terminal]},terminalClients:{current:new Map()},
  rustBuiltin:true,executionEnabled:false,canonicalHistory:null,selectedAgent:model,chatSessionId:chatId,chatTarget:{current:null},chatVersion:{current:1},chatRequestId:{current:''},chatAbort:{current:null},
  setContextSnapshot(){},setContextError(){},setChatBusy(){},setActiveChatSessionId(){},setCanonicalHistory(){},setProjectRevision(){},
  updateMessages:update=>{messages=update(messages);},replaceMessages:next=>{messages=next;},validateChatContent:()=>'',
  isSessionConnected,executionTerminal,prepareExecutionBinding,agentApi:api,persistClientSession:async()=>{},refreshChatSessions:async()=>{},
  readAgentHistory:async()=>({session:bound,turns:[]}),turnMessages:()=>[],notify:message=>assert.fail(message),
 });
 assert.equal(await send('检查服务器'),true);assert.equal(chatId.current,'created-chat');
 assert.deepEqual(calls,[['create-project','project','model','native-terminal'],['bind','model','created-chat','native-terminal'],['stream','created-chat','native-terminal',true]]);
});
