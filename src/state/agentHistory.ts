import type { AgentHistoryMessage } from '../api/agent';
import type { ChatMessage, ChatToolActivity } from '../types';

function restoredTool(message: AgentHistoryMessage): ChatToolActivity {
  const content = message.content || '';
  let output = content;
  let command: string | undefined;
  let status: ChatToolActivity['status'] = 'unknown';
  try {
    const result = JSON.parse(content) as Record<string, unknown>;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (typeof result.command === 'string') command = result.command;
      if (typeof result.output === 'string') output = result.output;
      else if (typeof result.error === 'string') output = result.error;
      status = result.success === false || result.error ? 'error' : 'success';
    }
  } catch {
    // 旧消息可能直接保存命令输出，原文仍可展开查看。
  }
  return {
    id: message.toolCallId || `history-tool-${message.id}`,
    name: message.toolName || '工具', command, output, status,
  };
}

/** 数据库只保存 user/assistant/tool 消息；按原始顺序重建可阅读的对话和工具卡片。 */
export function restoreChatMessages(history: AgentHistoryMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of history) {
    const content = item.content || '';
    if (item.role === 'user') {
      messages.push({ id: `history-${item.id}`, role: 'user', text: content });
      continue;
    }
    if (item.role !== 'assistant' && item.role !== 'model' && item.role !== 'tool') continue;
    let assistant = messages[messages.length - 1];
    if (!assistant || assistant.role !== 'assistant') {
      assistant = { id: `history-assistant-${item.id}`, role: 'assistant', text: '', segments: [] };
      messages.push(assistant);
    }
    if (item.role === 'tool') {
      const tool = restoredTool(item);
      assistant.segments?.push({ id: `history-tool-${item.id}`, type: 'tool', tool });
    } else if (content) {
      assistant.text += content;
      assistant.segments?.push({ id: `history-text-${item.id}`, type: 'text', text: content });
    }
  }
  return messages;
}
