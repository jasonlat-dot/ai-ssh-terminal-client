import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAgentHistory, turnMessages } from '../src/state/agentHistory.ts';
import type { AgentHistory, AgentTurn } from '../src/api/agent.ts';
const session = { id:'s', agentId:'m', userId:'default', revision:1 };
const turn = (state: AgentTurn['state'], cursor = 1): AgentTurn => ({requestId:`r${cursor}`,message:'question',target:null,state,partialText:'partial',resultText:'完整回复',errorCode:null,usage:null,cursor,createdAt:1,updatedAt:2});

test('Running history shows only dispatched calls and completed results, keeping queued tools hidden',()=>{
  const t=turn('running');t.startedToolCallIds=['active'];t.toolEvents=[
    {id:1,payload:{type:'toolCall',callId:'active',toolName:'delegate_agent',arguments:{modelArguments:{task:'active child'}}}},
    {id:2,payload:{type:'toolCall',callId:'queued',toolName:'list_skills',arguments:{modelArguments:{}}}},
    {id:3,payload:{type:'toolCall',callId:'finished',toolName:'list_mcp_tools',arguments:{modelArguments:{server:''}}}},
    {id:4,payload:{type:'toolResult',callId:'finished',outcome:'success',exitCode:null,text:'{"ok":true,"data":{}}'}},
  ];
  const segments=turnMessages([t])[1].segments!;
  assert.deepEqual(segments.filter(s=>s.type!=='text').map(s=>s.id),['active','finished']);
  assert.ok(!segments.some(s=>s.id==='queued'));
  t.state='cancelled';assert.ok(turnMessages([t])[1].segments!.some(s=>s.id==='queued'), 'terminal history still retains original evidence');
});
test('Steered user inputs restore once and distinguish accepted but unapplied input',()=>{
  const t=turn('completed');t.inputs=[{id:'applied',message:'first input',eventId:3,createdAt:2},{id:'pending',message:'saved input',eventId:null,createdAt:3}];
  const messages=turnMessages([t]);assert.deepEqual(messages.map(m=>m.id),['r1:user','applied','pending','r1']);assert.equal(messages[1].inputPending,false);assert.equal(messages[2].inputPending,true);assert.equal(messages[3].text,'完整回复');
});
test('Restored turns distinguish complete output from failed cancelled running and interrupted partials', () => {
  for (const state of ['completed','failed','cancelled','running','interrupted'] as const) {
    const messages = turnMessages([turn(state)]);
    assert.equal(messages[0].text, 'question');
    assert.equal(messages[1].text, state === 'completed' ? '完整回复' : 'partial');
    assert.equal(!!messages[1].summary, state !== 'completed');
    assert.equal(messages[1].error, state === 'failed' || state === 'interrupted');
  }
});
test('Canonical history reads all pages and retains the final session target', async () => {
  const cursors: number[] = [];
  const target = {connectionId:'host-a',terminalSessionId:'ssh-a'};
  const history = await readAgentHistory(async after => { cursors.push(after); return {session:{...session,task:{id:'task',goal:'question',constraints:[],status:'active',target}},turns:[turn('completed', after+1)],hasMore:after===0,nextAfter:after+1}; });
  assert.deepEqual(cursors,[0,1]); assert.equal(history.turns.length,2);
  assert.deepEqual(history.session.task?.target,target);
});
test('Broken or excessive history pagination fails instead of silently truncating', async () => {
  const page: AgentHistory = {session,turns:[],hasMore:true,nextAfter:0};
  await assert.rejects(readAgentHistory(async () => page), /游标/);
  await assert.rejects(readAgentHistory(async after => ({...page,nextAfter:after+1})), /未完整加载/);
});
test('A context revision change during pagination cannot combine different snapshots', async () => {
  await assert.rejects(readAgentHistory(async after => ({session:{...session,revision:after+1},turns:[turn('completed',after+1)],hasMore:after===0,nextAfter:after+1})), /会话已更新/);
});

test('D5 restored tool records retain paired failure and unknown output references without claiming success',()=>{
  const t=turn('interrupted');t.toolEvents=[{id:2,payload:{type:'toolCall',callId:'a',toolName:'ssh_execute',arguments:{modelArguments:{command:'check'}}}},
    {id:3,payload:{type:'toolResult',callId:'a',outcome:'error',exitCode:7,text:'{"ok":false,"error":"execution_failed","data":{"exitCode":7,"outputs":[{"id":"output","channel":"stderr","size":12,"sha256":"hash"}]}}'}},
    {id:4,payload:{type:'toolCall',callId:'b',toolName:'ssh_execute',arguments:{modelArguments:'{"command":"next"}'}}}];
  const assistant=turnMessages([t])[1];const segments=assistant.segments!;
  assert.equal(segments[0].type,'tool');if(segments[0].type==='tool'){assert.equal(segments[0].tool.status,'error');assert.match(segments[0].tool.output!,/output/);assert.equal(segments[0].tool.command,'check');}
  assert.equal(segments[1].type,'tool');if(segments[1].type==='tool'){assert.equal(segments[1].tool.status,'unknown');assert.equal(segments[1].tool.command,'next');}
});

test('Native history restores attachment references without inline media or session substitution',()=>{
 const t=turn('completed');t.attachments=[{fileId:'immutable-file',fileName:'manual.pdf',size:100,contentType:'application/pdf',sha256:'digest',kind:'pdfText',pages:2,width:null,height:null}];
 const [message]=turnMessages([t]);assert.equal(message.attachments?.[0].fileId,'immutable-file');assert.equal(message.attachments?.[0].fileName,'manual.pdf');assert.equal(message.attachments?.[0].previewUrl,undefined);
});


test('E3 restored child workflow nests original tool records under its parent and preserves failures',()=>{
  const t=turn('completed');t.toolEvents=[
    {id:2,payload:{type:'toolCall',callId:'parent',toolName:'delegate_agent',arguments:{modelArguments:{task:'inspect'}}}},
    {id:3,payload:{type:'toolCall',callId:'child',toolName:'call_mcp_tool',arguments:{parentToolCallId:'parent',modelArguments:{server:'demo'}}}},
    {id:4,payload:{type:'toolResult',callId:'child',outcome:'error',exitCode:null,text:'{"ok":false,"error":"denied"}'}},
    {id:5,payload:{type:'toolResult',callId:'parent',outcome:'success',exitCode:null,text:'{"ok":true,"data":{"report":"No operation was approved."}}'}},
  ];
  const segments=turnMessages([t])[1].segments!;
  assert.equal(segments[0].type,'agent');
  if(segments[0].type!=='agent')assert.fail();
  assert.equal(segments[0].agent.output,'No operation was approved.');
  assert.equal(segments[0].agent.task,'inspect');
  assert.equal(segments[0].agent.tools.length,1);
  assert.equal(segments[0].agent.tools[0].status,'error');
  assert.equal(segments.filter(s=>s.type==='tool').length,0);
});


test('Failure detail and request trace survive native history without joining partial reply text',()=>{
 const t=turn('failed');t.errorCode='MODEL_HTTP_ERROR';t.errorMessage='Model provider returned HTTP 400';
 const assistant=turnMessages([t])[1];
 assert.equal(assistant.errorMessage,t.errorMessage);assert.equal(assistant.errorCode,t.errorCode);
 assert.equal(assistant.id,t.requestId);assert.equal(assistant.text,'partial');
 assert.ok(!assistant.text.includes('HTTP 400'));assert.equal(assistant.errorLocalOnly,undefined);
});
