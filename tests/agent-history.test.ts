import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAgentHistory, turnMessages } from '../src/state/agentHistory.ts';
import type { AgentHistory, AgentTurn } from '../src/api/agent.ts';
const session = { id:'s', agentId:'m', userId:'default', revision:1 };
const turn = (state: AgentTurn['state'], cursor = 1): AgentTurn => ({requestId:`r${cursor}`,message:'question',target:null,state,partialText:'partial',resultText:'完整回复',errorCode:null,usage:null,cursor,createdAt:1,updatedAt:2});
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
