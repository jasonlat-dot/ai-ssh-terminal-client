import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { agentApi,type AgentStreamEvent } from '../src/api/agent.ts';
import { ChatRequestError } from '../src/api/chatErrors.ts';
import { modelApi, newModelConfig } from '../src/api/models.ts';
import { adoptBundledBackendUrl,BUILTIN_ENDPOINT } from '../src/config/backend.ts';

const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
const originalFetch=globalThis.fetch;
const identity='ipc://builtin/00000000-0000-4000-8000-000000000001';
afterEach(()=>{
  if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');
  globalThis.fetch=originalFetch;adoptBundledBackendUrl(BUILTIN_ENDPOINT);
});
function harness(handler:(command:string,args:any)=>unknown) {
  adoptBundledBackendUrl(identity);
  Object.defineProperty(globalThis,'window',{configurable:true,value:{__TAURI_INTERNALS__:{
    invoke:handler,transformCallback:()=>1,unregisterCallback:()=>undefined,
  }}});
  globalThis.fetch=async()=>{throw new Error('Agent must use IPC');};
}
const body={requestId:'turn-1',agentId:'model',userId:'default',sessionId:'chat',terminalSessionId:'',message:'hello'};
test('Steering is an exact-turn native request and does not send a stop or start another turn',async()=>{
  const requests:any[]=[];harness((command,args)=>{assert.equal(command,'builtin_request');requests.push(args.request);return Promise.resolve({id:'input-1',message:'只讨论',eventId:null,createdAt:1});});
  await agentApi.steer('model','chat','turn-1','input-1','只讨论');
  assert.equal(requests.length,1);assert.equal(requests[0].endpoint,'agent/steer');assert.deepEqual(requests[0].body,{agentId:'model',sessionId:'chat',expectedRequestId:'turn-1',id:'input-1',message:'只讨论',userId:'default'});
});
test('Applied steering receipts share ordered Channel ACK and invalid receipts cancel the stream',async()=>{
  const received:AgentStreamEvent[]=[];let cancelled=false;
  harness((command,args)=>{if(command==='builtin_cancel')cancelled=true;if(command==='builtin_agent_subscribe'){args.onEvent.onmessage({sequence:1,requestId:'turn-1',payload:{event:'input',input:{id:'input',message:'补充',eventId:9,createdAt:1}}});args.onEvent.onmessage({sequence:2,requestId:'turn-1',payload:{event:'done',content:'answer'}});}return Promise.resolve();});
  await agentApi.chatStream(body,e=>received.push(e));assert.equal(received[0].event,'input');assert.equal(cancelled,false);
  harness((command,args)=>{if(command==='builtin_cancel')cancelled=true;if(command==='builtin_agent_subscribe')args.onEvent.onmessage({sequence:1,requestId:'turn-1',payload:{event:'input',input:{id:'bad',message:'bad',eventId:null}}});return Promise.resolve();});
  await assert.rejects(agentApi.chatStream(body,()=>{}));assert.equal(cancelled,true);
});
test('Model settings use native owner-scoped CRUD and explicit key replacement without browser storage', async () => {
  const requests: any[] = [];
  harness((command,args) => { assert.equal(command,'builtin_request'); requests.push(args.request); return Promise.resolve(args.request.method==='GET'?[]:true); });
  await modelApi.list();
  await modelApi.save('daily',0,{...newModelConfig(),baseUrl:'https://example.test/v1/',model:'text'}, {action:'set',value:'fake-test-key'});
  await modelApi.save('daily',1,newModelConfig(),{action:'keep'});
  await modelApi.save('daily',2,newModelConfig(),{action:'clear'});
  await modelApi.save('daily',3,newModelConfig(),{action:'keep'},'新的显示名称');
  await modelApi.delete('daily',3);
  assert.deepEqual(requests.map(r=>r.method),['GET','POST','POST','POST','POST','DELETE']);
  assert.ok(requests.every(r=>r.endpoint==='agent/models' && (r.body?.userId ?? r.params.userId)==='default'));
  assert.deepEqual(requests[1].body.update.apiKey,{action:'set',value:'fake-test-key'});
  assert.deepEqual(requests[2].body.update.apiKey,{action:'keep'});
  assert.deepEqual(requests[3].body.update.apiKey,{action:'clear'});
  assert.equal(requests[4].body.id,'daily');
  assert.equal(requests[4].body.displayName,'新的显示名称');
  assert.equal(requests[5].body.revision,3);
});
function pending() {let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('Agent list create and stop keep native control shapes and user scope',async()=>{
  const requests:any[]=[];
  harness((command,args)=>{
    assert.equal(command,'builtin_request');requests.push(args.request);
    if(args.request.endpoint.endsWith('create_session'))return Promise.resolve({sessionId:'chat'});
    if(args.request.endpoint.endsWith('stop_chat'))return Promise.resolve(true);
    return Promise.resolve([{agentId:'model',agentName:'test',agentDesc:'text'}]);
  });
  assert.equal((await agentApi.list())[0].agentId,'model');
  assert.deepEqual(await agentApi.createSession('model'),{sessionId:'chat'});
  assert.equal(await agentApi.stopChat('model','chat'),true);
  assert.equal(requests[0].params.userId,'default');
  assert.deepEqual(requests[2].body,{agentId:'model',userId:'default',sessionId:'chat'});
});
test('Channel emits text and done preserving Unicode whitespace and literal code',async()=>{
  const received:AgentStreamEvent[]=[];const commands:string[]=[];
  harness((command,args)=>{
    commands.push(command);
    if(command==='builtin_agent_subscribe') {
      assert.equal(args.backendUrl,identity);assert.deepEqual(args.request,body);
      args.onEvent.onmessage({sequence:1,payload:{event:'text',content:'汉🙂 "quote"'}});
      args.onEvent.onmessage({sequence:2,payload:{event:'text',content:' \\n'}});
      args.onEvent.onmessage({sequence:3,payload:{event:'done',content:'汉🙂 "quote" \\n'}});
    }
    return Promise.resolve();
  });
  await agentApi.chatStream(body,e=>received.push(e));
  assert.deepEqual(received,[{event:'text',content:'汉🙂 "quote"'},{event:'text',content:' \\n'},{event:'done',content:'汉🙂 "quote" \\n'}]);
  assert.equal(commands.filter(c=>c==='builtin_agent_ack').length,3);
});
test('Native completion without done cannot silently report success',async()=>{
  harness((command,args)=>{if(command==='builtin_agent_subscribe')args.onEvent.onmessage({sequence:1,payload:{event:'text',content:'partial'}});return Promise.resolve();});
  await assert.rejects(agentApi.chatStream(body,()=>{}),error=>error instanceof ChatRequestError&&error.code==='MODEL_INCOMPLETE');
});
test('Error events and native failures keep their codes and cancel subscription',async()=>{
  const received:AgentStreamEvent[]=[];let cancelled=false;
  harness((command,args)=>{
    if(command==='builtin_cancel')cancelled=true;
    if(command==='builtin_agent_subscribe')args.onEvent.onmessage({sequence:0,payload:{event:'error',content:'incomplete',code:'MODEL_INCOMPLETE'}});
    return Promise.resolve();
  });
  await assert.rejects(agentApi.chatStream(body,e=>received.push(e)),error=>error instanceof ChatRequestError&&error.code==='MODEL_INCOMPLETE');
  assert.equal(received[0].event,'error');assert.equal(cancelled,true);
  harness(command=>command==='builtin_agent_subscribe'?Promise.reject({message:'busy',code:'AGENT_BUSY',status:409}):Promise.resolve());
  await assert.rejects(agentApi.chatStream(body,()=>{}),error=>error instanceof ChatRequestError&&error.code==='AGENT_BUSY');
});
test('Abort signals cancel this stream and ignore late text',async()=>{
  const run=pending();let channel:any;let cancelId:string|undefined;let streamId:string|undefined;const received:AgentStreamEvent[]=[];
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe'){channel=args.onEvent;streamId=args.streamId;return run.promise;}
    if(command==='builtin_cancel')cancelId=args.requestId;
    return Promise.resolve();
  });
  const controller=new AbortController();const operation=agentApi.chatStream(body,e=>received.push(e),controller.signal);
  controller.abort();channel.onmessage({sequence:1,payload:{event:'text',content:'late'}});run.resolve();
  await assert.rejects(operation,{name:'AbortError'});assert.equal(cancelId,streamId);assert.deepEqual(received,[]);
});
test('Consumer failures cancel and acknowledge the frame so native cleanup is bounded',async()=>{
  const calls:string[]=[];
  harness((command,args)=>{calls.push(command);if(command==='builtin_agent_subscribe')args.onEvent.onmessage({sequence:1,payload:{event:'text',content:'hello'}});return Promise.resolve();});
  await assert.rejects(agentApi.chatStream(body,()=>{throw new Error('render failed');}),/render failed/);
  assert.ok(calls.includes('builtin_cancel'));assert.ok(calls.includes('builtin_agent_ack'));
});

