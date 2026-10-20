import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {executionTerminal,prepareExecutionBinding} from '../src/state/executionBinding.ts';
import {isSessionConnected} from '../src/state/terminalSessions.ts';
import {NextConversationModels} from '../src/state/nextConversationModels.ts';
import {ConversationRuns} from '../src/state/conversationRuns.ts';

const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function action(name,globals){
 let arrow;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(app)===name)arrow=node.initializer;ts.forEachChild(node,visit);}
 visit(app);assert.ok(arrow,`${name} exists`);
 let apply;function findApply(node){if(ts.isVariableDeclaration(node)&&node.name.getText(app)==='applyNextModel')apply=node.initializer.getText(app);ts.forEachChild(node,findApply);}findApply(app);
 const code=ts.transpileModule(`const applyNextModel=${apply};exports.action=${arrow.getText(app)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const context=vm.createContext({exports:{},crypto,AbortController,DOMException,console,Error,Date,historyLoadingId:"",recoveredRunning:false,nextModels:new NextConversationModels(),agentModelsRef:{current:globals.agentModels??[]},readAgentHistory:async reader=>reader(),...globals});vm.runInContext(code,context);return context.exports.action;
}
const model={agentId:'model',agentName:'test',toolsAvailable:true};
const project={id:'project',name:'server',connectionId:'saved-ssh'};
const terminal={id:'tab',kind:'ssh',connectionId:'saved-ssh',terminalSessionId:'native-terminal',connected:true,connectionStatus:'connected'};

test('Changing a model reuses a saved conversation after native commit without clearing messages or the draft',async()=>{
 const next={...model,agentId:'next'};let history={session:{id:'same-chat',agentId:'model',revision:7,scope:{kind:'server'},task:{target:{connectionId:'saved-ssh'}}},turns:[{message:'keep history'}]};
 const calls=[],selected={current:model},skip={current:''};let selectedState=model,revision=0;
 const switchModel=action('changeConversationModel',{
  projectLocked:false,scopeSwitchRef:{current:false},chatting:{current:false},stopPending:{current:false},reasoningSavingRef:{current:false},manualCompactionAbort:{current:null},
  agentModels:[model,next],selectedAgentRef:selected,chatSessionId:{current:'same-chat'},rustBuiltin:true,canonicalHistory:history,skipModelReset:skip,
  setScopeSwitching(){},setCanonicalHistory:update=>{history=typeof update==='function'?update(history):update;},setSelectedAgent:value=>{selectedState=value;},setContextSnapshot(){},setContextError(){},setProjectRevision:update=>{revision=update(revision);},
  agentApi:{changeModel:async(...args)=>{calls.push(args);assert.equal(selectedState,model,'UI only changes after native commit');return{...history.session,agentId:'next',revision:8};},history:async()=>history},
  notify:message=>assert.fail(message),clearChat:()=>assert.fail('must retain conversation'),newProjectChat:()=>assert.fail('must not create a chat'),
 });
 await switchModel('next');assert.equal(history.session.id,'same-chat');assert.equal(history.session.agentId,'next');assert.equal(history.turns[0].message,'keep history');
 assert.deepEqual(calls,[['model','same-chat','next',7]]);assert.equal(selectedState,next);assert.equal(selected.current,next);assert.equal(skip.current,'next');assert.equal(revision,1);
});

test('Failed model change preserves the current model and conversation',async()=>{
 const next={...model,agentId:'next'},selected={current:model},skip={current:''},gate={current:false},notices=[],nextModels=new NextConversationModels();let locked=false;
 const switchModel=action('changeConversationModel',{
  projectLocked:false,scopeSwitchRef:gate,chatting:{current:false},stopPending:{current:false},reasoningSavingRef:{current:false},manualCompactionAbort:{current:null},nextModels,agentModels:[model,next],selectedAgentRef:selected,chatSessionId:{current:'same'},rustBuiltin:true,canonicalHistory:{session:{id:'same',revision:3}},skipModelReset:skip,
  setScopeSwitching:value=>{locked=value;},setCanonicalHistory:()=>assert.fail('do not replace history'),setSelectedAgent:()=>assert.fail('keep original model'),
  agentApi:{history:async()=>({session:{id:'same',revision:3}}),changeModel:async()=>{assert.equal(nextModels.get('same').saving,true);throw Error('context changed');}},notify:message=>notices.push(message),
 });
 await switchModel('next');assert.equal(selected.current,model);assert.equal(skip.current,'');assert.equal(locked,false);assert.equal(gate.current,false);assert.deepEqual(notices,[]);assert.equal(nextModels.get('same').error,'context changed');
});

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
  document:{hidden:false},viewedConversation:{current:''},chatRuns:new ConversationRuns(),messagesRef:{current:[]},selectedAgentRef:{current:model},
  reasoningSavingRef:{current:false},manualCompactionAbort:{current:null},toolsEnabled:true,sshExecutionEnabled:false,draftExecutionPolicy:'confirm',
  chatting:{current:false},stopPending:{current:false},scopeSwitchRef:{current:false},historyLoadingId:'',recoveredRunning:false,agentLoading:false,agentLoadError:'',
  activeProject:project,projectTerminalId:terminal.terminalSessionId,active:terminal,sessions:[terminal],sessionsRef:{current:[terminal]},terminalClients:{current:new Map()},
  rustBuiltin:true,executionEnabled:false,canonicalHistory:null,selectedAgent:model,chatSessionId:chatId,chatTarget:{current:null},chatVersion:{current:1},chatRequestId:{current:''},chatAbort:{current:null},
  setContextSnapshot(){},setContextError(){},setChatBusy(){},setChatStopping(){},setActiveChatSessionId(){},setCanonicalHistory(){},setProjectRevision(){},
  updateMessages:update=>{messages=update(messages);},replaceMessages:next=>{messages=next;},validateChatContent:()=>'',
  isSessionConnected,executionTerminal,prepareExecutionBinding,agentApi:api,persistClientSession:async()=>{},refreshChatSessions:async()=>{},
  readAgentHistory:async()=>({session:bound,turns:[]}),turnMessages:()=>[],notify:message=>assert.fail(message),
 });
 assert.equal(await send('检查服务器'),true);assert.equal(chatId.current,'created-chat');
 assert.deepEqual(calls,[['create-project','project','model','native-terminal'],['bind','model','created-chat','native-terminal'],['stream','created-chat','native-terminal',true]]);
});
