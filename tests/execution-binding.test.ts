import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSession } from '../src/api/agent.ts';
import type { TerminalSession } from '../src/types.ts';
import { executionTerminal, prepareExecutionBinding } from '../src/state/executionBinding.ts';

const session: AgentSession = {
  id:'chat-a', agentId:'model', userId:'default', revision:1,
  scope:{rootId:'root', kind:'server', connectionId:'a', originTerminalId:'old-a',
    identity:{host:'a.example',port:22,username:'tester',hostKey:'SHA256:trusted'}},
  task:{id:'old-task',goal:'检查服务',constraints:[],status:'active',target:{connectionId:'a',terminalSessionId:'old-a'}},
};
const terminal = (id:string, connected=true): TerminalSession => ({
  id, kind:'ssh', terminalSessionId:id, connectionId:'a', connected,
  connectionStatus:connected?'connected':'disconnected', manuallyClosed:false,
  host:{id:'a',name:'A',address:'a.example',port:22,user:'tester'},
} as TerminalSession);
const rebound = {...session, revision:2, task:{...session.task!,id:'new-task',target:{connectionId:'a',terminalSessionId:'new-a'}}};

test('a live execution target stays pinned when another terminal of the same server is open', () => {
  const original=terminal('old-a'), other=terminal('new-a');
  assert.equal(executionTerminal(session,[other,original],'old-a'),original);
});

test('disconnect then reconnect selects the new transport within the original server scope', async () => {
  const next=terminal('new-a');
  const selected=executionTerminal(session,[terminal('old-a',false),next],'old-a');
  assert.equal(selected,next);
  const calls:string[][]=[];
  assert.equal(await prepareExecutionBinding(session,selected,async(...args)=>{calls.push(args);return rebound;}),rebound);
  assert.deepEqual(calls,[['chat-a','new-a']]);
  assert.equal(rebound.id,session.id); // Same history; native binding creates a fresh task, not a conversation.
});

test('an unchanged active target reuses its task and does not rebind', async () => {
  assert.equal(await prepareExecutionBinding(session,terminal('old-a'),async()=>assert.fail('unexpected rebind')),session);
});

test('offline or another server cannot substitute for the saved tool target', async () => {
  const other={...terminal('other'),connectionId:'b'};
  assert.equal(executionTerminal(session,[terminal('old-a',false),other],'old-a'),undefined);
  await assert.rejects(prepareExecutionBinding(session,undefined,async()=>assert.fail()),/已断开/);
  await assert.rejects(prepareExecutionBinding(session,other,async()=>assert.fail()),/不一致/);
  const edited={...terminal('new-a'),host:{...terminal('new-a').host,address:'other.example'}};
  assert.equal(executionTerminal(session,[edited],'old-a'),undefined);
});

test('native host-key rejection or busy turn propagates without falling back or retrying', async () => {
  for (const code of ['AGENT_TARGET_MISMATCH','AGENT_CHAT_BUSY']) {
    let calls=0;
    await assert.rejects(prepareExecutionBinding(session,terminal('new-a'),async()=>{calls++;throw new Error(code);}),new RegExp(code));
    assert.equal(calls,1);
  }
});

test('a stale native response cannot be used as a successful rebind', async () => {
  await assert.rejects(prepareExecutionBinding(session,terminal('new-a'),async()=>session),/目标未确认/);
});