test('Stable request IDs are forwarded independently of subscription IDs and targeted stops',async()=>{
  const subscriptions:any[]=[];let stop:any;
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe'){
      subscriptions.push(args);args.onEvent.onmessage({sequence:1,requestId:body.requestId,payload:{event:'done',content:'cached result'}});
    }
    if(command==='builtin_request'){stop=args.request.body;return Promise.resolve(false);}
    return Promise.resolve();
  });
  await agentApi.chatStream(body,()=>{});await agentApi.chatStream(body,()=>{});
  assert.equal(subscriptions[0].request.requestId,'turn-1');assert.equal(subscriptions[1].request.requestId,'turn-1');
  assert.notEqual(subscriptions[0].streamId,subscriptions[1].streamId);
  await agentApi.stopChat('model','chat',undefined,'turn-1');assert.equal(stop.requestId,'turn-1');
});
test('Duplicate frames do not render twice and gaps or mismatched turn IDs cancel the stream',async()=>{
  const received:AgentStreamEvent[]=[];
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe') {
      const frame={sequence:1,requestId:body.requestId,payload:{event:'text',content:'one'}};
      args.onEvent.onmessage(frame);args.onEvent.onmessage(frame);
      args.onEvent.onmessage({sequence:2,requestId:body.requestId,payload:{event:'done',content:'one'}});
    }
    return Promise.resolve();
  });
  await agentApi.chatStream(body,e=>received.push(e));assert.equal(received.length,2);
  for(const frame of [{sequence:2,requestId:body.requestId,payload:{event:'text',content:'gap'}},
    {sequence:1,requestId:'different',payload:{event:'text',content:'wrong turn'}},
    {sequence:0,requestId:body.requestId,payload:{event:'done',content:'invalid completion'}}]) {
    harness((command,args)=>{if(command==='builtin_agent_subscribe')args.onEvent.onmessage(frame);return Promise.resolve();});
    await assert.rejects(agentApi.chatStream(body,()=>{}),e=>e instanceof ChatRequestError&&e.code==='MODEL_PROTOCOL_FAILED');
  }
});
test('Callbacks arriving after invoke settlement cannot update a previous conversation',async()=>{
  let channel:any;const events:AgentStreamEvent[]=[];
  harness((command,args)=>{if(command==='builtin_agent_subscribe')channel=args.onEvent;return Promise.resolve();});
  await assert.rejects(agentApi.chatStream(body,e=>events.push(e)),e=>e instanceof ChatRequestError&&e.code==='MODEL_INCOMPLETE');
  channel.onmessage({sequence:1,payload:{event:'text',content:'late'}});assert.deepEqual(events,[]);
});
test('Native history and event pagination retain user and Agent ownership scope',async()=>{
  const scopes:any[]=[];
  harness((command,args)=>{assert.equal(command,'builtin_request');scopes.push(args.request);return Promise.resolve([]);});
  await agentApi.history('model','chat',12);await agentApi.sessions('model','older');await agentApi.events('model','chat',5);
  assert.equal(scopes[0].endpoint,'agent/chat_history');assert.equal(scopes[0].params.after,'12');
  assert.equal(scopes[1].params.after,'older');assert.equal(scopes[2].params.after,'5');
  for(const item of scopes){assert.equal(item.params.userId,'default');assert.equal(item.params.agentId,'model');}
});

