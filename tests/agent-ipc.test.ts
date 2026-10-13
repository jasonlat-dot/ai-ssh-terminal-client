import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { agentApi,type AgentStreamEvent } from '../src/api/agent.ts';
import { ChatRequestError } from '../src/api/chatErrors.ts';
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
