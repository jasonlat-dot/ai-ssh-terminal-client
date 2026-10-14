import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ensureProjectTerminal,restoreProjectConversation} from '../src/state/projectConversation.ts';
import type {AgentProject,ProjectChat} from '../src/api/agent.ts';
import type {Host,TerminalSession} from '../src/types.ts';
const identity={host:'127.0.0.1',port:22,username:'tester',hostKey:'SHA256:test'};
const project:AgentProject={id:'project-a',name:'A',connectionId:'A',identity};
const chat:ProjectChat={sessionId:'old-history',agentId:'original-model',title:'历史约束',createdAt:1};
const host={id:'A',address:'127.0.0.1',port:22,user:'tester'} as Host;
const terminal={id:'tab',terminalSessionId:'new-pty',kind:'ssh',connectionId:'A'} as TerminalSession;
test('Restart history click restores exact session/model before reconnect; never creates a new conversation',async()=>{
 const calls:string[]=[];
 assert.equal(await restoreProjectConversation(chat,project,{
  load:async(id,model)=>{calls.push('load:'+id+':'+model);return true;},
  selectProject:p=>calls.push('project:'+p?.id),
  connect:async p=>{calls.push('connect:'+p.id);},
  connectionFailed:()=>assert.fail('connection succeeds'),
 }),true);
 assert.deepEqual(calls,['load:old-history:original-model','project:project-a','connect:project-a']);
});
test('Offline reopen retains restored records; general chat does not connect any server',async()=>{
 let loaded=0,selected=0,failed=0,connected=0;
 const actions={load:async()=>{loaded++;return true;},selectProject:()=>{selected++;},
  connect:async()=>{connected++;throw new Error('offline');},connectionFailed:()=>{failed++;}};
 assert.equal(await restoreProjectConversation(chat,project,actions),true);
 assert.deepEqual([loaded,selected,failed,connected],[1,1,1,1]);
 await restoreProjectConversation(chat,null,actions);
 assert.deepEqual([loaded,selected,failed,connected],[2,2,1,1]);
});
test('A failed history load does not switch project or connect a different server',async()=>{
 assert.equal(await restoreProjectConversation(chat,project,{load:async()=>false,
  selectProject:()=>assert.fail(),connect:async()=>assert.fail(),connectionFailed:()=>assert.fail()}),false);
});
test('Existing live terminal is reused and checked natively; disconnected terminal is opened once',async()=>{
 let opens=0,binds=0;
 const actions={hosts:[host],find:()=>terminal,verify:async()=>true,
  open:async(id:string)=>{assert.equal(id,'A');opens++;return terminal;},
  bind:async(id:string,pty:string)=>{assert.equal(id,'project-a');assert.equal(pty,'new-pty');binds++;return project;}};
 await ensureProjectTerminal(project,actions);assert.deepEqual([opens,binds],[0,1]);
 await ensureProjectTerminal(project,{...actions,verify:async()=>false});assert.deepEqual([opens,binds],[1,2]);
});
test('Edited/deleted profile or wrong actual SSH identity cannot bind project history',async()=>{
 let opens=0;
 const actions={hosts:[{...host,address:'other-server'}],find:()=>undefined,verify:async()=>true,
  open:async()=>{opens++;return terminal;},bind:async()=>project};
 await assert.rejects(ensureProjectTerminal(project,actions),/与项目不同/);assert.equal(opens,0);
 await assert.rejects(ensureProjectTerminal(project,{...actions,hosts:[]}),/删除/);
 await assert.rejects(ensureProjectTerminal(project,{...actions,hosts:[host],bind:async()=>{throw new Error('wrong key');}}),/wrong key/);
 await assert.rejects(ensureProjectTerminal(project,{...actions,hosts:[host],open:async()=>undefined}),/历史已保留/);
});
