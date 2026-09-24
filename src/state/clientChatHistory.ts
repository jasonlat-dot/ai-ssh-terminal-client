import { invoke } from '@tauri-apps/api/core';
import type { ChatAgentActivity, ChatAgentSegment, ChatMessage, ChatMessageSegment, ChatToolActivity } from '../types';

export type ClientChatSession = {
  sessionId: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ClientChatScope = {
  backendUrl: string;
  userId: string;
  agentId: string;
  sessionId: string;
};

export type ClientChatListScope = Omit<ClientChatScope, 'sessionId'>;

function persistedTool(tool: ChatToolActivity): ChatToolActivity {
  return { ...tool, status: tool.status === 'running' ? 'unknown' : tool.status };
}

function persistedAgentSegment(segment: ChatAgentSegment): ChatAgentSegment {
  return segment.type === 'tool'
    ? { ...segment, tool: persistedTool(segment.tool) }
    : segment;
}

function persistedAgent(agent: ChatAgentActivity): ChatAgentActivity {
  return {
    ...agent,
    status: agent.status === 'running' ? 'unknown' : agent.status,
    tools: (agent.tools ?? []).map(persistedTool),
    segments: agent.segments?.map(persistedAgentSegment),
  };
}

function persistedSegment(segment: ChatMessageSegment): ChatMessageSegment {
  if (segment.type === 'tool') return { ...segment, tool: persistedTool(segment.tool) };
  if (segment.type === 'agent') return { ...segment, agent: persistedAgent(segment.agent) };
  return segment;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ChatMessage>;
  return typeof message.id === 'string'
    && (message.role === 'user' || message.role === 'assistant')
    && typeof message.text === 'string';
}

/**
 * 将桌面客户端历史写入 Tauri 应用数据目录。这里不使用 localStorage，
 * 因而历史不会受到 WebView 缓存清理影响，也不会发送给后端历史查询接口。
 */
export async function saveClientChatSession(
  scope: ClientChatScope,
  title: string,
  messages: ChatMessage[],
): Promise<void> {
  await invoke('save_chat_session', { request: { ...scope, title, messages } });
}

export async function listClientChatSessions(scope: ClientChatListScope): Promise<ClientChatSession[]> {
  return invoke<ClientChatSession[]>('list_chat_sessions', scope);
}

export async function loadClientChatSession(scope: ClientChatScope): Promise<ChatMessage[] | null> {
  const stored = await invoke<unknown[] | null>('load_chat_session', { scope });
  if (stored === null) return null;
  // 应用异常退出时，磁盘上可能留下 running 状态；重新打开后将其标记为未知，
  // 避免历史 UI 错误地显示仍在调用工具或执行子 Agent。
  return stored.filter(isChatMessage).map(message => ({
    ...message,
    tools: message.tools?.map(persistedTool),
    segments: message.segments?.map(persistedSegment),
  }));
}