test('Cached native done preserves JSON replies and native text preserves code that resembles old traces',async()=>{
  const jsonReply='{"content":"literal JSON","path":"C:\\\\files"}';
  const code='Function Call: FunctionCall{ example code }';
  const events:AgentStreamEvent[]=[];
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe') {
      args.onEvent.onmessage({sequence:1,requestId:body.requestId,payload:{event:'text',content:code}});
      args.onEvent.onmessage({sequence:2,requestId:body.requestId,payload:{event:'done',content:jsonReply}});
    }
    return Promise.resolve();
  });
  await agentApi.chatStream(body,e=>events.push(e));
  assert.deepEqual(events,[{event:'text',content:code},{event:'done',content:jsonReply}]);
});

test('Stopping one subscription leaves a sibling session active and ignores old late callbacks',async()=>{
  const runs=new Map<string,ReturnType<typeof pending>>();
  const subscriptions=new Map<string,any>();const cancellations:string[]=[];
  const firstEvents:AgentStreamEvent[]=[];const secondEvents:AgentStreamEvent[]=[];
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe'){
      const run=pending();runs.set(args.request.requestId,run);subscriptions.set(args.request.requestId,args);
      return run.promise;
    }
    if(command==='builtin_cancel')cancellations.push(args.requestId);
    return Promise.resolve();
  });
  const abort=new AbortController();
  const first=agentApi.chatStream({...body,requestId:'first'},e=>firstEvents.push(e),abort.signal);
  const firstSettled=assert.rejects(first,{name:'AbortError'});
  const second=agentApi.chatStream({...body,requestId:'second',sessionId:'sibling'},e=>secondEvents.push(e));
  abort.abort();
  subscriptions.get('first').onEvent.onmessage({sequence:1,requestId:'first',payload:{event:'done',content:'late old reply'}});
  const sibling=subscriptions.get('second');
  sibling.onEvent.onmessage({sequence:1,requestId:'second',payload:{event:'text',content:'sibling reply'}});
  sibling.onEvent.onmessage({sequence:2,requestId:'second',payload:{event:'done',content:'sibling reply'}});
  runs.get('first')!.resolve();runs.get('second')!.resolve();
  await firstSettled;await second;
  assert.deepEqual(firstEvents,[]);
  assert.deepEqual(secondEvents,[{event:'text',content:'sibling reply'},{event:'done',content:'sibling reply'}]);
  assert.deepEqual(cancellations,[subscriptions.get('first').streamId]);
});

