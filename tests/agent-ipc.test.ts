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
const body={agentId:'model',userId:'default',sessionId:'chat',terminalSessionId:'',message:'hello'};
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
