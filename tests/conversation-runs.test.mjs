import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { NextConversationModels } from '../src/state/nextConversationModels.ts';
import { ConversationRuns } from '../src/state/conversationRuns.ts';
import { ChatRequestError } from '../src/api/chatErrors.ts';

// Execute the actual App actions together, with delayed streams and storage.
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=new Set(['sendMessage','stopChat','loadChatSession','selectChatSession','prepareForClientUpdate','applyNextModel','changeConversationModel']);
const actions=[];
function visit(node){if(ts.isVariableDeclaration(node)&&names.has(node.name.getText(source)))actions.push(`const ${node.getText(source)};`);ts.forEachChild(node,visit);}
visit(source);
const compiled=ts.transpileModule(`${actions.join('\n')}\nexports.actions={${[...names].join(',')}};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);

function harness({native=false}={}){
 const streams=new Map(),saved=[],stops=[],notices=[],histories=new Map();
 const state={messages:[],sessionId:'A',busy:false,stopping:false,canonical:null,context:null};
 const model={agentId:'model-A',agentName:'A',toolsAvailable:true},other={agentId:'model-B',agentName:'B',toolsAvailable:true};
 const chatRuns=new ConversationRuns();
 let context;
 const globals={exports:{},viewedConversation:{current:'A'},document:{hidden:false},crypto,AbortController,DOMException,Date,Error,console,setTimeout,clearTimeout,ChatRequestError,
  nextModels:new NextConversationModels(),agentModelsRef:{current:[model,other]},
  chatRuns,selectedAgent:model,selectedAgentRef:{current:model},agentModels:[model,other],chatSessionId:{current:'A'},chatVersion:{current:0},
  messagesRef:{current:[]},chatting:{current:false},stopPending:{current:false},chatAbort:{current:null},chatRequestId:{current:''},
  reasoningSavingRef:{current:false},manualCompactionAbort:{current:null},scopeSwitchRef:{current:false},historyLoadingId:'',recoveredRunning:false,agentLoading:false,agentLoadError:'',
  toolsEnabled:true,sshExecutionEnabled:false,rustBuiltin:native,active:null,activeProject:null,sessions:[],sessionsRef:{current:[]},terminalClients:{current:new Map()},canonicalHistory:null,
  chatTarget:{current:null},scopeTerminal:()=>undefined,validateChatContent:()=>'',attachmentReferences:files=>files,
  draftExecutionPolicy:'confirm',historySelection:{current:0},skipModelReset:{current:''},clientHistoryDirty:{current:false},backendUrl:'test',chatDraft:{clear(){}},
  setContextSnapshot(value){state.context=value;},setContextError(){},setChatBusy(value){state.busy=value;},setChatStopping(value){state.stopping=value;},
  setCanonicalHistory(value){state.canonical=typeof value==='function'?value(state.canonical):value;context.canonicalHistory=state.canonical;},
  setActiveChatSessionId(id){state.sessionId=id;globals.viewedConversation.current=id;},setHistoryLoadingId(id){context.historyLoadingId=id;},setProjectRevision(){},
  setSelectedAgent(model){context.selectedAgent=model;},
  updateMessages(update){state.messages=update(globals.messagesRef.current);globals.messagesRef.current=state.messages;},
  replaceMessages(messages){state.messages=messages;globals.messagesRef.current=messages;},
  persistClientSession:async(model,id,messages)=>{saved.push({model,id,messages:structuredClone(messages)});},refreshChatSessions:async()=>{},
  loadClientChatSession:async()=>[],readAgentHistory:async reader=>reader(),turnMessages:turns=>turns,
  notify:(message,type)=>notices.push({message,type}),closingApp:{current:false},chatBusy:false,chatStopping:false,broadcastBusy:false,cleanupBeforeClose:()=>assert.fail('background tasks must block installation'),
  agentApi:{userId:'default',changeModel:async(previous,id,next,revision)=>({id,agentId:next,revision:revision+1,task:null}),history:async(model,id)=>histories.get(id)??{session:{id,task:null},turns:[],messages:[]},
   chatStream:async(body,receive,signal)=>{
    const done=deferred();streams.set(body.sessionId,{body,receive,signal,done});
    signal.addEventListener('abort',()=>done.reject(new DOMException('Aborted','AbortError')),{once:true});
    return done.promise;
   },stopChat:async(...args)=>{const done=deferred();stops.push({args,done});return done.promise;},
  },
 };
 context=vm.createContext(globals);vm.runInContext(compiled,context);
 return{...context.exports.actions,context,state,streams,chatRuns,saved,stops,notices,histories,other,
  async open(id,model='model-A'){
   assert.equal(await context.exports.actions.selectChatSession(id,model),true);
   // Simulate the visibility effect after the selected conversation is rendered.
   if(!context.document.hidden&&globals.viewedConversation.current===id)chatRuns.acknowledge(id);
  },
 };
}

test('Two conversations stream concurrently; returning restores live text, tools and context without cross-writing',async()=>{
 const ui=harness();const a=ui.sendMessage('A question');await tick();
 const first=ui.streams.get('A');first.receive({event:'text',content:'A1'});
 await ui.open('B','model-B');assert.equal(first.signal.aborted,false);assert.equal(ui.state.busy,false);
 const b=ui.sendMessage('B question');await tick();const second=ui.streams.get('B');
 first.receive({event:'text',content:'A2'});
 first.receive({event:'tool_call',toolCallId:'tool-A',toolName:'shell',command:'pwd',status:'running'});
 first.receive({event:'tool_result',toolCallId:'tool-A',content:'A output',status:'success'});
 first.receive({event:'context',status:{requestId:first.body.requestId,phase:'idle'}});
 second.receive({event:'text',content:'B1'});
 assert.equal(ui.state.messages.at(-1).text,'B1');assert.equal(ui.state.context,null);
 await ui.open('A');assert.equal(ui.state.busy,true);assert.equal(ui.state.messages.at(-1).text,'A1A2');
 assert.equal(ui.state.messages.at(-1).segments.at(-1).tool.output,'A output');assert.equal(ui.state.context.sessionId,'A');
 second.done.resolve();await b;assert.equal(ui.state.busy,true,'B completion must not unlock A');
 assert.equal(ui.state.messages.at(-1).text,'A1A2');assert.equal(first.signal.aborted,false);
 first.receive({event:'text',content:'A3'});first.done.resolve();await a;
 assert.equal(ui.state.busy,false);assert.equal(ui.chatRuns.active.length,0);
 assert.equal(ui.saved.find(item=>item.id==='A').messages.at(-1).text,'A1A2A3');
 assert.equal(ui.saved.find(item=>item.id==='B').model,'model-B');
 // A late callback must not overwrite the next turn on the same session.
 const next=ui.sendMessage('next A');await tick();first.receive({event:'text',content:'late old A'});
 assert.equal(ui.state.messages.at(-1).text,'');ui.streams.get('A').done.resolve();await next;
});

test('Stop captures the viewed request; delayed cancellation never aborts or unlocks another run',async()=>{
 const ui=harness();const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');
 ui.stopChat();assert.equal(ui.state.stopping,true);ui.stopChat();assert.equal(ui.stops.length,1);
 await ui.open('B');const b=ui.sendMessage('B');await tick();const second=ui.streams.get('B');
 assert.equal(ui.stops[0].args[0],'model-A');assert.equal(ui.stops[0].args[1],'A');assert.equal(ui.stops[0].args[3],first.body.requestId);
 ui.stops[0].done.resolve();await a;assert.equal(first.signal.aborted,true);assert.equal(second.signal.aborted,false);
 assert.equal(ui.state.busy,true);assert.equal(ui.state.stopping,false);
 second.done.resolve();await b;
});

test('An SSH binding that resolves after navigation keeps the original model, session and terminal',async()=>{
 const ui=harness(),binding=deferred();
 const terminal={terminalSessionId:'terminal-A'};
 Object.assign(ui.context,{sshExecutionEnabled:true,canonicalHistory:{session:{id:'A',scope:{kind:'server'}}},
  executionTerminal:()=>terminal,prepareExecutionBinding:()=>binding.promise});
 const a=ui.sendMessage('A SSH task');await tick();assert.equal(ui.streams.size,0);
 await ui.open('B','model-B');
 binding.resolve({id:'A',task:{target:{connectionId:'server-A',terminalSessionId:'terminal-A'}}});await tick();
 const stream=ui.streams.get('A');assert.equal(stream.body.agentId,'model-A');assert.equal(stream.body.terminalSessionId,'terminal-A');
 assert.equal(ui.context.chatTarget.current,null,'the visible B target must remain unchanged');
 stream.done.resolve();await a;
});

test('Background failure and nested tool events are saved to their original conversation',async()=>{
 const ui=harness();const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');await ui.open('B');
 first.receive({event:'agent_start',agentCallId:'child-A',agentName:'worker'});
 first.receive({event:'agent_text',agentCallId:'child-A',content:'working on A'});
 first.receive({event:'tool_result',agentCallId:'child-A',toolCallId:'child-tool',toolName:'read',status:'success',content:'original file'});
 first.done.reject(new Error('A provider failed'));assert.equal(await a,false);assert.deepEqual(ui.state.messages,[]);
 const message=ui.saved[0].messages.at(-1);assert.equal(message.errorMessage,'A provider failed');assert.equal(message.segments[0].agent.tools[0].output,'original file');
 assert.equal(ui.state.busy,false);assert.equal(ui.chatRuns.active.length,0);
});

test('A final canonical history read finishing in the background never replaces the newly selected chat',async()=>{
 const ui=harness({native:true});const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');const delayed=deferred();
 ui.context.agentApi.history=async(model,id)=>id==='A'?delayed.promise:{session:{id:'B',task:null},turns:[{id:'saved-B',text:'B history'}]};
 first.done.resolve();await tick();await ui.open('B');delayed.resolve({session:{id:'A',task:null},turns:[{requestId:first.body.requestId}],messages:[{id:'done-A',text:'A persisted'}]});
 await a;assert.equal(ui.state.canonical.session.id,'B');assert.equal(ui.state.messages[0].text,'B history');assert.equal(ui.state.busy,false);
});

test('Failed navigation preserves the visible stream and model, and a background task blocks installing updates',async()=>{
 const ui=harness({native:true});const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');
 ui.context.agentApi.history=async()=>{throw Error('history unavailable');};
 assert.equal(await ui.selectChatSession('B','model-B'),undefined);assert.equal(ui.context.selectedAgent.agentId,'model-A');
 assert.equal(ui.context.chatSessionId.current,'A');first.receive({event:'text',content:'still A'});assert.equal(ui.state.messages.at(-1).text,'still A');
 ui.context.agentApi.history=async(model,id)=>({session:{id,task:null},turns:[],messages:[]});await ui.open('B');
 await assert.rejects(ui.prepareForClientUpdate(),/请先结束/);first.done.resolve();await a;
});

test('Registry prevents duplicate turns, scopes stop state and aborts all streams only on disposal',()=>{
 const runs=new ConversationRuns();let changes=0;const off=runs.subscribe(()=>changes++);
 const make=(sessionId,requestId)=>({sessionId,requestId,agentId:'model',messages:[],controller:new AbortController(),stopping:false});
 const a=runs.start(make('','a'));assert.throws(()=>runs.start(make('','other')));runs.bind(a,'A');
 const b=runs.start(make('B','b'));assert.throws(()=>runs.bind(b,'A'));assert.equal(runs.stop(a),true);assert.equal(runs.stop(a),false);
 assert.equal(b.stopping,false);runs.finish(a);assert.equal(b.controller.signal.aborted,false);runs.dispose();assert.equal(b.controller.signal.aborted,true);
 assert.equal(runs.active.length,0);assert.ok(changes>=6);off();
});

test('A successful background result stays unread until that exact conversation is opened',async()=>{
 const ui=harness();const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');
 await ui.open('B');first.done.resolve();await a;
 assert.equal(ui.chatRuns.unreadResults.get('A'),'success');assert.equal(ui.chatRuns.unreadResults.has('B'),false);
 await ui.open('C');assert.equal(ui.chatRuns.unreadResults.get('A'),'success');
 await ui.open('A');assert.equal(ui.chatRuns.unreadResults.has('A'),false);
});

test('Settings, collapsed panes and a hidden window count as unseen; watching the conversation does not',async()=>{
 for(const view of ['settings','collapsed','hidden','watching']){
  const ui=harness();const a=ui.sendMessage('A');await tick();
  if(view==='hidden')ui.context.document.hidden=true;
  else if(view!=='watching')ui.context.viewedConversation.current='';
  ui.streams.get('A').done.resolve();await a;
  assert.equal(ui.chatRuns.unreadResults.get('A'),view==='watching'?undefined:'success',view);
 }
});

test('Background errors show a failure result while cancellation stays unmarked',async()=>{
 const ui=harness();const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');
 await ui.open('B');first.done.reject(new Error('upstream unavailable'));await a;
 assert.equal(ui.chatRuns.unreadResults.get('A'),'error');
 const b=ui.sendMessage('B');await tick();ui.stopChat();await ui.open('C');ui.stops[0].done.resolve();await b;
 assert.equal(ui.chatRuns.unreadResults.has('B'),false);assert.equal(ui.chatRuns.unreadResults.get('A'),'error');
});

test('The persisted turn can correct a successful stream to failure before the unread result is published',async()=>{
 for(const state of ['failed','interrupted']){
  const ui=harness({native:true});const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');
  await ui.open('B');ui.histories.set('A',{session:{id:'A'},turns:[{requestId:first.body.requestId,state}]});
  first.done.resolve();await a;assert.equal(ui.chatRuns.unreadResults.get('A'),'error',state);
 }
});

test('Failed navigation never acknowledges an unread result and late finish cannot recreate an acknowledged one',async()=>{
 const ui=harness({native:true});const a=ui.sendMessage('A');await tick();const first=ui.streams.get('A');
 await ui.open('B');first.done.resolve();await a;assert.equal(ui.chatRuns.unreadResults.get('A'),'success');
 ui.context.agentApi.history=async()=>{throw Error('offline');};await ui.selectChatSession('A');
 assert.equal(ui.chatRuns.unreadResults.get('A'),'success');
 const run={sessionId:'other',requestId:'old',agentId:'model',messages:[],controller:new AbortController(),stopping:false};
 ui.chatRuns.start(run);ui.chatRuns.finish(run,'error',false);ui.chatRuns.acknowledge('other');ui.chatRuns.finish(run,'error',false);
 assert.equal(ui.chatRuns.unreadResults.has('other'),false);
});

test('Loading unread history in a hidden window does not mark it as viewed',async()=>{
 const ui=harness();const a=ui.sendMessage('A');await tick();await ui.open('B');ui.streams.get('A').done.resolve();await a;
 assert.equal(ui.chatRuns.unreadResults.get('A'),'success');ui.context.document.hidden=true;
 await ui.open('A');assert.equal(ui.chatRuns.unreadResults.get('A'),'success');
 ui.context.document.hidden=false;await ui.open('A');assert.equal(ui.chatRuns.unreadResults.has('A'),false);
});

test('Choosing a model during generation leaves the current stream intact and changes only the next turn',async()=>{
 const ui=harness({native:true}),changes=[];
 ui.context.agentApi.changeModel=async(previous,id,next,revision)=>{changes.push([previous,id,next,revision]);return{id,agentId:next,revision:2,task:null};};
 const a=ui.sendMessage('original turn');await tick();const stream=ui.streams.get('A');
 await ui.changeConversationModel('model-B');assert.equal(changes.length,0);assert.equal(ui.context.selectedAgent.agentId,'model-A');
 assert.equal(ui.context.nextModels.get('A').modelId,'model-B');assert.equal(stream.signal.aborted,false);
 stream.receive({event:'text',content:'original answer'});assert.equal(ui.state.messages.at(-1).text,'original answer');
 stream.done.resolve();await a;assert.equal(changes.length,1);assert.equal(changes[0][0],'model-A');assert.equal(changes[0][2],'model-B');
 assert.equal(ui.context.selectedAgent.agentId,'model-B');assert.equal(ui.state.busy,false);assert.equal(ui.context.nextModels.get('A'),undefined);
 assert.equal(ui.state.messages.at(-1).text,'original answer');
 const next=ui.sendMessage('next turn');await tick();assert.equal(ui.streams.get('A').body.agentId,'model-B');ui.streams.get('A').done.resolve();await next;
});

test('A queued model transition completes in the background without changing the conversation being viewed',async()=>{
 const ui=harness({native:true});const a=ui.sendMessage('A');await tick();const stream=ui.streams.get('A');
 await ui.changeConversationModel('model-B');await ui.open('B');
 stream.done.resolve();await a;assert.equal(ui.context.selectedAgent.agentId,'model-A');assert.equal(ui.state.sessionId,'B');assert.equal(ui.state.busy,false);
 assert.deepEqual(ui.state.messages,[]);
 // The sidebar may still hold the old model ID when the user returns.
 await ui.open('A','model-A');assert.equal(ui.context.selectedAgent.agentId,'model-B');
});

test('A failed next-model transition retains the original model and blocks queued sends until retry or cancellation',async()=>{
 const ui=harness({native:true});let fail=true;
 ui.context.agentApi.changeModel=async(previous,id,next)=>{if(fail)throw Error('模型暂不可用');return{id,agentId:next,revision:2,task:null};};
 const a=ui.sendMessage('A');await tick();await ui.changeConversationModel('model-B');ui.streams.get('A').done.resolve();await a;
 assert.equal(ui.context.selectedAgent.agentId,'model-A');assert.equal(ui.context.nextModels.get('A').error,'模型暂不可用');
 assert.equal(await ui.sendMessage('must remain queued'),false);
 fail=false;await ui.changeConversationModel('model-B');assert.equal(ui.context.nextModels.get('A'),undefined);assert.equal(ui.context.selectedAgent.agentId,'model-B');
});

test('Selecting the original model before completion cancels the queued switch',async()=>{
 const ui=harness({native:true});let changes=0;ui.context.agentApi.changeModel=async()=>{changes++;throw Error('must not switch');};
 const a=ui.sendMessage('A');await tick();await ui.changeConversationModel('model-B');await ui.changeConversationModel('model-A');
 assert.equal(ui.context.nextModels.get('A'),undefined);ui.streams.get('A').done.resolve();await a;assert.equal(changes,0);
});

test('A lost model-change receipt reconciles the native session on retry without changing or sending twice',async()=>{
 const ui=harness({native:true});let native='model-A',changes=0;
 ui.context.agentApi.history=async(model,id)=>{if(model!==native)throw Error('session model changed');return{session:{id,agentId:native,revision:2},turns:[]};};
 ui.context.agentApi.changeModel=async()=>{changes++;native='model-B';throw Error('receipt lost');};
 await ui.changeConversationModel('model-B');assert.equal(ui.context.nextModels.get('A').error,'receipt lost');assert.equal(ui.context.selectedAgent.agentId,'model-A');
 await ui.changeConversationModel('model-B');assert.equal(ui.context.nextModels.get('A'),undefined);assert.equal(ui.context.selectedAgent.agentId,'model-B');
 assert.equal(changes,1);assert.equal(ui.streams.size,0);
});

test('Cancelling after a lost change receipt restores the native original model before clearing the pending selection',async()=>{
 const ui=harness({native:true}),changes=[];let native='model-A';
 ui.context.agentApi.history=async(model,id)=>{if(model!==native)throw Error('session model changed');return{session:{id,agentId:native,revision:2},turns:[]};};
 ui.context.agentApi.changeModel=async(previous,id,next)=>{changes.push([previous,next]);native=next;if(changes.length===1)throw Error('receipt lost');return{id,agentId:native,revision:3};};
 await ui.changeConversationModel('model-B');await ui.changeConversationModel('model-A');
 assert.deepEqual(changes,[['model-A','model-B'],['model-B','model-A']]);assert.equal(ui.context.nextModels.get('A'),undefined);
 assert.equal(native,'model-A');assert.equal(ui.context.selectedAgent.agentId,'model-A');assert.equal(ui.streams.size,0);
});

test('An idle background model transition still blocks installation until its native result is confirmed',async()=>{
 const ui=harness({native:true}),wait=deferred();
 ui.context.agentApi.changeModel=async(previous,id,next)=>{await wait.promise;return{id,agentId:next,revision:2};};
 const switching=ui.changeConversationModel('model-B');await tick();await ui.open('B');
 await assert.rejects(ui.prepareForClientUpdate(),/请先结束/);wait.resolve();await switching;
 assert.equal(ui.context.nextModels.saving,false);assert.equal(ui.state.sessionId,'B');
});

test('An in-flight sidebar load cannot restore the old model after a background model commit overtakes it',async()=>{
 const ui=harness({native:true}),wait=deferred();await ui.open('B');let first=true;
 ui.context.agentApi.history=async(model,id)=>{if(id==='A'&&first){first=false;await wait.promise;return{session:{id,agentId:'model-A',revision:1},turns:[]};}return{session:{id,agentId:model,revision:2},turns:[]};};
 const opening=ui.open('A','model-A');await tick();
 ui.context.nextModels.select('A','model-A','model-B');await ui.applyNextModel('A');wait.resolve();await opening;
 assert.equal(ui.context.selectedAgent.agentId,'model-B');assert.equal(ui.state.canonical.session.agentId,'model-B');
 assert.equal(ui.state.sessionId,'A');assert.equal(ui.streams.size,0);
});
