import assert from 'node:assert/strict';
import test from 'node:test';
import { activitySummary, isVisibleToolActivity, transcriptBlocks } from '../src/state/agentTranscript.ts';
import { turnMessages } from '../src/state/agentHistory.ts';
import { messageToMarkdown } from '../src/state/chatMarkdown.ts';
import type { ChatMessageSegment, ChatToolActivity } from '../src/types.ts';
import type { AgentTurn } from '../src/api/agent.ts';

const command = { id: 'command', name: 'ssh_execute', command: 'df -h', status: 'success', output: 'disk output' } satisfies ChatToolActivity;
function read(id: string, status: ChatToolActivity['status'] = 'success'): ChatToolActivity {
  return { id, name: 'read_tool_output', status, output: `saved output ${id}` };
}
const segment = (tool: ChatToolActivity): ChatMessageSegment => ({ id: tool.id, type: 'tool', tool });

test('Normal output paging disappears from transcript and counts without changing the original records', () => {
  const segments: ChatMessageSegment[] = [segment(command), ...Array.from({ length: 6 }, (_, i) => segment(read(`read-${i}`))), { id: 'answer', type: 'text', text: '磁盘空间充足。' }];
  const before = structuredClone(segments);
  const blocks = transcriptBlocks(segments);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'activities');
  if (blocks[0].type !== 'activities') assert.fail('command remains visible');
  assert.deepEqual(blocks[0].activities, [segment(command)]);
  assert.equal(activitySummary(segments.filter(item => item.type !== 'text')), '运行了 1 条命令');
  assert.deepEqual(segments, before);
  assert.ok(messageToMarkdown({ id: 'turn', role: 'assistant', text: '', segments }).includes('saved output read-5'));
});

test('Successful and running reads alone create no empty transcript or running command count', () => {
  const activities = [segment(read('finished')), segment(read('paging', 'running'))];
  assert.deepEqual(transcriptBlocks(activities), []);
  assert.equal(activitySummary(activities.filter(item => item.type !== 'text')), '');
  assert.equal(isVisibleToolActivity(read('paging', 'running')), false);
});

test('Failed and uncertain output reads remain visible as output issues', () => {
  const activities = [segment(command), segment(read('ok')), segment(read('failed', 'error')), segment(read('uncertain', 'unknown'))];
  const blocks = transcriptBlocks(activities);
  assert.equal(blocks[0].type, 'activities');
  if (blocks[0].type !== 'activities') assert.fail('activities remain');
  assert.deepEqual(blocks[0].activities.map(item => item.id), ['command', 'failed', 'uncertain']);
  assert.equal(activitySummary(blocks[0].activities), '运行了 1 条命令，2 项输出读取异常 · 1 项失败 · 1 项结果未知');
});

test('Reloaded history preserves all tool evidence while applying the same display rule', () => {
  const turn = { requestId: 'turn', state: 'completed', message: '检查磁盘', resultText: 'done', partialText: '', createdAt: 1, updatedAt: 2,
    toolEvents: [
      { payload: { type: 'toolCall', callId: 'ok', toolName: 'read_tool_output', arguments: {} } },
      { payload: { type: 'toolResult', callId: 'ok', outcome: 'success', text: 'saved output ok' } },
      { payload: { type: 'toolCall', callId: 'failed', toolName: 'read_tool_output', arguments: {} } },
      { payload: { type: 'toolResult', callId: 'failed', outcome: 'failure', text: 'output_unavailable' } },
    ],
  } as unknown as AgentTurn;
  const message = turnMessages([turn])[1];
  assert.equal(message.segments?.length, 3);
  assert.ok(messageToMarkdown(message).includes('saved output ok'));
  const blocks = transcriptBlocks(message.segments!);
  if (blocks[0].type !== 'activities') assert.fail('failed read remains');
  assert.deepEqual(blocks[0].activities.map(item => item.id), ['failed']);
  assert.equal(blocks[1].type, 'text');
});
