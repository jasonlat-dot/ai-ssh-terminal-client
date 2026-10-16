import { sshUserId } from './ssh.ts';
import { ChatRequestError } from './chatErrors.ts';
import { builtinRequest, NativeRequestError } from './builtin';
import { Channel, invoke } from '@tauri-apps/api/core';
import { requireBackendUrl, isBuiltinEndpoint } from '../config/backend';
import { isTauriRuntime } from '../state/runtime';
import { isAgentContextStatus, type AgentContextStatus } from './agentContext';

export type AgentConfig = {
  agentId: string;
  agentName: string;
  modelName?: string;
  agentDesc: string;
  toolsAvailable?: boolean;
};

export type AgentToolStatus = 'running' | 'success' | 'error' | 'unknown';

export type AgentStreamEvent =
  | { event: 'input'; input: AgentSteer }
  | { event: 'context'; status: AgentContextStatus }
  | { event: 'text'; content: string }
  | { event: 'agent_start'; agentCallId: string; agentName: string; task: string; parentToolCallId?: string }
  | { event: 'agent_text'; agentCallId: string; sourceAgent?: string; content: string }
  | { event: 'agent_result'; agentCallId: string; agentName: string; content: string; status: AgentToolStatus }
  | { event: 'tool_call'; toolCallId: string; toolName: string; command?: string; status: AgentToolStatus; agentCallId?: string; sourceAgent?: string }
  | { event: 'tool_result'; toolCallId: string; toolName?: string; command?: string; content: string; status: AgentToolStatus; agentCallId?: string; sourceAgent?: string }
  | { event: 'done'; content: string }
  | { event: 'error'; content: string; code?: string };

export type AgentChatRequest = {
  requestId?: string;
  agentId: string;
  userId: string;
  sessionId: string;
  terminalSessionId: string;
  message: string;
  attachments?: { fileId: string }[];
  executionEnabled?: boolean;
};
export type AgentMemoryWrite={id:string;revision:number;title:string;content:string;kind:'preference'|'procedure';scope:'global'|'server';enabled:boolean};
export type AgentMemoryTarget={connectionId:string;identity:NonNullable<AgentScope['identity']>};
export type AgentMemory=AgentMemoryWrite&{target:AgentMemoryTarget|null;source:{kind:'userConfirmed';sessionId:string;agentId:string;projectId?:string};createdAt:number;updatedAt:number};
export type AgentMemories={target:AgentMemoryTarget|null;items:(AgentMemory&{applicable:boolean})[]};
export type AgentTurnState = 'running'|'completed'|'cancelled'|'failed'|'interrupted';
export type AgentProject = {id:string;name:string;connectionId:string;identity:AgentScope["identity"];profile?:{host:string;port:number;username:string}|null};
export type ProjectChat = {sessionId:string;agentId:string;title:string;createdAt:number;running?:boolean;awaitingApproval?:boolean};
export type ProjectChats = {items:ProjectChat[];nextAfter:string|null};
export type AgentScope = { rootId:string;kind:'general'|'server';connectionId:string|null;
  identity:{host:string;port:number;username:string;hostKey:string}|null;originTerminalId:string|null };
export type AgentSession = { scope?:AgentScope|null; id:string;agentId:string;userId:string;revision:number;task?:{
  id:string;goal:string;constraints:string[];target:{connectionId:string;terminalSessionId:string}|null;status:string;
}|null;checkpointId?:string|null };
export type AgentTurn = {
  inputs?: AgentSteer[];
  attachments?: {fileId:string;fileName:string;contentType:string;size:number;sha256:string;kind:string;pages:number|null;width:number|null;height:number|null}[];
  requestId:string;message:string;target:{connectionId:string;terminalSessionId:string}|null;state:AgentTurnState;
  partialText:string;resultText:string|null;errorCode:string|null;usage:{prompt_tokens:number;completion_tokens:number;total_tokens:number}|null;
  cursor:number;createdAt:number;updatedAt:number;
  toolEvents?: NativeToolEvent[];
};
export type AgentHistory = {session:AgentSession;turns:AgentTurn[];hasMore:boolean;nextAfter:number};