test('A completion that wins a targeted stop stays completed and the next request has its own ID',async()=>{
  const requests:string[]=[];const received:AgentStreamEvent[]=[];
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe'){
      requests.push(args.request.requestId);
      args.onEvent.onmessage({sequence:1,requestId:args.request.requestId,payload:{event:'done',content:'committed reply'}});
    }
    if(command==='builtin_request'){
      assert.equal(args.request.endpoint,'agent/stop_chat');
      assert.equal(args.request.body.requestId,'completed');
      return Promise.resolve(false);
    }
    return Promise.resolve();
  });
  const completed=agentApi.chatStream({...body,requestId:'completed'},e=>received.push(e));
  assert.equal(await agentApi.stopChat('model','chat',undefined,'completed'),false);
  await completed;
  await agentApi.chatStream({...body,requestId:'explicit-next'},()=>{});
  assert.deepEqual(received,[{event:'done',content:'committed reply'}]);
  assert.deepEqual(requests,['completed','explicit-next']);
});

test('Protocol failure after text retains only partial events and rejects a late success marker',async()=>{
  const received:AgentStreamEvent[]=[];let channel:any;let cancelled=0;
  harness((command,args)=>{
    if(command==='builtin_cancel')cancelled++;
    if(command==='builtin_agent_subscribe'){
      channel=args.onEvent;
      channel.onmessage({sequence:1,requestId:body.requestId,payload:{event:'text',content:'partial evidence'}});
      channel.onmessage({sequence:0,requestId:body.requestId,payload:{event:'error',content:'模型协议无效',code:'MODEL_PROTOCOL_FAILED'}});
      channel.onmessage({sequence:2,requestId:body.requestId,payload:{event:'done',content:'incorrect success'}});
    }
    return Promise.resolve();
  });
  await assert.rejects(agentApi.chatStream(body,e=>received.push(e)),e=>e instanceof ChatRequestError&&e.code==='MODEL_PROTOCOL_FAILED');
  channel.onmessage({sequence:3,requestId:body.requestId,payload:{event:'text',content:'late'}});
  assert.deepEqual(received,[{event:'text',content:'partial evidence'},{event:'error',content:'模型协议无效',code:'MODEL_PROTOCOL_FAILED'}]);
  assert.equal(cancelled,1);
});

