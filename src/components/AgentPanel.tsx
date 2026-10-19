import { useToastError, useErrorToast } from '../state/useToastError';
import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent, Ref, ReactNode, HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownMessage } from './MarkdownMessage';
import agentRobotAvatar from '../assets/agent-robot-avatar.png';
import { AgentEmptyState } from './AgentEmptyState';
import type { ClientChatSession } from '../state/clientChatHistory';
import type { AgentConfig, AgentProject } from '../api/agent';
import type { AgentContextStatus as ContextStatus } from '../api/agentContext';
import { AgentContextStatus } from './AgentContextStatus';
import type { ManualCompactionControl } from './AgentContextStatus';
import { AgentMemoryButton,type MemoryScope } from './AgentMemory';
import type { ChatAttachment, ChatAgentActivity, ChatMessage, ChatToolActivity, ChatTextExcerpt, Host } from '../types';
import { AccentIcon, Badge, Icon } from './Ui';
import { CopyMarkdownButton } from './CopyMarkdownButton';
import { CopyTextButton } from './CopyTextButton';
import { Select } from './Select';
import { ComposerProjectPicker } from './ComposerProjectPicker';
import { ComposerReasoningControl } from './ComposerReasoningControl';
import { ChatAttachmentDraft, chatAttachmentPolicy, isLongChatText, pastedFiles, insertPastedText, validateChatContent } from '../state/chatAttachments';
import { DraftAttachments, MessageAttachments } from './ChatAttachments';
import { type NativeAttachmentProgress, pickNativeAttachments, pasteNativeAttachments } from '../api/files';
import { chatErrorGuidance } from '../api/chatErrors';
import { AgentExecution, ExecutionContext, NativeToolOutput, type ExecutionScope } from './AgentExecution';
import { agentToMarkdown, messageToMarkdown, toolToMarkdown } from '../state/chatMarkdown';
import { messageTime } from '../state/messageTime';
import { transcriptBlocks, activitySummary, type ActivitySegment } from '../state/agentTranscript';

function AgentAvatar({ compact = false }: { compact?: boolean }) {
  return <span className={`agent-avatar ${compact ? 'compact' : ''}`}><img src={agentRobotAvatar} alt="Agent 机器人" /></span>;
}

type TimeHint = Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter'|'onMouseLeave'|'onFocus'|'onBlur'|'aria-describedby'>;
function MessageTime({ timestamp, now, hint }: { timestamp?: number; now: number; hint:(text:string)=>TimeHint }) {
  const value = messageTime(timestamp, now);
  if (!value) return null;
  return <time className="chat-message-time" dateTime={value.iso} tabIndex={0} {...hint(value.full)}>{value.label}</time>;
}

function ToolActivity({ tool, copyable }: { tool: ChatToolActivity; copyable: boolean }) {
  const label = tool.status === 'running' ? '运行中'
    : tool.status === 'success' ? '已运行'
      : tool.status === 'error' ? '运行失败' : '结果未知';
  const title = tool.name === 'executeCommand' || tool.name === 'ssh_execute' ? '执行命令' : tool.name === 'read_tool_output' ? '回查工具输出' : ({list_skills:'发现 Skills',read_skill:'读取 Skill',list_mcp_tools:'发现 MCP 工具',call_mcp_tool:'调用 MCP 工具',update_plan:'更新任务计划',delegate_agent:'委派子任务'} as Record<string,string>)[tool.name] ?? tool.name;
  const header = <>
    <Icon name="terminal" size={14} />
    <span className="tool-run-label">{label}</span>
    <span className="tool-identity"><code title={tool.command || title}>{tool.command || title}</code></span>
    <Icon name="down" size={13} className="tool-disclosure" />
  </>;

  return <details className={`tool-activity ${tool.status}`} aria-label={`${title}：${label}`}>
    <summary>{header}</summary>
    <div className="tool-terminal-body"><div className="tool-terminal-heading"><span>{title === '执行命令' ? 'Shell' : title}</span>{copyable&&tool.command&&<CopyTextButton getText={()=>tool.command!} label="复制命令" iconOnly/>}</div>
    {tool.command&&<pre className="tool-full-command" tabIndex={0}>$ {tool.command}</pre>}
    {tool.output ? <NativeToolOutput output={tool.output}/> : <p className="tool-empty-result">{tool.status==='running'?'等待命令输出与退出状态…':'工具没有返回文本。'}</p>}
    {copyable && <div className="message-copy-actions tool-copy-actions">
      {tool.command && <CopyTextButton getText={() => tool.command!} label="复制命令" successMessage="命令已复制" />}
      {tool.output && <CopyTextButton getText={() => tool.output!} label="复制输出" successMessage="执行结果已复制" />}
      <CopyMarkdownButton getText={() => toolToMarkdown(tool)} label="复制工具结果（Markdown）" />
    </div>}</div>
  </details>;
}

function messageRailPreview(message: ChatMessage, messages: ChatMessage[], index: number) {
  const segment = message.segments?.find(item => item.type === 'text');
  const response = message.role === 'user' ? messages.slice(index + 1).find(item => item.role === 'assistant') : message;
  const title = message.role === 'user' ? message.text : message.text || message.summary || (segment?.type === 'text' ? segment.text : '') || message.tools?.[0]?.command || '工具执行记录';
  const responseSegment = response?.segments?.find(item => item.type === 'text');
  const summary = response && response !== message
    ? response.text || response.summary || (responseSegment?.type === 'text' ? responseSegment.text : '') || '正在生成…'
    : message.summary || '';
  return { title: title.replace(/\s+/g, ' ').trim().slice(0, 96) || '空消息', summary: summary.replace(/\s+/g, ' ').trim().slice(0, 150) };
}

function ActivityTranscript({activities,copyable}:{activities:ActivitySegment[];copyable:boolean}) {
  const hasRunning=activities.some(item=>(item.type==='tool'?item.tool:item.agent).status==='running');
  const hasIssue=activities.some(item=>['error','unknown'].includes((item.type==='tool'?item.tool:item.agent).status));
  return <details className={`activity-transcript${hasRunning?' is-running':''}${hasIssue?' has-issue':''}`}>
    <summary><Icon name="terminal" size={14}/><span>{activitySummary(activities)}</span><Icon name="right" size={13} className="activity-transcript-chevron"/></summary>
    <div className="activity-transcript-list" role="region" aria-label="执行过程" tabIndex={0}>
      {activities.map(item=>item.type==='tool'?<ToolActivity tool={item.tool} copyable={copyable} key={item.id}/>:<AgentActivity agent={item.agent} copyable={copyable} key={item.id}/>)}
    </div>
  </details>;
}

