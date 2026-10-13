import { sshUserId } from './ssh.ts';
import { ChatRequestError } from './chatErrors.ts';
import { builtinRequest, NativeRequestError } from './builtin';
import { Channel, invoke } from '@tauri-apps/api/core';
import { requireBackendUrl, isBuiltinEndpoint } from '../config/backend';
import { isTauriRuntime } from '../state/runtime';

export type AgentConfig = {
  agentId: string;
  agentName: string;
  agentDesc: string;
};

export type AgentToolStatus = 'running' | 'success' | 'error' | 'unknown';

export type AgentStreamEvent =
  | { event: 'text'; content: string }
  | { event: 'agent_start'; agentCallId: string; agentName: string; task: string; parentToolCallId?: string }
  | { event: 'agent_text'; agentCallId: string; sourceAgent?: string; content: string }
  | { event: 'agent_result'; agentCallId: string; agentName: string; content: string; status: AgentToolStatus }
  | { event: 'tool_call'; toolCallId: string; toolName: string; command?: string; status: AgentToolStatus; agentCallId?: string; sourceAgent?: string }
  | { event: 'tool_result'; toolCallId: string; toolName?: string; command?: string; content: string; status: AgentToolStatus; agentCallId?: string; sourceAgent?: string }
  | { event: 'done'; content: string }
  | { event: 'error'; content: string; code?: string };

export type AgentChatRequest = {
  agentId: string;
  userId: string;
  sessionId: string;
  terminalSessionId: string;
  message: string;
  attachments?: { fileId: string }[];
};

/** Agent control operations also belong to the local Rust workspace. */
async function request<T>(endpoint: string, method = 'GET', body?: object, signal?: AbortSignal, params: Record<string, string> = {}): Promise<T> {
  try {
    return await builtinRequest<T>(`agent/${endpoint}`, method, body, params, signal);
  } catch (error) {
    if (error instanceof NativeRequestError) throw new ChatRequestError(error.message, error.code);
    throw error;
  }
}

function normalizeContent(content: unknown): string {
  // The transport record has already been JSON-decoded. Decoding a text delta
  // again would remove literal quotes or turn code such as "\\n" into a newline.
  return typeof content === 'string' ? content : content == null ? '' : String(content);
}

function isAdkToolTrace(content: string): boolean {
  return content.includes('Function Call: FunctionCall{')
    || content.includes('Function Response: FunctionResponse{');
}

function extractCommand(payload: Record<string, unknown>): string | undefined {
  const value = payload.command ?? payload.commend ?? payload.arguments ?? payload.toolArgs;
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

/**
 * 将后端的一条传输记录收敛为前端事件协议。
 * agentCallId 负责把子 Agent 文本/工具归到同一张卡片；toolCallId 负责把调用中状态
 * 更新为最终结果。缺少必要关联 ID 的嵌套事件会被丢弃，避免污染其他活动。
 */
export function parseStreamEvent(payload: string): AgentStreamEvent | null {
  const value = payload.trim();
  if (!payload || value === '[DONE]') return null;
  if (value.startsWith('错误:')) return { event: 'error', content: value.slice(3).trim() };

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return isAdkToolTrace(payload) ? null : { event: 'text', content: payload };
  }

  // Some compatible streams encode each delta as a JSON string rather than an
  // event object. Whitespace-only deltas are part of the Markdown too.
  if (typeof decoded === 'string') return isAdkToolTrace(decoded) ? null : { event: 'text', content: decoded };
  // A raw-text SSE token can also happen to be a JSON number, boolean or null.
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return { event: 'text', content: payload };
  const parsed = decoded as Record<string, unknown>;
  if (!parsed.event && typeof parsed.code === 'string' && parsed.code !== 'SUCCESS_0000') {
    return { event: 'error', content: normalizeContent(parsed.info) || '对话请求失败', code: parsed.code };
  }
  const event = String(parsed.event || 'text');
  const content = normalizeContent(parsed.content);
  if (event === 'agent_start') {
    const agentCallId = normalizeContent(parsed.agentCallId).trim();
    if (!agentCallId) return null;
    return {
      event, agentCallId,
      agentName: normalizeContent(parsed.agentName) || '子智能体',
      task: normalizeContent(parsed.task),
      parentToolCallId: normalizeContent(parsed.parentToolCallId) || undefined,
    };
  }
  if (event === 'agent_text') {
    const agentCallId = normalizeContent(parsed.agentCallId).trim();
    if (!agentCallId || !content) return null;
    return { event, agentCallId, sourceAgent: normalizeContent(parsed.sourceAgent) || undefined, content };
  }
  if (event === 'agent_result') {
    const agentCallId = normalizeContent(parsed.agentCallId).trim();
    if (!agentCallId) return null;
    return {
      event, agentCallId,
      agentName: normalizeContent(parsed.agentName) || '子智能体',
      content,
      status: parsed.status === 'success' || parsed.status === 'error' ? parsed.status : 'unknown',
    };
  }
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
      agentCallId: normalizeContent(parsed.agentCallId) || undefined,
      sourceAgent: normalizeContent(parsed.sourceAgent) || undefined,
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
      agentCallId: normalizeContent(parsed.agentCallId) || undefined,
      sourceAgent: normalizeContent(parsed.sourceAgent) || undefined,
    };
  }
  if (event === 'done') return { event, content: doneContent(parsed.content) };
  if (event === 'error') return { event, content, code: typeof parsed.code === 'string' ? parsed.code : undefined };
  if (event === 'text' && !isAdkToolTrace(content)) return { event, content };
  return null;
}