test('对话范围使用原生用户/模型/根会话隔离接口，不传客户端身份或授权', async()=>{
  const calls:any[]=[];
  harness((command,args)=>{assert.equal(command,'builtin_request');calls.push(args.request);return Promise.resolve(args.request.method==='GET'?[]:{id:'server-a'});});
  await agentApi.scopes('model','root');
  await agentApi.serverScope('model','root','pty-a');
  await agentApi.serverScope('model','root','pty-a',true);
  assert.equal(calls[0].endpoint,'agent/scopes');
  assert.deepEqual(calls[0].params,{agentId:'model',userId:'default',rootId:'root'});
  assert.deepEqual(calls[1].body,{agentId:'model',userId:'default',rootId:'root',terminalSessionId:'pty-a',newTask:false});
  assert.equal(calls[2].body.newTask,true);
  assert.ok(calls.every(call=>!('identity' in (call.body??{})) && !('approvals' in (call.body??{}))));
});

test('Projects and cross-model persistent sidebar use owner-scoped IPC without HTTP',async()=>{
 const requests:any[]=[];
 harness((command,args)=>{assert.equal(command,'builtin_request');requests.push(args.request);return Promise.resolve([]);});
 await agentApi.projects();await agentApi.createProject('A','conn-a');
 await agentApi.projectChats('project-a','history-cursor');await agentApi.projectChats();
 await agentApi.projectTerminal('project-a','reconnected-pty');
 await agentApi.projectChat('project-a','model-b','reconnected-pty');
 assert.deepEqual(requests.map(r=>r.endpoint),['agent/projects','agent/create_project','agent/project_chats','agent/project_chats','agent/project_terminal','agent/project_chat']);
 assert.ok(requests.every(r=>(r.body?.userId??r.params.userId)==='default'));
 assert.equal(requests[2].params.after,'history-cursor');assert.equal(requests[3].params.projectId,'');
 assert.equal(requests[4].body.terminalSessionId,'reconnected-pty');assert.equal(requests[5].body.agentId,'model-b');
});