function AgentTextActivity({ text, running, copyable }: { text: string; running: boolean; copyable: boolean }) {
  return <details className="agent-activity-thought">
    <summary>
      <AccentIcon icon="bulb" tone="amber" size={15} className="activity-kind-icon" />
      <span>{running ? '分析中' : '已分析'}</span>
      <small className="agent-activity-thought-open-label">查看文字</small>
      <small className="agent-activity-thought-close-label">收起文字</small>
      <Icon name="down" size={14} className="agent-activity-thought-chevron" />
    </summary>
    <div className="agent-activity-text"><MarkdownMessage streaming={running || !copyable}>{text}</MarkdownMessage></div>
    {copyable && !running && <div className="message-copy-actions"><CopyMarkdownButton getText={() => text} /></div>}
  </details>;
}

function AgentActivity({ agent, copyable }: { agent: ChatAgentActivity; copyable: boolean }) {
  const canCopy = copyable && agent.status !== 'running';
  // 子 Agent 的流式文本和工具结果持续更新数据，但只在用户主动展开后渲染。
  // 状态从 running 变为 success/error 时保留用户的展开选择，不自动开合。
  const [expanded, setExpanded] = useState(false);
  const label = agent.status === 'running' ? '执行中'
    : agent.status === 'success' ? '已完成'
      : agent.status === 'error' ? '失败' : '状态未知';
  const hasStreamedText = agent.segments?.some(segment => segment.type === 'text' && segment.text.trim()) ?? false;
  const streamedText = agent.segments?.filter(segment => segment.type === 'text').map(segment => segment.text).join('') ?? '';
  const showFinalFallback = Boolean(agent.output && (!hasStreamedText || (agent.status === 'error' && !streamedText.includes(agent.output))));
  return <section className={`agent-activity ${agent.status} ${expanded ? 'expanded' : 'collapsed'}`} aria-label={`子智能体 ${agent.name}：${label}`}>
    <button type="button" className="agent-activity-header" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <AccentIcon icon="bot" size={16} className="activity-kind-icon" />
      <span className="agent-activity-title"><small>派发子智能体</small><strong>{agent.name}</strong></span>
      <span className="agent-activity-disclosure">{expanded ? '收起过程' : agent.status === 'running' ? '查看实时过程' : '查看过程'}</span>
      <Badge className="tool-status" tone={agent.status === 'success' ? 'success' : agent.status === 'error' ? 'danger' : agent.status === 'running' ? 'blue' : 'neutral'}
        icon={agent.status === 'success' ? 'check' : agent.status === 'error' ? 'alert' : agent.status === 'running' ? 'refresh' : 'history'}>{label}</Badge>
      <span className={`agent-activity-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true" />
    </button>
    {agent.task && <p className="agent-activity-task">{agent.task}</p>}
    {expanded && <div className="agent-activity-body" aria-label={`${agent.name} 执行过程`}>
      {agent.segments?.length
        ? agent.segments.map(segment => segment.type === 'text'
          ? <AgentTextActivity text={segment.text} running={agent.status === 'running'} copyable={canCopy} key={segment.id} />
          : <ToolActivity tool={segment.tool} copyable={canCopy} key={segment.id} />)
        : agent.tools.map(tool => <ToolActivity tool={tool} copyable={canCopy} key={tool.id} />)}
      {showFinalFallback && <AgentTextActivity text={agent.output!} running={false} copyable={canCopy} />}
      {!agent.segments?.length && !agent.tools.length && !showFinalFallback && <p className="agent-activity-empty">
        {agent.status === 'running' ? '子智能体正在分析…' : '子智能体没有返回文本。'}
      </p>}
      {canCopy && <div className="message-copy-actions"><CopyMarkdownButton getText={() => agentToMarkdown(agent)} label="复制子智能体结果（Markdown）" /></div>}
    </div>}
  </section>;
}

function ReplyLoading({ message, stopping, compacting = false }: { message?: ChatMessage; stopping: boolean; compacting?: boolean }) {
  // Local elapsed time for this visible request, never inferred from token usage or history.
  const [startedAt] = useState(Date.now);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const activeAgent = message?.segments?.some(segment => segment.type === 'agent' && segment.agent.status === 'running');
  const activeTool = message?.tools?.some(tool => tool.status === 'running')
    || message?.segments?.some(segment => segment.type === 'tool' && segment.tool.status === 'running');
  const hasText = Boolean(message?.text.trim() || message?.segments?.some(segment => segment.type === 'text' && segment.text.trim()));
  const label = stopping ? '正在停止…' : activeAgent ? '智能体正在协作' : activeTool ? '正在执行工具' : hasText ? '正在生成回复' : '';
  if (compacting) {
    const duration = elapsed < 60 ? `${elapsed}秒` : `${Math.floor(elapsed / 60)}分钟 ${elapsed % 60}秒`;
    return <div className={`reply-compaction${stopping ? ' is-stopping' : ''}`}>
      <div className="reply-processing-time" aria-hidden="true">已处理 {duration}</div>
      <div className="reply-compaction-detail" role="status"><Icon name="file" size={16}/><span className="reply-compaction-copy">{stopping ? '正在停止压缩…' : '正在压缩上下文 · 可能需要几分钟'}</span></div>
    </div>;
  }
  return <div className="reply-loading" role="status" aria-label={label || '正在等待模型回复'} aria-atomic="true">
    <span className="reply-loading-wave" aria-hidden="true"><i /><i /><i /></span>
    {label && <span>{label}</span>}
  </div>;
}

type HistoryControls = {
  external?: boolean;
  content?:ReactNode;
  sessions: ClientChatSession[];
  activeSessionId: string;
  open: boolean;
  loading: boolean;
  loadingSessionId: string;
  error: string;
  toggle: () => void;
  refresh: () => void;
  select: (sessionId: string) => void;
  more?: () => void;
};

function sessionTime(value: ClientChatSession['updatedAt']): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export type AgentComposerHandle = { addText: (text: string, source: ChatTextExcerpt['source']) => boolean };
export function AgentPanel({ ref, memoryScope, onMemoryNotice, sshConnections, chatDraft, draftScope, host, connected, localTerminal, targetLabel, scopeControls, composerProject, messages, busy, stopping, send, steer, stop, clear, disabled, agentAvailability, history, collapsed, models, selectedModel, selectModel, openModelSettings, reasoning, recoveredRunning, stopRecovered, refreshCurrent, contextStatus=null, contextError, refreshContext, manualCompaction, execution, onApprovalChange }: {
  memoryScope?: MemoryScope;
  onMemoryNotice?: (message: string) => void;
  sshConnections?: { open: boolean; toggle: () => void };
  execution?: ExecutionScope;
  onApprovalChange?:(sessionId:string,pending:boolean)=>void;
  ref?: Ref<AgentComposerHandle>;
  chatDraft: ChatAttachmentDraft;
  draftScope: number;
  host?: Host;
  connected: boolean;
  localTerminal: boolean;
  targetLabel?: string;
  composerProject?: {project:AgentProject|null;projects:AgentProject[];locked:boolean;select:(projectId:string)=>Promise<void>;create?:()=>Promise<void>};
  scopeControls?: {value:string;options:{value:string;label:string}[];select:(id:string)=>void;useServer:(newTask:boolean)=>void;
    serverAvailable:boolean;serverName:string;locked:boolean;serverTask:boolean;general?:boolean};
  messages: ChatMessage[];
  busy: boolean;
  stopping: boolean;
  send: (text: string, attachments: ChatAttachment[]) => Promise<boolean>;
  steer?: (id:string,text:string,expectedRequestId:string)=>Promise<void>;
  stop: () => void;
  clear: () => void;
  disabled: boolean;
  agentAvailability: { ready: boolean; loading: boolean; error: string; retry: () => void };
  history: HistoryControls;
  collapsed: boolean;
  models?: AgentConfig[]; selectedModel?: string; selectModel?: (id: string) => void; openModelSettings?: () => void;
  reasoning?: { revision: number; onSavingChange: (saving: boolean) => void };
  contextStatus?: ContextStatus|null; contextError?:string; refreshContext?:()=>void; manualCompaction?:ManualCompactionControl;
  recoveredRunning?: boolean; stopRecovered?: () => void; refreshCurrent?: () => void;
}) {
  const [messageNow,setMessageNow]=useState(()=>Date.now());
  useEffect(()=>{
    let timer:number|undefined;
    const refresh=()=>{
      const now=Date.now(),midnight=new Date(now);midnight.setHours(24,0,0,0);
      setMessageNow(now);window.clearTimeout(timer);
      timer=window.setTimeout(refresh,Math.max(1000,midnight.getTime()-now+25));
    };
    refresh();window.addEventListener('focus',refresh);
    return()=>{window.clearTimeout(timer);window.removeEventListener('focus',refresh);};
  },[]);
  const [actionTooltip,setActionTooltip]=useState<{key:string;text:string;anchor:HTMLElement}|null>(null);
  const [actionTooltipId]=useState(()=>`agent-action-tip-${crypto.randomUUID()}`);
  const [actionTooltipPosition,setActionTooltipPosition]=useState<{left:number;top:number}|null>(null);
  const actionTooltipRef=useRef<HTMLDivElement>(null);
  const actionTooltipTimer=useRef<number|undefined>(undefined);
  const cancelTooltipTimer=()=>{window.clearTimeout(actionTooltipTimer.current);actionTooltipTimer.current=undefined;};
  const closeActionTooltip=()=>{cancelTooltipTimer();setActionTooltip(null);};
  const showActionTooltip=(key:string,text:string,anchor:HTMLElement)=>{
    cancelTooltipTimer();
    if(!anchor.isConnected||anchor.matches(':disabled'))return;
    setActionTooltipPosition(null);setActionTooltip({key,text,anchor});
  };
  const tooltipEvents=(key:string,text:string,blocked:boolean)=>({
    'aria-describedby':actionTooltip?.key===key?actionTooltipId:undefined,
    onMouseEnter:(event:{currentTarget:HTMLElement})=>{
      if(blocked)return;
      const anchor=event.currentTarget;
      if(document.activeElement===anchor&&actionTooltip?.key===key)return;
      closeActionTooltip();
      actionTooltipTimer.current=window.setTimeout(()=>showActionTooltip(key,text,anchor),400);
    },
    onMouseLeave:(event:{currentTarget:HTMLElement})=>{cancelTooltipTimer();if(document.activeElement!==event.currentTarget)closeActionTooltip();},
    onFocus:(event:{currentTarget:HTMLElement})=>{if(!blocked)showActionTooltip(key,text,event.currentTarget);},
    onBlur:closeActionTooltip,
  });
  useLayoutEffect(()=>{
    if(!actionTooltip)return;
    const tip=actionTooltipRef.current;if(!tip)return;
    if(!actionTooltip.anchor.isConnected){closeActionTooltip();return;}
    const rect=actionTooltip.anchor.getBoundingClientRect(),box=tip.getBoundingClientRect();
    const top=rect.top>=box.height+8?rect.top-box.height-8:rect.bottom+8;
    setActionTooltipPosition({left:Math.max(8,Math.min(rect.left+(rect.width-box.width)/2,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(top,window.innerHeight-box.height-8))});
  },[actionTooltip]);
  useEffect(()=>{
    // Listen while a hint is still pending, so Escape/scroll also cancel its timer.
    const close=closeActionTooltip,key=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};
    window.addEventListener('keydown',key);window.addEventListener('scroll',close,true);window.addEventListener('resize',close);window.addEventListener('blur',close);
    return()=>{cancelTooltipTimer();window.removeEventListener('keydown',key);window.removeEventListener('scroll',close,true);window.removeEventListener('resize',close);window.removeEventListener('blur',close);};
  },[]);
  const [draft, setDraft] = useState('');
  const [, setAttachmentError] = useToastError();
  useErrorToast(history.error);
  useErrorToast(agentAvailability.error);
  const [sending, setSending] = useState(false);
  const [projectSelecting,setProjectSelecting]=useState(false);
  const [projectSelectionVersion,setProjectSelectionVersion]=useState(0);
  const projectSelectionDraft=useRef<{text:string}|null>(null);
  const sendingRef = useRef(false);
  const scopeRef = useRef(draftScope);
  scopeRef.current = draftScope;
  const attachmentInput = useRef<HTMLInputElement>(null);
  const attachments = useSyncExternalStore(chatDraft.subscribe, chatDraft.getSnapshot);
  const locked = disabled || busy || stopping || sending;
  const [approvalTarget,setApprovalTarget]=useState<HTMLDivElement|null>(null);
  const [policyTarget,setPolicyTarget]=useState<HTMLDivElement|null>(null);
  const [approvalPending,setApprovalPending]=useState(false);
  type QueuedInput={id:string;text:string;files:ChatAttachment[];scope:number;requestId:string;state:'queued'|'submitting'|'submitted'|'unconfirmed'|'failed';error?:string};
  const [queue,setQueue]=useState<QueuedInput[]>([]);
  const queueAction=useRef(false);
  const [queuePaused,setQueuePaused]=useState(false);
  const editingLocked=disabled||projectSelecting;
  const projectSelectionLocked=busy||stopping||sending||!!recoveredRunning||projectSelecting||!!queue.length||!!composerProject?.locked;
  const lastMessage = messages[messages.length - 1];
  const railMessages = messages.filter(message => message.role === 'user');
  const [pickingAttachment,setPickingAttachment]=useState(false);
  useEffect(()=>closeActionTooltip(),[draftScope,locked,editingLocked,pickingAttachment,collapsed]);
  const nativeInputBusy = useRef(false);
  const [pendingNative,setPendingNative]=useState<NativeAttachmentProgress[]>([]);
  const nativeProgress=(scope:number,value:NativeAttachmentProgress)=>{
    if(scopeRef.current!==scope)return;
    setPendingNative(current=>value.finished?current.filter(item=>item.id!==value.id):[...current.filter(item=>item.id!==value.id&&item.id!=='clipboard-reading'),value]);
  };
  const notReady = pickingAttachment || attachments.some(item => item.status !== 'success');
  const addFiles = (files: File[]) => {
    try { chatDraft.add(files); setAttachmentError(''); }
    catch (error) { setAttachmentError((error as Error).message); }
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const [activeMessageId, setActiveMessageId] = useState<string>('');
  const [hoveredMessageId, setHoveredMessageId] = useState<string>('');
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>('');
  const [railPreview, setRailPreview] = useState<{ id: string; left: number; top: number } | null>(null);
  const railScrubRef = useRef<{ pointerId: number; startY: number; moved: boolean } | null>(null);
  const suppressRailClickRef = useRef(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followOutputRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pasteNative = (field: HTMLTextAreaElement) => {
    if (editingLocked || nativeInputBusy.current) return;
    nativeInputBusy.current=true;setPickingAttachment(true);setAttachmentError('');
    const scope=draftScope, original=field.value, start=field.selectionStart, end=field.selectionEnd;
    const pending=chatDraft.getSnapshot();
    setPendingNative([{id:'clipboard-reading',fileName:'正在读取剪贴板',size:0}]);
    void pasteNativeAttachments(file=>{
      if(scopeRef.current!==scope)return;
      try{chatDraft.attach([file]);}catch(error){setAttachmentError((error as Error).message);}
    },4-pending.length,Math.max(0,20_000_000-pending.reduce((sum,item)=>sum+item.size,0)),value=>nativeProgress(scope,value)).then(text=>{
      if(scopeRef.current!==scope||text===null)return;
      setDraft(current=>current===original?insertPastedText(current,text,start,end).text:current+text);
      requestAnimationFrame(()=>{if(scopeRef.current===scope&&textareaRef.current?.value===insertPastedText(original,text,start,end).text){const cursor=start+text.length;textareaRef.current.setSelectionRange(cursor,cursor);}});
    }).catch(error=>{if(scopeRef.current===scope)setAttachmentError(error instanceof Error?error.message:'粘贴失败');})
      .finally(()=>{nativeInputBusy.current=false;setPickingAttachment(false);if(scopeRef.current===scope)setPendingNative([]);});
  };
  useImperativeHandle(ref, () => ({ addText(text, source) {
    if (editingLocked || !text.trim()) return false;
    try {
      if (models) { setDraft(previous => previous + (previous ? '\n' : '') + text); return true; }
      const inline = chatDraft.addText(text, source);
      if (inline) setDraft(previous => previous + (previous && !previous.endsWith('\n') ? '\n' : '') + inline);
      setAttachmentError('');
      const scope = draftScope;
      requestAnimationFrame(() => { if (scopeRef.current === scope) textareaRef.current?.focus(); });
      return true;
    } catch (error) { setAttachmentError((error as Error).message); return false; }
  } }));

  const submit = async () => {
    if(projectSelectionDraft.current)return;
    if (!draft.trim() && !chatDraft.getSnapshot().length) return;
    if (editingLocked || nativeInputBusy.current || !agentAvailability.ready || notReady) return;
    if(queue.length>=32){setAttachmentError('队列最多保留 32 条消息，请先处理已有消息。');return;}
    const scope = draftScope;
    try {
      const files = chatDraft.ready();
      const invalid = validateChatContent(draft, files);
      if (invalid) { setAttachmentError(invalid); return; }
      const text=draft.trim();
      const requestId=[...messages].reverse().find(message=>message.role==='assistant')?.id??'';
      setQueue(previous=>[...previous,{id:crypto.randomUUID(),text,files,scope,requestId,state:'queued'}]);
      setDraft('');chatDraft.clear();
      if(!busy&&!stopping&&!sendingRef.current)setQueuePaused(false);
      followOutputRef.current = true;
      setAttachmentError('');
    } catch (error) {
      if (scopeRef.current === scope) setAttachmentError((error as Error).message);
    }
  };

  useEffect(()=>{
    if(busy||stopping||sendingRef.current||disabled||recoveredRunning||!agentAvailability.ready||queuePaused||queueAction.current)return;
    const item=queue.find(item=>item.scope===draftScope&&item.state==='queued');
    if(!item)return;
    sendingRef.current=true;setSending(true);
    setQueue(previous=>previous.filter(value=>value.id!==item.id));
    void send(item.text,item.files).then(success=>{
      if(scopeRef.current!==item.scope)return;
      if(!success){setQueuePaused(true);setQueue(previous=>[{...item,state:'failed',error:'本次发送未完成，请查看对话记录后再决定是否重新发送。'},...previous]);}
    }).catch(error=>{
      if(scopeRef.current===item.scope){setQueuePaused(true);setQueue(previous=>[{...item,state:'failed',error:error instanceof Error?error.message:'发送失败'},...previous]);}
    }).finally(()=>{if(scopeRef.current===item.scope){sendingRef.current=false;setSending(false);}});
  },[queue,busy,stopping,sending,disabled,recoveredRunning,agentAvailability.ready,queuePaused,draftScope,send]);

  const submitQueued=async(item:QueuedInput)=>{
    if(queueAction.current||editingLocked||stopping||item.state==='submitted'||item.state==='submitting')return;
    if(!(busy||sendingRef.current||recoveredRunning)&&item.state!=='unconfirmed'){
      setQueue(previous=>[{...item,state:'queued',error:undefined},...previous.filter(value=>value.id!==item.id)]);setQueuePaused(false);return;
    }
    if(!steer||item.files.length){setAttachmentError('当前仅支持将纯文本作为补充信息提交。');return;}
    const requestId=item.state==='unconfirmed'?item.requestId:[...messages].reverse().find(message=>message.role==='assistant')?.id??item.requestId;
    queueAction.current=true;
    setQueue(previous=>previous.map(value=>value.id===item.id?{...value,state:'submitting',requestId,error:undefined}:value));
    try{
      await steer(item.id,item.text,requestId);
      if(scopeRef.current===item.scope)setQueue(previous=>previous.map(value=>value.id===item.id?{...value,state:'submitted'}:value));
    }catch(error){
      if(scopeRef.current===item.scope){const rejected=['AGENT_BUSY','AGENT_INVALID_REQUEST','AGENT_NOT_FOUND','AGENT_REQUEST_CONFLICT'].includes((error as {code?:string})?.code??'');setQueuePaused(true);setQueue(previous=>previous.map(value=>value.id===item.id?{...value,state:rejected?'failed':'unconfirmed',error:error instanceof Error?error.message:'提交状态未确认，请核对历史；不会自动重发。'}:value));}
    }finally{queueAction.current=false;}
  };
  useEffect(()=>{
    const ids=new Set(messages.map(message=>message.id));
    setQueue(previous=>previous.some(item=>ids.has(item.id))?previous.filter(item=>!ids.has(item.id)):previous);
  },[messages]);
  useEffect(()=>{if(stopping)setQueuePaused(true);},[stopping]);

  useLayoutEffect(() => {
    followOutputRef.current = true;
  }, [history.activeSessionId]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container && followOutputRef.current) container.scrollTop = container.scrollHeight;
  }, [messages, busy, contextStatus?.phase]);

  const handleMessagesScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    // 用户向上翻阅时暂停跟随；主动回到底部后恢复流式自动滚动。
    followOutputRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 48;
    const midpoint = container.scrollTop + container.clientHeight * .35;
    let closest = '', distance = Number.POSITIVE_INFINITY;
    for (const message of railMessages) {
      const node = messageRefs.current.get(message.id);
      if (!node) continue;
      const next = Math.abs(node.offsetTop - midpoint);
      if (next < distance) { distance = next; closest = message.id; }
    }
    if (closest && closest !== activeMessageId) setActiveMessageId(closest);
  };

  const jumpToMessage = (id: string, behavior: ScrollBehavior = 'smooth', highlight = true) => {
    const container = scrollRef.current;
    const target = messageRefs.current.get(id);
    if (!container || !target) return;
    followOutputRef.current = false;
    const containerBounds = container.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const nextTop = container.scrollTop + targetBounds.top - containerBounds.top - container.clientHeight * .28;
    if (behavior === 'smooth') {
      // Match Codex's native target scroll so nested WebView scroll containers
      // resolve the correct ancestor themselves.
      target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    } else {
      container.scrollTo({ top: Math.max(0, Math.min(container.scrollHeight - container.clientHeight, nextTop)), behavior });
    }
    setActiveMessageId(id);
    if (highlight) {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightedMessageId(id);
      highlightTimerRef.current = setTimeout(() => { setHighlightedMessageId(''); highlightTimerRef.current = null; }, 720);
    }
  };

  const scrubRailAt = (rail: HTMLElement, clientY: number) => {
    if (railMessages.length < 4) return;
    const bounds = rail.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - bounds.top + rail.scrollTop) / Math.max(1, rail.scrollHeight)));
    const message = railMessages[Math.round(ratio * (railMessages.length - 1))];
    if (!message) return;
    setHoveredMessageId(message.id);
    jumpToMessage(message.id, 'auto', false);
  };
  const hoveredRailIndex = railMessages.findIndex(message => message.id === hoveredMessageId);
  // Codex keeps the visible turn marker short; only hover, focus, or scrubbing expands it.
  const railFocusIndex = hoveredRailIndex;
  const hoveredRailMessage = railMessages.find(message => message.id === hoveredMessageId);
  const hoveredRailPreview = hoveredRailMessage ? messageRailPreview(hoveredRailMessage, messages, messages.indexOf(hoveredRailMessage)) : null;

  const hideRailPreview = () => {
    if (previewCloseTimerRef.current) clearTimeout(previewCloseTimerRef.current);
    previewCloseTimerRef.current = setTimeout(() => { setHoveredMessageId(''); setRailPreview(null); previewCloseTimerRef.current = null; }, 140);
  };
  const showRailPreview = (id: string, button: HTMLElement) => {
    if (previewCloseTimerRef.current) { clearTimeout(previewCloseTimerRef.current); previewCloseTimerRef.current = null; }
    const bounds = button.getBoundingClientRect();
    const width = Math.min(320, Math.max(240, window.innerWidth - 16));
    setHoveredMessageId(id);
    setRailPreview({ id, left: Math.min(window.innerWidth - width - 8, bounds.right + 4), top: Math.max(92, Math.min(window.innerHeight - 92, bounds.top + bounds.height / 2)) });
  };

  const beginRailScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-message-id]') || target.closest('.chat-scroll-preview')) return;
    railScrubRef.current = { pointerId: event.pointerId, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrubRailAt(event.currentTarget, event.clientY);
  };
  const moveRailScrub = (event: ReactPointerEvent<HTMLElement>) => {
    const scrub = railScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientY - scrub.startY) > 3) scrub.moved = true;
    scrubRailAt(event.currentTarget, event.clientY);
  };
  const endRailScrub = (event: ReactPointerEvent<HTMLElement>) => {
    const scrub = railScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    if (scrub.moved) {
      suppressRailClickRef.current = true;
      window.setTimeout(() => { suppressRailClickRef.current = false; }, 0);
    }
    railScrubRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(handleMessagesScroll);
    return () => cancelAnimationFrame(frame);
  }, [messages, busy, contextStatus?.phase]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => handleMessagesScroll());
    observer.observe(container);
    return () => observer.disconnect();
  }, [messages.length]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 56), 180)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, [draft]);

  useEffect(() => { setDraft(projectSelectionDraft.current?.text??''); setAttachmentError(''); setSending(false); sendingRef.current = false;setQueue([]);setQueuePaused(false);queueAction.current=false;setApprovalPending(false);setPendingNative([]); }, [draftScope]);
  useEffect(()=>{
    if(!projectSelecting&&projectSelectionDraft.current){
      setDraft(projectSelectionDraft.current.text);projectSelectionDraft.current=null;
    }
  },[draftScope,projectSelecting,projectSelectionVersion]);

  const chooseProject=async(id:string)=>{
    if(!composerProject||projectSelectionLocked||projectSelectionDraft.current||messages.length||(id===(composerProject.project?.id??'')&&!disabled))return;
    if(id&&!composerProject.projects.some(project=>project.id===id))return;
    projectSelectionDraft.current={text:draft};setProjectSelecting(true);setAttachmentError('');
    try{await composerProject.select(id);}
    catch(error){setAttachmentError(error instanceof Error?error.message:'切换对话项目失败，请重试。');}
    finally{setProjectSelecting(false);setProjectSelectionVersion(value=>value+1);}
  };

  const createProject=async()=>{
    if(!composerProject?.create||projectSelectionLocked||projectSelectionDraft.current||messages.length)return;
    projectSelectionDraft.current={text:draft};setProjectSelecting(true);setAttachmentError('');
    try{await composerProject.create();}
    catch(error){setAttachmentError(error instanceof Error?error.message:'新建项目失败，请重试。');}
    finally{setProjectSelecting(false);setProjectSelectionVersion(value=>value+1);}
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        clear();
        setDraft('');
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [clear]);

  return <ExecutionContext.Provider value={execution?{agentId:execution.agentId,sessionId:execution.sessionId}:null}>
    {actionTooltip&&createPortal(<div ref={actionTooltipRef} id={actionTooltipId} role="tooltip" className="agent-action-tooltip" style={actionTooltipPosition??{visibility:'hidden'}}>{actionTooltip.text}</div>,document.body)}
    <aside className={`agent-panel conversation-only ${collapsed ? 'collapsed' : ''}`}>
    <section className="conversation-card" id="agent-panel-content" aria-hidden={collapsed}>
      <header>
        <div className="conversation-title">
          <AgentAvatar compact />
          <span><h3>智能体对话</h3><small title={targetLabel}><i className={`status-dot ${scopeControls?.general ? 'general' : connected ? '' : 'offline'}`} />{targetLabel ?? (localTerminal ? '本地 CMD · 未绑定' : host?.name ?? '尚未选择服务器')}</small></span>
        </div>
        {memoryScope&&<AgentMemoryButton key={`${draftScope}:${memoryScope.agentId}:${memoryScope.sessionId}:${memoryScope.projectId??''}`} scope={memoryScope} onNotice={onMemoryNotice}/>}
        <button type="button" className="agent-history-button" aria-label={history.external ? '切换会话侧栏' : '历史会话'} aria-expanded={history.open}
          aria-controls={history.external ? 'workspace-sidebar-content' : 'agent-history-list'} onClick={history.toggle} disabled={!history.external && (disabled || busy || !agentAvailability.ready)}>
          <Icon name="history" size={16} /><span>历史</span>
        </button>
        {sshConnections && <button type="button" className="agent-history-button agent-connections-button"
          aria-label={sshConnections.open ? '收起 SSH 连接列表' : '展开 SSH 连接列表'}
          title={sshConnections.open ? '收起 SSH 连接列表' : '展开 SSH 连接列表'}
          aria-controls="connection-sidebar-content" aria-expanded={sshConnections.open} onClick={sshConnections.toggle}>
          <Icon name="server" size={16}/><span>SSH 连接</span><Icon name={sshConnections.open ? 'down' : 'up'} size={13}/>
        </button>}
        <button type="button" className="new-agent-session" disabled={manualCompaction?.busy} onClick={() => { clear(); setDraft(''); }} aria-label="新建智能体会话">
          <Icon name="edit" size={15} />
          <strong>新会话</strong>
        </button>
      </header>

      {models && <>
        {scopeControls && <div className="agent-scope-controls">
          <Select label="对话范围" value={scopeControls.value} options={scopeControls.options} disabled={locked||scopeControls.locked} onChange={scopeControls.select}/>
          <button type="button" className="agent-scope-action" disabled={locked||scopeControls.locked||!scopeControls.serverAvailable}
            title={'在独立上下文中讨论 '+scopeControls.serverName} onClick={()=>scopeControls.useServer(false)}><Icon name="server" size={13}/>针对当前服务器</button>
          {scopeControls.serverTask && <button type="button" className="agent-scope-action" disabled={locked||scopeControls.locked||!scopeControls.serverAvailable}
            onClick={()=>scopeControls.useServer(true)}><Icon name="edit" size={13}/>新任务</button>}
        </div>}
        <div className="agent-mode-note"><i/>{execution?.enabled?'服务器对话':'文字对话'}<span>·</span>{execution?.enabled?'工具默认可用 · 审核边界见输入框':execution?'审核边界见输入框':'可讨论历史与问题'}</div>
        {recoveredRunning && <div className="agent-recovery-controls"><span role="status">{stopping ? '正在确认停止…' : '此请求仍在生成'}</span><button type="button" onClick={refreshCurrent} disabled={stopping || Boolean(history.loadingSessionId)}><Icon name="refresh" size={13} />刷新</button><button type="button" onClick={stopRecovered} disabled={stopping || Boolean(history.loadingSessionId)}><Icon name="stop" size={13} />{stopping ? '正在停止…' : '停止'}</button></div>}
      </>}

      {!history.external && history.open && <section id="agent-history-list" className="agent-history-popover" aria-label="历史会话列表">
        <div className="agent-history-heading"><strong>历史会话</strong><button type="button" onClick={history.refresh} disabled={history.loading} aria-label="刷新历史会话"><Icon name="refresh" size={15} /></button></div>
        {history.content ?? <>
        {history.loading && !history.sessions.length && <p className="agent-history-note">正在加载历史会话…</p>}
        {!history.loading && !history.error && !history.sessions.length && <p className="agent-history-note">暂无历史会话</p>}
        <div className="agent-history-items">
          {history.sessions.map(session => <button type="button" key={session.sessionId}
            className={`agent-history-item ${session.sessionId === history.activeSessionId ? 'active' : ''}`}
            aria-current={session.sessionId === history.activeSessionId ? 'page' : undefined}
            disabled={Boolean(history.loadingSessionId)} onClick={() => history.select(session.sessionId)}>
            <span className="agent-history-title">{session.title?.trim() || '新会话'}</span>
            <span className="agent-history-meta">{history.loadingSessionId === session.sessionId ? '正在加载…' : models ? '本地持久会话' : `${session.messageCount ?? 0} 条消息`}{sessionTime(session.updatedAt) && ` · ${sessionTime(session.updatedAt)}`}</span>
          </button>)}
        </div>
        {history.more && <button type="button" className="agent-history-more" disabled={history.loading} onClick={history.more}>加载更多会话</button>}
        </>}
      </section>}

      {execution&&<AgentExecution key={`${execution.agentId}:${execution.sessionId}`} scope={execution} approvalTarget={approvalTarget} policyTarget={policyTarget} onPendingChange={setApprovalPending} onApprovalChange={onApprovalChange}/>}
      <div className="chat-messages-shell">
        {railMessages.length >= 4 && <nav className="chat-scroll-rail" aria-label="消息快捷定位"
          onMouseLeave={() => { if (!railScrubRef.current) hideRailPreview(); }}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideRailPreview(); }}
          onPointerDown={beginRailScrub} onPointerMove={moveRailScrub} onPointerUp={endRailScrub} onPointerCancel={endRailScrub}>
          {railMessages.map((message, index) => <Fragment key={message.id}>
            <button type="button" className={message.id === activeMessageId ? 'is-active' : undefined}
              data-neighbor-distance={railFocusIndex >= 0 && index !== railFocusIndex && Math.abs(index - railFocusIndex) <= 3 ? Math.abs(index - railFocusIndex) : undefined}
              aria-label={`跳转到第 ${index + 1} 条消息`} title={`跳转到第 ${index + 1} 条消息`}
              data-message-id={message.id}
              onMouseEnter={event => showRailPreview(message.id, event.currentTarget)} onFocus={event => showRailPreview(message.id, event.currentTarget)}
              onClick={event => { if (suppressRailClickRef.current) return; showRailPreview(message.id, event.currentTarget); jumpToMessage(message.id); }}><span className="chat-scroll-marker"><span className="chat-scroll-marker-line" /></span></button>
          </Fragment>)}
        </nav>}
        {railPreview && hoveredRailPreview && typeof document !== 'undefined' && createPortal(
          <div className="chat-scroll-preview" style={{ left: railPreview.left, top: railPreview.top }}
            onMouseEnter={() => { if (previewCloseTimerRef.current) { clearTimeout(previewCloseTimerRef.current); previewCloseTimerRef.current = null; } }} onMouseLeave={hideRailPreview}>
            <strong>{hoveredRailPreview.title}</strong><Icon name="book" size={15} /><p>{hoveredRailPreview.summary || '这条消息暂无摘要。'}</p>
          </div>, document.body)}
      <div className="chat-messages" ref={scrollRef} aria-label="聊天记录" aria-live="polite"
        onScroll={handleMessagesScroll} onWheel={event => { if (event.deltaY < 0) followOutputRef.current = false; }}>
        {messages.length === 0 && !busy && <AgentEmptyState mode={!agentAvailability.ready ? 'setup' : execution?.enabled ? 'server' : 'general'}>
          {models ? (agentAvailability.ready ? execution?.enabled?'工具操作遵循输入框中的审批设置。':'支持文字与附件；服务器任务请先绑定 SSH 连接。' : '在模型设置中添加 API 地址、模型与密钥，再回来聊聊。') : agentAvailability.ready
            ? connected ? '工具操作遵循当前对话的审批设置。' : localTerminal ? '可以讨论问题，暂不支持代为执行本地 CMD 命令。' : '直接输入问题；绑定服务器后还可以使用 SSH 工具。'
            : '先配置模型，也可以提前准备问题或附件。'}
        </AgentEmptyState>}

        {messages.map((message, index) => message.role === 'user'
          ? <div className={`user-message-group${highlightedMessageId === message.id ? ' chat-message-jump-highlight' : ''}`} key={message.id} ref={node => { if (node) messageRefs.current.set(message.id, node); else messageRefs.current.delete(message.id); }}>
            {!!message.attachments?.length && <MessageAttachments files={message.attachments} scope={models&&history.activeSessionId?{agentId:selectedModel??'',sessionId:history.activeSessionId}:undefined} />}
            {(message.text || message.inputPending) && <div className="user-message">{message.text && <div>{message.text}</div>}{message.inputPending&&<small className="pending-input-note">补充已保存，尚未被当前轮接收；不会自动重新执行</small>}</div>}
            <div className="message-copy-actions chat-message-meta request"><MessageTime timestamp={message.timestamp} now={messageNow} hint={text=>tooltipEvents(`message-time:${message.id}`,text,false)}/><button type="button" className="chat-restore-request" aria-label="恢复请求" {...tooltipEvents(`restore:${message.id}`,'恢复到输入框',locked)} disabled={locked} onClick={() => {
              closeActionTooltip();
              if (draft.trim() || attachments.length) { setAttachmentError('请先清空当前草稿，再恢复这条请求。'); return; }
              try { chatDraft.attach(message.attachments ?? []); setDraft(message.text); setAttachmentError(''); textareaRef.current?.focus(); }
              catch (error) { setAttachmentError((error as Error).message); }
            }}><Icon name="edit" size={14}/></button><CopyMarkdownButton getText={() => messageToMarkdown(message)} label="复制消息" iconOnly hint={{...tooltipEvents(`copy-message:${message.id}`,'复制消息',false),onActivate:()=>closeActionTooltip()}} /></div>
          </div>
          : <div className={`assistant-message ${message.error ? 'error' : ''} ${(busy || stopping) && index === messages.length - 1 ? 'active' : ''}${highlightedMessageId === message.id ? ' chat-message-jump-highlight' : ''}`} key={message.id} ref={node => { if (node) messageRefs.current.set(message.id, node); else messageRefs.current.delete(message.id); }}>
            <div className="assistant-main">
              {message.segments
                ? transcriptBlocks(message.segments).map(segment => segment.type === 'text'
                  ? <div className="assistant-content" key={segment.id}><MarkdownMessage streaming={(busy || stopping) && index === messages.length - 1}>{segment.text}</MarkdownMessage></div>
                  : <ActivityTranscript activities={segment.activities} copyable={!((busy || stopping) && index === messages.length - 1)} key={segment.id}/>)
                : <>
                  {(message.text || message.summary) && <div className="assistant-content">
                    {message.text && <MarkdownMessage streaming={(busy || stopping) && index === messages.length - 1}>{message.text}</MarkdownMessage>}
                    {message.summary && <MarkdownMessage streaming={(busy || stopping) && index === messages.length - 1}>{message.summary}</MarkdownMessage>}
                  </div>}
                  {message.tools?.length ? <ActivityTranscript activities={message.tools.map(tool=>({id:tool.id,type:'tool',tool}))} copyable={!((busy || stopping) && index === messages.length - 1)}/> : null}
                </>}
              {message.error && <p className="chat-error-guidance">{chatErrorGuidance(message.errorCode)}</p>}
              {(busy || stopping) && index === messages.length - 1
                ? <ReplyLoading message={message} stopping={stopping} compacting={contextStatus?.phase === 'running' && contextStatus.requestId === message.id} />
                : <div className="message-copy-actions chat-message-meta response"><CopyMarkdownButton getText={() => messageToMarkdown(message)} label="复制回复" iconOnly hint={{...tooltipEvents(`copy-reply:${message.id}`,'复制回复',false),onActivate:()=>closeActionTooltip()}} /><MessageTime timestamp={message.timestamp} now={messageNow} hint={text=>tooltipEvents(`message-time:${message.id}`,text,false)}/></div>}
            </div>
          </div>)}
        {contextStatus?.phase === 'running' && !((busy || stopping) && lastMessage?.role === 'assistant' && lastMessage.id === contextStatus.requestId) &&
          <div className="assistant-message active"><div className="assistant-main"><ReplyLoading key={contextStatus.requestId} stopping={stopping} compacting /></div></div>}
      </div>
      </div>
    </section>

    <div className="composer-dock" aria-hidden={collapsed}>
      {composerProject&&!approvalPending&&<div className="composer-project-strip">
        {!messages.length?<ComposerProjectPicker project={composerProject.project} projects={composerProject.projects} disabled={projectSelectionLocked}
          onChange={id=>void chooseProject(id)} onCreate={composerProject.create?()=>void createProject():undefined}/>
          :<><Icon name="folder" size={16}/><span className="composer-project-label" title={composerProject.project?.name??'文字对话'}>{composerProject.project?.name??'文字对话'}</span></>}
        {!composerProject.project&&!messages.length&&<span className="composer-project-context"><Icon name="edit" size={15}/>文字对话</span>}
        {projectSelecting&&<span className="composer-project-status" role="status">正在切换…</span>}
      </div>}
      {!!queue.length&&<section className="composer-queue" aria-label="待发送消息"><div className="composer-queue-title">{queue.length} 条消息{queuePaused?' · 已暂停':' · 等待处理'}</div>{queue.map(item=><div className={`composer-queue-item is-${item.state}`} key={item.id}>
        <Icon name="tabs" size={14}/><div className="composer-queue-content"><span title={item.text}>{item.text||`${item.files.length} 个附件`}</span>{item.state!=='queued'&&<small>{item.state==='submitting'?'正在提交补充…':item.state==='submitted'?'已提交 · 等待当前轮接收':item.error}</small>}</div>
        {item.state!=='submitted'&&item.state!=='submitting'&&<><button type="button" title={item.state==='unconfirmed'?'使用相同消息 ID 核对提交，不会重复追加':'提交补充信息，不中断模型运行'} aria-label={item.state==='unconfirmed'?'核对提交':'立即提交'} disabled={editingLocked||stopping||((busy||sending)&&!steer)} onClick={()=>void submitQueued(item)}><Icon name="arrowUp" size={14}/><span>{item.state==='unconfirmed'?'核对':'引导'}</span></button><button type="button" aria-label="编辑排队消息" title="移回输入框编辑" disabled={editingLocked||item.state==='unconfirmed'||!!draft||!!attachments.length} onClick={()=>{setDraft(item.text);chatDraft.attach(item.files);setQueue(previous=>previous.filter(value=>value.id!==item.id));textareaRef.current?.focus();}}><Icon name="edit" size={14}/></button><button type="button" aria-label="删除排队消息" disabled={editingLocked||item.state==='unconfirmed'} onClick={()=>setQueue(previous=>previous.filter(value=>value.id!==item.id))}><Icon name="trash" size={14}/></button></>}
      </div>)}</section>}
    <div ref={setApprovalTarget} className="composer-approval-slot" hidden={!approvalPending}/>
    {approvalPending&&execution&&<div className="composer-approval-policy" ref={setPolicyTarget}/>}
    <form className={`chat-composer${approvalPending?' is-awaiting-approval':''}`} aria-hidden={collapsed||approvalPending} inert={approvalPending} onSubmit={event => { event.preventDefault(); void submit(); }}>
      {localTerminal && <div className="composer-agent-status local-terminal" data-accent="neutral" role="status">
        <Icon name="monitor" size={15} />
        <span>本地 CMD 仅在客户端运行；可手动添加选中文本，Agent 不会收到本地会话 ID。</span>
      </div>}
      {!agentAvailability.ready && <div className={`composer-agent-status ${agentAvailability.error ? 'error' : ''}`} data-accent={agentAvailability.error ? 'danger' : 'amber'} role="status">
        <Icon name={agentAvailability.error ? 'alert' : 'bot'} size={15} />
        <span>{agentAvailability.loading ? '正在加载智能体，你可以先编辑草稿。' : '智能体暂不可用，草稿可以继续编辑。'}</span>
        {!agentAvailability.loading && <button type="button" onClick={agentAvailability.retry}><Icon name="refresh" size={13} />重试加载</button>}
      </div>}
      {(!!attachments.length||!!pendingNative.length) && <DraftAttachments pending={pendingNative} items={attachments} draft={chatDraft} locked={editingLocked} report={setAttachmentError} />}
      <div className="composer-input-row"><textarea ref={textareaRef} rows={1} aria-label="智能体任务输入" placeholder={busy?'继续输入，新消息将进入队列':'让思路沿着终端，走到答案'} value={draft} disabled={editingLocked} onChange={event => setDraft(event.target.value)}
        onPaste={event => {
          if (models) { event.preventDefault(); pasteNative(event.currentTarget); return; }
          const files = pastedFiles(event.clipboardData);
          const text = event.clipboardData.getData('text/plain');
          if (!files.length && !isLongChatText(text)) return;
          event.preventDefault();
          if (editingLocked) return;
          try {
            const inline = chatDraft.addText(text, 'paste', files);
            if (inline) {
              const next = insertPastedText(event.currentTarget.value, inline, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
              setDraft(next.text);
              const scope = draftScope;
              requestAnimationFrame(() => { if (scopeRef.current === scope) textareaRef.current?.setSelectionRange(next.cursor, next.cursor); });
            }
            setAttachmentError('');
          } catch (error) { setAttachmentError((error as Error).message); }
        }}
        onKeyDown={event => { if (models && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteNative(event.currentTarget); return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /></div>
      <div className="composer-bottom-bar">
        <button type="button" className="composer-attach-button" aria-label="添加附件" {...tooltipEvents('attach','添加文件等内容',editingLocked||pickingAttachment||attachments.length>=4)} disabled={editingLocked || pickingAttachment || attachments.length>=4} onClick={() => {
          closeActionTooltip();
          if(!models){attachmentInput.current?.click();return;}
          if(nativeInputBusy.current)return;nativeInputBusy.current=true;
          const scope=draftScope;setPickingAttachment(true);setAttachmentError('');
          void pickNativeAttachments(file=>{
            if(scopeRef.current!==scope)return;
            try{chatDraft.attach([file]);setAttachmentError('');}catch(error){setAttachmentError((error as Error).message);}
          },message=>{if(scopeRef.current===scope)setAttachmentError(message);},true,4-chatDraft.getSnapshot().length,value=>nativeProgress(scope,value)).catch(error=>{if(scopeRef.current===scope)setAttachmentError(error instanceof Error?error.message:'附件选择失败');}).finally(()=>{nativeInputBusy.current=false;setPickingAttachment(false);if(scopeRef.current===scope)setPendingNative([]);});
        }}><Icon name="plus" size={20} /></button>
        <input ref={attachmentInput} type="file" multiple tabIndex={-1} className="visually-hidden" aria-label="选择聊天附件" accept={chatAttachmentPolicy.extensions.map(ext => `.${ext}`).join(',')} onChange={event => {
          if (!editingLocked && event.target.files?.length) addFiles(Array.from(event.target.files));
          event.target.value = '';
        }} />
        {!!attachments.length && <span className="composer-attachment-note">{attachments.length}/4 · 合计 ≤ 20 MB · 发送时解析</span>}
        {execution&&<div className="composer-policy-slot" ref={approvalPending?undefined:setPolicyTarget}/>}
        {models && <div className="agent-model-controls composer-model-controls">
          <div className="agent-model-picker"><Select label="对话模型" value={selectedModel ?? ''} disabled={busy || stopping || disabled || !models.length}
            options={models.length ? models.map(model => ({value:model.agentId,label:`${model.agentName}${model.modelName ? ` · ${model.modelName}` : ''}`})) : [{value:'',label:'请先添加模型'}]}
            menuMinWidth={260} menuAlign="end" onChange={value => selectModel?.(value)}/></div>
          {reasoning && <ComposerReasoningControl modelId={selectedModel ?? ''} revision={reasoning.revision} disabled={locked || !!recoveredRunning} onSavingChange={reasoning.onSavingChange} />}
          <button className="agent-model-settings-button" type="button" aria-label="模型设置" title="模型设置" onClick={openModelSettings}><Icon name="settings" size={15}/></button>
          <AgentContextStatus status={contextStatus} error={contextError} retry={refreshContext} manual={manualCompaction}/>
        </div>}
        {(busy||stopping)&&<button type="button" className="send-button stop-button" aria-label={stopping?'正在停止':'停止生成'} title="停止生成" onClick={()=>{setQueuePaused(true);stop();}} disabled={stopping}><Icon name="stop" size={16}/></button>}
        {(!(busy||stopping)||!!draft.trim()||attachments.length>0)&&<button type="submit" className="send-button" aria-label={busy||sending?'加入消息队列':'发送消息'} title={busy||sending?'加入队列，当前轮结束后自动发送':'发送消息'} disabled={(!draft.trim() && !attachments.length) || editingLocked || notReady || !agentAvailability.ready}><Icon name="arrowUp" size={20}/></button>}
      </div>
    </form></div>
  </aside></ExecutionContext.Provider>;
}
