import type { AgentHistory, AgentTurn } from '../api/agent';
import type { ChatMessage } from '../types';

const states = { running: '仍在生成，可刷新历史或停止。', completed: '', cancelled: '已停止生成。', failed: '生成失败。', interrupted: '生成已中断，重新发送会开始新的请求。' };
export function turnMessages(turns: AgentTurn[]): ChatMessage[] {
  return turns.flatMap(turn => [
    { id: `${turn.requestId}:user`, role: 'user' as const, text: turn.message },
    { id: turn.requestId, role: 'assistant' as const,
      text: turn.state === 'completed' ? turn.resultText ?? '' : turn.partialText,
      summary: states[turn.state] || undefined,
      error: turn.state === 'failed' || turn.state === 'interrupted',
      errorCode: turn.errorCode ?? undefined },
  ]);
}
/** Bounded full history, never silently show the first page as the entire session. */
export async function readAgentHistory(read: (after: number) => Promise<AgentHistory>): Promise<AgentHistory> {
  let after = 0;
  let revision: number | undefined;
  const turns: AgentTurn[] = [];
  for (let page = 0; page < 20; page++) {
    const history = await read(after);
    if (revision !== undefined && history.session.revision !== revision) throw new Error('加载期间会话已更新，请刷新历史。');
    revision = history.session.revision;
    turns.push(...history.turns);
    if (!history.hasMore) return { ...history, turns };
    if (history.nextAfter <= after) throw new Error('历史分页游标未前进，请刷新重试。');
    after = history.nextAfter;
  }
  throw new Error('历史会话过长，未完整加载。');
}
