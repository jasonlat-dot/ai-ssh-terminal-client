import { sshUserId } from './ssh';

export type AgentConfig = {
  agentId: string;
  agentName: string;
  agentDesc: string;
};

export type AgentStreamEvent =
  | { event: 'text'; content: string; fullText?: string }
  | { event: 'tool_call'; toolCallId: string; toolName: string; command?: string; status: string }
  | { event: 'tool_result'; toolCallId: string; toolName?: string; command?: string; content: string; status: string }
  | { event: 'done'; content: string }
  | { event: 'error'; content: string };

export type AgentChatRequest = {
  agentId: string;
  userId: string;
  sessionId: string;
  terminalSessionId: string;
  message: string;
};

type ApiResponse<T> = { code: string; info?: string; data?: T };

// AgentController 当前映射为 /agent，可通过 .env.local 覆盖完整地址。
const baseUrl = (import.meta.env.VITE_AGENT_API_BASE_URL || 'http://localhost:8888/agent').replace(/\/$/, '');

async function request<T>(endpoint: string, method = 'GET', body?: object): Promise<T> {
  try {
    const response = await fetch(`${baseUrl}/${endpoint}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Agent 服务请求失败（HTTP ${response.status}）`);
    const result = await response.json() as ApiResponse<T>;
    if (result.code !== 'SUCCESS_0000') throw new Error(result.info || 'Agent 操作失败');
    return result.data as T;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('无法访问 Agent 服务，请检查后端地址和网络连接。');
    throw error;
  }
}

function normalizeContent(content: unknown): string {
  if (typeof content !== 'string') return content == null ? '' : String(content);
  if (content.startsWith('"') && content.endsWith('"')) {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // 保留无法解析的原始内容。
    }
  }
  return content;
}

function parseStreamEvent(payload: string): AgentStreamEvent | null {
  const value = payload.trim();
  if (!value || value === '[DONE]') return null;
  if (value.startsWith('错误:')) return { event: 'error', content: value.slice(3).trim() };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { event: 'text', content: value };
  }

  const event = String(parsed.event || 'text') as AgentStreamEvent['event'];
  const content = normalizeContent(parsed.content);
  if (event === 'tool_call') {
    const args = parsed.arguments && typeof parsed.arguments === 'object'
      ? parsed.arguments as Record<string, unknown>
      : undefined;
    return {
      event,
      toolCallId: String(parsed.toolCallId || crypto.randomUUID()),
      toolName: String(parsed.toolName || 'executeCommand'),
      command: normalizeContent(parsed.command ?? args?.command) || undefined,
      status: String(parsed.status || 'running'),
    };
  }
  if (event === 'tool_result') {
    return {
      event,
      toolCallId: String(parsed.toolCallId || ''),
      toolName: parsed.toolName ? String(parsed.toolName) : undefined,
      command: normalizeContent(parsed.command) || undefined,
      content,
      status: String(parsed.status || 'success'),
    };
  }
  if (event === 'done' || event === 'error') return { event, content };
  return { event: 'text', content, fullText: normalizeContent(parsed.fullText) || undefined };
}

async function chatStream(
  body: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat_stream`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException('对话已取消', 'AbortError');
    if (error instanceof TypeError) throw new Error('无法访问 Agent 服务，请检查后端地址和网络连接。');
    throw error;
  }

  if (!response.ok) throw new Error(`Agent 对话请求失败（HTTP ${response.status}）`);
  if (!response.body) throw new Error('浏览器未收到 Agent 流式响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sseData: string[] = [];

  const dispatch = (payload: string) => {
    const event = parseStreamEvent(payload);
    if (event) onEvent(event);
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      if (sseData.length) dispatch(sseData.join('\n'));
      sseData = [];
      return;
    }
    if (line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) return;
    if (line.startsWith('data:')) {
      sseData.push(line.slice(5).trimStart());
      return;
    }
    // 兼容旧版 Controller 直接按行输出 JSON 的格式。
    dispatch(line);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(processLine);
    if (done) break;
  }
  if (buffer) processLine(buffer);
  if (sseData.length) dispatch(sseData.join('\n'));
}

export const agentApi = {
  userId: sshUserId,
  list: () => request<AgentConfig[]>('query_ai_agent_config_list'),
  createSession: (agentId: string) => request<{ sessionId: string }>(
    'create_session', 'POST', { agentId, userId: sshUserId },
  ),
  chatStream,
};
