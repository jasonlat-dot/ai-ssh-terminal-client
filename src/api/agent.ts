import { sshUserId } from './ssh';

export type AgentConfig = {
  agentId: string;
  agentName: string;
  agentDesc: string;
};

export type AgentToolStatus = 'running' | 'success' | 'error' | 'unknown';

export type AgentStreamEvent =
  | { event: 'text'; content: string }
  | { event: 'tool_call'; toolCallId: string; toolName: string; command?: string; status: AgentToolStatus }
  | { event: 'tool_result'; toolCallId: string; toolName?: string; command?: string; content: string; status: AgentToolStatus }
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

function isAdkToolTrace(content: string): boolean {
  return content.includes('Function Call: FunctionCall{')
    || content.includes('Function Response: FunctionResponse{');
}

function extractCommand(payload: Record<string, unknown>): string | undefined {
  const value = payload.command ?? payload.commend ?? payload.arguments;
  if (typeof value === 'string') {
    if (!value.trim()) return undefined;
    try {
      const args = JSON.parse(value) as unknown;
      if (args && typeof args === 'object' && 'command' in args) {
        return normalizeContent(args.command) || undefined;
      }
    } catch {
      return value;
    }
    return value;
  }
  if (value && typeof value === 'object' && 'command' in value) {
    return normalizeContent(value.command) || undefined;
  }
  return undefined;
}

function doneContent(value: unknown): string {
  if (typeof value !== 'string') return normalizeContent(value);
  try {
    const result = JSON.parse(value) as unknown;
    if (result && typeof result === 'object' && 'content' in result) {
      const content = normalizeContent(result.content);
      return isAdkToolTrace(content) ? '' : content;
    }
  } catch {
    return value;
  }
  return value;
}

function parseStreamEvent(payload: string): AgentStreamEvent | null {
  const value = payload.trim();
  if (!value || value === '[DONE]') return null;
  if (value.startsWith('错误:')) return { event: 'error', content: value.slice(3).trim() };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return isAdkToolTrace(value) ? null : { event: 'text', content: value };
  }

  const event = String(parsed.event || 'text');
  const content = normalizeContent(parsed.content);
  if (event === 'tool_call') {
    const toolCallId = normalizeContent(parsed.toolCallId).trim();
    if (!toolCallId) return null;
    const status = parsed.status === 'success' || parsed.status === 'error'
      ? parsed.status : 'running';
    return {
      event,
      toolCallId,
      toolName: normalizeContent(parsed.toolName) || '工具',
      command: extractCommand(parsed),
      status,
    };
  }
  if (event === 'tool_result') {
    const toolCallId = normalizeContent(parsed.toolCallId).trim();
    if (!toolCallId) return null;
    return {
      event,
      toolCallId,
      toolName: normalizeContent(parsed.toolName) || undefined,
      command: extractCommand(parsed),
      content,
      status: parsed.status === 'success' || parsed.status === 'error'
        ? parsed.status : 'unknown',
    };
  }
  if (event === 'done') return { event, content: doneContent(parsed.content) };
  if (event === 'error') return { event, content };
  if (event === 'text' && !isAdkToolTrace(content)) return { event, content };
  return null;
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
    // 兼容 case 层按行输出 JSON 的格式。
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