test('C5 context frames use request-scoped sequence and ACK without changing reply text',async()=>{
  const status={requestId:'turn-1',usage:{inputTokens:512,availableInputTokens:6656,contextWindow:8192,outputReserve:1024,safetyReserve:512,compactPercent:75,source:'estimated'},phase:'idle',method:null,errorCode:null,fallback:false,checkpointId:null,compactionCount:0,updatedAt:1};
  const received:AgentStreamEvent[]=[];let acknowledgements=0;
  harness((command,args)=>{
    if(command==='builtin_agent_ack')acknowledgements++;
    if(command==='builtin_agent_subscribe'){
      args.onEvent.onmessage({sequence:1,requestId:'turn-1',payload:{event:'context',status}});
      args.onEvent.onmessage({sequence:2,requestId:'turn-1',payload:{event:'done',content:'answer'}});
    }
    return Promise.resolve();
  });
  await agentApi.chatStream(body,event=>received.push(event));
  assert.deepEqual(received,[{event:'context',status},{event:'done',content:'answer'}]);assert.equal(acknowledgements,2);
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe')args.onEvent.onmessage({sequence:1,payload:{event:'context',status:{...status,requestId:'wrong'}}});
    return Promise.resolve();
  });
  await assert.rejects(agentApi.chatStream(body,()=>{}),error=>error instanceof ChatRequestError&&error.code==='MODEL_PROTOCOL_FAILED');
});
test('D5 enabled turns keep native tools separate from model request parameters and ACK exact frames',async()=>{
  const received:AgentStreamEvent[]=[];const acks:number[]=[];
  harness((command,args)=>{
    if(command==='builtin_agent_subscribe'){
      assert.equal(args.executionEnabled,true);assert.equal(args.request.executionEnabled,undefined);
      const payloads=[{event:'tool_call',toolCallId:'call',toolName:'ssh_execute',command:'echo test',status:'running'},
      {event:'tool_result',toolCallId:'call',status:'error',content:'{"ok":false,"error":"execution_failed","data":{"exitCode":7}}'},
      {event:'done',content:'命令失败，需要核查'}];
      payloads.forEach((payload,index)=>args.onEvent.onmessage({sequence:index+1,requestId:body.requestId,payload}));
    }if(command==='builtin_agent_ack')acks.push(args.sequence);return Promise.resolve();
  });
  await agentApi.chatStream({...body,executionEnabled:true},event=>received.push(event));assert.deepEqual(received.map(e=>e.event),['tool_call','tool_result','done']);assert.deepEqual(acks,[1,2,3]);
});
test('D5 human approval, binding and byte reads use owner/session scoped IPC only',async()=>{
  const requests:any[]=[];harness((command,args)=>{assert.equal(command,'builtin_request');requests.push(args.request);return Promise.resolve(true);});
  await agentApi.bindExecution('model','chat','terminal-a');await agentApi.executionRequests('model','chat');
  await agentApi.executionDecision('model','chat','approval','approveOnce');await agentApi.executionDecision('model','chat','approval','revoke');
  await agentApi.executionPolicy('model','chat');await agentApi.setExecutionPolicy('model','chat',{mode:'deny',revision:2});
  await agentApi.executionOutput('model','chat','output',65534);
  assert.ok(requests.every(r=>(r.body?.userId??r.params.userId)==='default'&&(r.body?.sessionId??r.params.sessionId)==='chat'));
  assert.equal(requests[0].body.terminalSessionId,'terminal-a');assert.equal(requests[5].body.revision,2);assert.equal(requests[6].params.offset,'65534');assert.equal(requests[6].params.limit,'4096');
});
test('D5 invalid native tool frames are rejected before rendering and cancel only their subscription',async()=>{
  let cancelled=false;harness((command,args)=>{if(command==='builtin_cancel')cancelled=true;if(command==='builtin_agent_subscribe')args.onEvent.onmessage({sequence:1,payload:{event:'tool_result',toolCallId:'x',status:'success',content:{fake:true}}});return Promise.resolve();});
  await assert.rejects(agentApi.chatStream({...body,executionEnabled:true},()=>assert.fail('invalid result must not render')),error=>error instanceof ChatRequestError&&error.code==='MODEL_PROTOCOL_FAILED');assert.equal(cancelled,true);
});