/** Local Rust Agent streaming. The UI remains gated until model settings and B3/B4 are ready. */
async function chatStream(
  body: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new DOMException('对话已取消', 'AbortError');
  const backendUrl=requireBackendUrl();
  if (!isTauriRuntime() || !isBuiltinEndpoint(backendUrl)) throw new ChatRequestError('请在桌面应用内使用此功能。','DESKTOP_REQUIRED');
  const streamId=crypto.randomUUID();
  let done=false;
  let failure:Error|undefined;
  const cancel=()=>{void invoke('builtin_cancel',{requestId:streamId}).catch(()=>undefined);};
  const channel=new Channel<{sequence:number;payload:unknown}>();
  channel.onmessage=frame=> {
    try {
      if (signal?.aborted || failure || done) return;
      const event=parseStreamEvent(typeof frame.payload==='string' ? frame.payload : JSON.stringify(frame.payload));
      if (!event) return;
      if (event.event==='error') {
        failure=new ChatRequestError(event.content||'Agent 对话失败',event.code); onEvent(event); cancel(); return;
      }
      onEvent(event);
      if (event.event==='done') done=true;
    } catch (error) {
      failure=error instanceof Error ? error : new Error(String(error)); cancel();
    } finally {
      if (frame.sequence>0) void invoke('builtin_agent_ack',{streamId,sequence:frame.sequence}).catch(()=>cancel());
    }
  };
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    await invoke('builtin_agent_subscribe',{backendUrl,streamId,request:body,onEvent:channel});
    if (signal?.aborted) throw new DOMException('对话已取消','AbortError');
    if (failure) throw failure;
    if (!done) throw new ChatRequestError('模型流未完整结束，请核实后重试。','MODEL_INCOMPLETE');
  } catch (error) {
    if (signal?.aborted) throw new DOMException('对话已取消','AbortError');
    if (failure) throw failure;
    if (error instanceof ChatRequestError) throw error;
    const native=new NativeRequestError(error);
    throw new ChatRequestError(native.message,native.code);
  } finally {signal?.removeEventListener('abort',cancel);}
}

export const agentApi = {
  userId: sshUserId,
  list: (signal?: AbortSignal) => request<AgentConfig[]>('query_ai_agent_config_list', 'GET', undefined, signal, { userId: sshUserId }),
  createSession: (agentId: string, signal?: AbortSignal) => request<{ sessionId: string }>(
    'create_session', 'POST', { agentId, userId: sshUserId }, signal,
  ),
  stopChat: (agentId: string, sessionId: string, signal?: AbortSignal) => request<boolean>(
    'stop_chat', 'POST', { agentId, userId: sshUserId, sessionId }, signal,
  ),
  chatStream,
};