export type OutputReference={id:string;channel:'stdout'|'stderr';size:number;sha256:string};
export type NativeToolEvent={id:number;payload:{type:'toolCall';callId:string;toolName:string;arguments:{modelArguments?:unknown}}|{type:'toolResult';callId:string;outcome:'success'|'error'|'unknown'|'cancelled';exitCode:number|null;text:string;outputs?:OutputReference[]}};
export type ExecutionReceipt={id:string;callId:string;binding:{sessionId:string;tool:{taskId:string;target:{connectionId:string;terminalSessionId:string}};identity:{host:string;port:number;username:string;hostKey:string}};task:{id:string;goal:string;constraints:string[]};command:{command:string;timeoutSeconds:number;explanation?:string|null};state:'pending'|'approved'|'denied'|'cancelled'|'expired'|'admitted'|'completed'|'notSent'|'unknown';result:unknown;grant?:{expiresAt:number;revoked:boolean}|null;review?:ExecutionReview|null;createdAt:number;expiresAt:number};
export type ExecutionPolicy={mode:'confirm'|'auto'|'fullAccess'|'deny';revision:number};
export type ExecutionReview={mode:ExecutionPolicy['mode'];decision:string;risk:string;reason:string};
export type AgentSteer={id:string;message:string;eventId:number|null;createdAt:number};
export type OutputRange={bytes:number[];offset:number;nextOffset:number;eof:boolean;size:number;channel:'stdout'|'stderr'};

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

