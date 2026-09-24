import { invoke } from '@tauri-apps/api/core';
import type { ChatAgentActivity, ChatAgentSegment, ChatMessage, ChatMessageSegment, ChatToolActivity } from '../types';
import { isTauriRuntime } from './runtime';

const browserStorageKey = 'agent-ssh-chat-history-v1';

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

type BrowserChatSession = ClientChatScope & ClientChatSession & { messages: ChatMessage[] };

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

function readBrowserSessions(): BrowserChatSession[] {
  const stored = localStorage.getItem(browserStorageKey);
  if (!stored) return [];
  const value: unknown = JSON.parse(stored);
  if (!Array.isArray(value)) return [];
  return value.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const session = item as Partial<BrowserChatSession>;
    return typeof session.backendUrl === 'string'
      && typeof session.userId === 'string'
      && typeof session.agentId === 'string'
      && typeof session.sessionId === 'string'
      && typeof session.title === 'string'
      && typeof session.createdAt === 'number'
      && typeof session.updatedAt === 'number'
      && Array.isArray(session.messages);
  }) as BrowserChatSession[];
}

function sameSession(left: ClientChatScope, right: ClientChatScope): boolean {
  return left.backendUrl === right.backendUrl
    && left.userId === right.userId
    && left.agentId === right.agentId
    && left.sessionId === right.sessionId;
}

/**
 * Tauri 客户端写入磁盘 .cache/chat；纯 Vite 开发环境回退到 localStorage。
 * 两种方式都只保存在客户端，不会发送给后端历史查询接口。
 */
export async function saveClientChatSession(
  scope: ClientChatScope,
  title: string,
  messages: ChatMessage[],
): Promise<void> {
  if (!isTauriRuntime()) {
    const sessions = readBrowserSessions();
    const index = sessions.findIndex(session => sameSession(session, scope));
    const timestamp = Date.now();
    const stored: BrowserChatSession = {
      ...scope,
      title,
      messageCount: messages.length,
      createdAt: index >= 0 ? sessions[index].createdAt : timestamp,
      updatedAt: timestamp,
      messages,
    };
    if (index >= 0) sessions[index] = stored;
    else sessions.push(stored);
    localStorage.setItem(browserStorageKey, JSON.stringify(sessions));
    return;
  }
  await invoke('save_chat_session', { request: { ...scope, title, messages } });
}

export async function listClientChatSessions(scope: ClientChatListScope): Promise<ClientChatSession[]> {
  if (!isTauriRuntime()) {
    return readBrowserSessions()
      .filter(session => session.backendUrl === scope.backendUrl && session.userId === scope.userId && session.agentId === scope.agentId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ sessionId, title, messageCount, createdAt, updatedAt }) => ({ sessionId, title, messageCount, createdAt, updatedAt }));
  }
  return invoke<ClientChatSession[]>('list_chat_sessions', scope);
}

export async function loadClientChatSession(scope: ClientChatScope): Promise<ChatMessage[] | null> {
  const stored: unknown[] | null = isTauriRuntime()
    ? await invoke<unknown[] | null>('load_chat_session', { scope })
    : readBrowserSessions().find(session => sameSession(session, scope))?.messages ?? null;
  if (stored === null) return null;
  // 应用异常退出时，磁盘上可能留下 running 状态；重新打开后将其标记为未知，
  // 避免历史 UI 错误地显示仍在调用工具或执行子 Agent。
  return stored.filter(isChatMessage).map(message => ({
    ...message,
    tools: message.tools?.map(persistedTool),
    segments: message.segments?.map(persistedSegment),
  }));
}