/** Local Rust Agent streaming. Model settings and the visible AI panel are gated until B4. */
async function chatStream(
  body: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new DOMException('对话已取消', 'AbortError');
  const backendUrl=requireBackendUrl();
  if (!isTauriRuntime() || !isBuiltinEndpoint(backendUrl)) throw new ChatRequestError('请在桌面应用内使用此功能。','DESKTOP_REQUIRED');
  const streamId=crypto.randomUUID();
  const {executionEnabled=true,...content}=body;
  const turnRequest={...content,requestId:body.requestId||crypto.randomUUID()};
  let done=false;
  let ended=false;
  let sequence=0;
  let failure:Error|undefined;
  const cancel=()=>{void invoke('builtin_cancel',{requestId:streamId}).catch(()=>undefined);};
  const channel=new Channel<{sequence:number;requestId?:string;payload:unknown}>();
  channel.onmessage=frame=> {
    try {
      if (ended || signal?.aborted || failure || done) return;
      if(frame.requestId!==undefined&&frame.requestId!==turnRequest.requestId) throw new ChatRequestError('对话输出关联不一致。','MODEL_PROTOCOL_FAILED');
      if(!Number.isSafeInteger(frame.sequence)||frame.sequence<0) throw new ChatRequestError('对话输出顺序无效。','MODEL_PROTOCOL_FAILED');
      if(frame.sequence>0) {
        if(frame.sequence<=sequence) return;
        if(frame.sequence!==sequence+1) throw new ChatRequestError('对话输出缺失，请查看历史后重试。','MODEL_PROTOCOL_FAILED');
        sequence=frame.sequence;
      }
      let event:AgentStreamEvent|null;
      const native=frame.payload&&typeof frame.payload==='object' ? frame.payload as Record<string,unknown> : undefined;
      if(native?.event==='input') {
        const input=native.input as AgentSteer|undefined;
        if(!input||typeof input.id!=='string'||!input.id||typeof input.message!=='string'||!Number.isSafeInteger(input.eventId)||typeof input.createdAt!=='number')throw new ChatRequestError('补充消息回执无效。','MODEL_PROTOCOL_FAILED');
        event={event:'input',input};
      } else if(native?.event==='context') {
        if(!isAgentContextStatus(native.status)||native.status.requestId!==turnRequest.requestId) throw new ChatRequestError('上下文状态格式或关联无效。','MODEL_PROTOCOL_FAILED');
        event={event:'context',status:native.status};
      } else if(native&&(native.event==='tool_call'||native.event==='tool_result')) {
        if(typeof native.toolCallId!=='string'||!native.toolCallId||!['running','success','error','unknown'].includes(String(native.status)))throw new ChatRequestError('工具事件格式无效。','MODEL_PROTOCOL_FAILED');
        if(native.event==='tool_call'&&(typeof native.toolName!=='string'||(native.command!==null&&native.command!==undefined&&typeof native.command!=='string')))throw new ChatRequestError('工具调用格式无效。','MODEL_PROTOCOL_FAILED');
        if(native.event==='tool_result'&&typeof native.content!=='string')throw new ChatRequestError('工具结果格式无效。','MODEL_PROTOCOL_FAILED');
        event=native as unknown as AgentStreamEvent;
      } else if(native&&(native.event==='text'||native.event==='done'||native.event==='error')) {
        if(typeof native.content!=='string'||(native.code!==undefined&&typeof native.code!=='string')) {
          throw new ChatRequestError('对话输出格式无效。','MODEL_PROTOCOL_FAILED');
        }
        // Rust events already contain raw model text. Do not decode JSON-looking replies again.
        event=native.event==='error' ? {event:'error',content:native.content,code:native.code as string|undefined}
          : {event:native.event,content:native.content};
      } else {
        event=parseStreamEvent(typeof frame.payload==='string' ? frame.payload : JSON.stringify(frame.payload));
      }
      if (!event) return;
      if(frame.sequence===0&&event.event!=='error') throw new ChatRequestError('对话结束事件无效。','MODEL_PROTOCOL_FAILED');
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
    await invoke('builtin_agent_subscribe',{backendUrl,streamId,request:turnRequest,executionEnabled,onEvent:channel});
    if (signal?.aborted) throw new DOMException('对话已取消','AbortError');
    if (failure) throw failure;
    if (!done) throw new ChatRequestError('模型流未完整结束，请核实后重试。','MODEL_INCOMPLETE');
  } catch (error) {
    if (signal?.aborted) throw new DOMException('对话已取消','AbortError');
    if (failure) throw failure;
    if (error instanceof ChatRequestError) throw error;
    const native=new NativeRequestError(error);
    throw new ChatRequestError(native.message,native.code);
  } finally {ended=true;signal?.removeEventListener('abort',cancel);}
}

export const agentApi = {
  steer:(agentId:string,sessionId:string,expectedRequestId:string,id:string,message:string)=>request<AgentSteer>('steer','POST',{agentId,sessionId,expectedRequestId,id,message,userId:sshUserId}),
  userId: sshUserId,
  list: (signal?: AbortSignal) => request<AgentConfig[]>('query_ai_agent_config_list', 'GET', undefined, signal, { userId: sshUserId }),
  createSession: (agentId: string, signal?: AbortSignal) => request<{ sessionId: string }>(
    'create_session', 'POST', { agentId, userId: sshUserId }, signal,
  ),
  serverScope: (agentId:string,rootId:string,terminalSessionId:string,newTask=false,signal?:AbortSignal) =>
    request<AgentSession>('server_scope','POST',{agentId,userId:sshUserId,rootId,terminalSessionId,newTask},signal),
  scopes: (agentId:string,rootId:string,signal?:AbortSignal) =>
    request<AgentSession[]>('scopes','GET',undefined,signal,{agentId,userId:sshUserId,rootId}),
  projects: () => request<AgentProject[]>('projects','GET',undefined,undefined,{userId:sshUserId}),
  createProject: (name:string,connectionId:string) => request<AgentProject>('create_project','POST',{name,connectionId,userId:sshUserId}),
  projectChats: (projectId='',after='') => request<ProjectChats>('project_chats','GET',undefined,undefined,{userId:sshUserId,projectId,after}),
  renameChat:(agentId:string,sessionId:string,title:string)=>request<void>('rename_chat','POST',{agentId,sessionId,title,userId:sshUserId}),
  deleteChat:(agentId:string,sessionId:string)=>request<void>('delete_chat','POST',{agentId,sessionId,userId:sshUserId}),
  deleteProject:(projectId:string)=>request<void>('delete_project','POST',{projectId,userId:sshUserId}),
  projectTerminal: (projectId:string,terminalSessionId:string) => request<AgentProject>('project_terminal','POST',{projectId,terminalSessionId,userId:sshUserId}),
  projectChat: (projectId:string,agentId:string,terminalSessionId:string) => request<AgentSession>('project_chat','POST',{projectId,agentId,terminalSessionId,userId:sshUserId}),
  stopChat: (agentId: string, sessionId: string, signal?: AbortSignal, requestId?:string) => request<boolean>(
    'stop_chat', 'POST', { agentId, userId: sshUserId, sessionId,...(requestId?{requestId}:{}) }, signal,
  ),
  history: (agentId:string,sessionId:string,after=0,signal?:AbortSignal) => request<AgentHistory>(
    'chat_history','GET',undefined,signal,{agentId,userId:sshUserId,sessionId,after:String(after)}),
  contextStatus: async(agentId:string,sessionId:string,signal?:AbortSignal):Promise<AgentContextStatus>=>{
    const status=await request<unknown>('context_status','GET',undefined,signal,{agentId,userId:sshUserId,sessionId});
    if(!isAgentContextStatus(status))throw new ChatRequestError('上下文状态格式无效。','MODEL_PROTOCOL_FAILED');
    return status;
  },
  sessions: (agentId:string,after='',signal?:AbortSignal) => request<AgentSession[]>(
    'session_list','GET',undefined,signal,{agentId,userId:sshUserId,after}),
  events: (agentId:string,sessionId:string,after=0,signal?:AbortSignal) => request<unknown[]>(
    'events','GET',undefined,signal,{agentId,userId:sshUserId,sessionId,after:String(after)}),
  bindExecution:(agentId:string,sessionId:string,terminalSessionId:string)=>request<AgentSession>('execution_bind','POST',{agentId,sessionId,terminalSessionId,userId:sshUserId}),
  executionRequests:(agentId:string,sessionId:string,after='',signal?:AbortSignal)=>request<ExecutionReceipt[]>('execution_requests','GET',undefined,signal,{agentId,sessionId,userId:sshUserId,after}),
  executionDecision:(agentId:string,sessionId:string,id:string,action:'approveOnce'|'approveTaskCommand'|'deny'|'cancel'|'revoke')=>request<boolean>('execution_decision','POST',{agentId,sessionId,id,action,userId:sshUserId}),
  executionPolicy:(agentId:string,sessionId:string)=>request<ExecutionPolicy>('execution_policy','GET',undefined,undefined,{agentId,sessionId,userId:sshUserId}),
  setExecutionPolicy:(agentId:string,sessionId:string,policy:ExecutionPolicy)=>request<ExecutionPolicy>('execution_policy','POST',{agentId,sessionId,userId:sshUserId,...policy}),
  executionOutput:(agentId:string,sessionId:string,outputId:string,offset=0)=>request<OutputRange>('execution_output','GET',undefined,undefined,{agentId,sessionId,userId:sshUserId,outputId,offset:String(offset),limit:'4096'}),
  attachment:(agentId:string,sessionId:string,fileId:string)=>request<{reference:{fileName:string;kind:string;pages:number|null;width:number|null;height:number|null};text:string|null;imageUrl:string|null}>('attachment','GET',undefined,undefined,{agentId,sessionId,fileId,userId:sshUserId}),
  memories:(agentId:string,sessionId:string,projectId?:string)=>request<AgentMemories>('memories','GET',undefined,undefined,{agentId,sessionId,userId:sshUserId,...(projectId?{projectId}:{})}),
  saveMemory:(agentId:string,sessionId:string,memory:AgentMemoryWrite,projectId?:string)=>request<AgentMemory>('memories','POST',{agentId,sessionId,userId:sshUserId,memory,...(projectId?{projectId}:{})}),
  deleteMemory:(agentId:string,sessionId:string,id:string,revision:number,projectId?:string)=>request<null>('memories','DELETE',{agentId,sessionId,userId:sshUserId,id,revision,...(projectId?{projectId}:{})}),
  chatStream,
};
