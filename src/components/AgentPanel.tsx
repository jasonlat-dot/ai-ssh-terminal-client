import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Ref, ReactNode } from 'react';
import { MarkdownMessage } from './MarkdownMessage';
import agentRobotAvatar from '../assets/agent-robot-avatar.png';
import type { ClientChatSession } from '../state/clientChatHistory';
import type { AgentConfig, AgentProject } from '../api/agent';
import type { AgentContextStatus as ContextStatus } from '../api/agentContext';
import { AgentContextStatus } from './AgentContextStatus';
import type { ChatAttachment, ChatAgentActivity, ChatMessage, ChatToolActivity, ChatTextExcerpt, Host } from '../types';
import { AccentIcon, Badge, Icon } from './Ui';
import { CopyMarkdownButton } from './CopyMarkdownButton';
import { CopyTextButton } from './CopyTextButton';
import { Select } from './Select';
import { ChatAttachmentDraft, chatAttachmentPolicy, isLongChatText, pastedFiles, insertPastedText, validateChatContent } from '../state/chatAttachments';
import { DraftAttachments, MessageAttachments } from './ChatAttachments';
import { chatErrorGuidance } from '../api/chatErrors';
import { AgentExecution, ExecutionContext, NativeToolOutput, type ExecutionScope } from './AgentExecution';
import { agentToMarkdown, messageToMarkdown, toolToMarkdown } from '../state/chatMarkdown';
import { transcriptBlocks, activitySummary, type ActivitySegment } from '../state/agentTranscript';

function AgentAvatar({ compact = false }: { compact?: boolean }) {
  return <span className={`agent-avatar ${compact ? 'compact' : ''}`}><img src={agentRobotAvatar} alt="Agent 机器人" /></span>;
}

function MessageTime({ timestamp }: { timestamp?: number }) {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return <time className="chat-message-time" dateTime={date.toISOString()} title={date.toLocaleString()}>
    {date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
  </time>;
}

function ToolActivity({ tool, copyable }: { tool: ChatToolActivity; copyable: boolean }) {
  const label = tool.status === 'running' ? '运行中'
    : tool.status === 'success' ? '已运行'
      : tool.status === 'error' ? '运行失败' : '结果未知';
  const title = tool.name === 'executeCommand' || tool.name === 'ssh_execute' ? '执行命令' : tool.name === 'read_tool_output' ? '回查工具输出' : tool.name;
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
export function AgentPanel({ ref, chatDraft, draftScope, host, connected, localTerminal, targetLabel, scopeControls, composerProject, messages, busy, stopping, send, steer, stop, clear, disabled, agentAvailability, history, collapsed, models, selectedModel, selectModel, openModelSettings, recoveredRunning, stopRecovered, refreshCurrent, contextStatus=null, contextError, refreshContext, execution, onApprovalChange }: {
  execution?: ExecutionScope;
  onApprovalChange?:(sessionId:string,pending:boolean)=>void;
  ref?: Ref<AgentComposerHandle>;
  chatDraft: ChatAttachmentDraft;
  draftScope: number;
  host?: Host;
  connected: boolean;
  localTerminal: boolean;
  targetLabel?: string;
  composerProject?: {project:AgentProject|null;projects:AgentProject[];locked:boolean;select:(projectId:string)=>Promise<void>};
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
  contextStatus?: ContextStatus|null; contextError?:string; refreshContext?:()=>void;
  recoveredRunning?: boolean; stopRecovered?: () => void; refreshCurrent?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
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
  const notReady = attachments.some(item => item.status !== 'success');
  const addFiles = (files: File[]) => {
    try { chatDraft.add(files); setAttachmentError(''); }
    catch (error) { setAttachmentError((error as Error).message); }
  };
  const attachFiles = (files: ChatAttachment[]) => {
    if (editingLocked) return;
    try { chatDraft.attach(files); setAttachmentError(''); textareaRef.current?.focus(); }
    catch (error) { setAttachmentError((error as Error).message); }
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    if (editingLocked || !agentAvailability.ready || notReady) return;
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
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 56), 180)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, [draft]);

  useEffect(() => { setDraft(projectSelectionDraft.current?.text??''); setAttachmentError(''); setSending(false); sendingRef.current = false;setQueue([]);setQueuePaused(false);queueAction.current=false;setApprovalPending(false); }, [draftScope]);
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

  return <ExecutionContext.Provider value={execution?{agentId:execution.agentId,sessionId:execution.sessionId}:null}><aside className={`agent-panel conversation-only ${collapsed ? 'collapsed' : ''}`}>
    <section className="conversation-card" id="agent-panel-content" aria-hidden={collapsed}>
      <header>
        <div className="conversation-title">
          <AgentAvatar compact />
          <span><h3>智能体对话</h3><small title={targetLabel}><i className={`status-dot ${scopeControls?.general ? 'general' : connected ? '' : 'offline'}`} />{targetLabel ?? (localTerminal ? '本地 CMD · 未绑定' : host?.name ?? '尚未选择服务器')}</small></span>
        </div>
        <button type="button" className="agent-history-button" aria-label={history.external ? '切换会话侧栏' : '历史会话'} aria-expanded={history.external ? undefined : history.open}
          aria-controls={history.external ? 'workspace-sidebar-content' : 'agent-history-list'} onClick={history.toggle} disabled={!history.external && (disabled || busy || !agentAvailability.ready)}>
          <Icon name="history" size={16} /><span>历史</span>
        </button>
        <button type="button" className="new-agent-session" onClick={() => { clear(); setDraft(''); }} aria-label="新建智能体会话">
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
        <div className="agent-mode-note"><i/>{execution?.enabled?'服务器对话':'文字对话'}<span>·</span>{execution?.enabled?'工具默认可用 · 审核边界见输入框':'可讨论历史与问题'}</div>
        {recoveredRunning && <div className="agent-recovery-controls"><span role="status">{stopping ? '正在确认停止…' : '此请求仍在生成'}</span><button type="button" onClick={refreshCurrent} disabled={stopping || Boolean(history.loadingSessionId)}><Icon name="refresh" size={13} />刷新</button><button type="button" onClick={stopRecovered} disabled={stopping || Boolean(history.loadingSessionId)}><Icon name="stop" size={13} />{stopping ? '正在停止…' : '停止'}</button></div>}
      </>}

      {!history.external && history.open && <section id="agent-history-list" className="agent-history-popover" aria-label="历史会话列表">
        <div className="agent-history-heading"><strong>历史会话</strong><button type="button" onClick={history.refresh} disabled={history.loading} aria-label="刷新历史会话"><Icon name="refresh" size={15} /></button></div>
        {history.content ?? <>
        {history.error && <p className="agent-history-note error">{history.error}</p>}
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
      <div className="chat-messages" ref={scrollRef} aria-label="聊天记录" aria-live="polite"
        onScroll={handleMessagesScroll} onWheel={event => { if (event.deltaY < 0) followOutputRef.current = false; }}>
        {messages.length === 0 && !busy && <div className="agent-chat-empty">
          <img className="empty-agent-avatar" src={agentRobotAvatar} alt="Agent 机器人" />
          <h3>有什么需要我协助？</h3>
          <p>{models ? (agentAvailability.ready ? execution?.enabled?'可以让我检查服务或分析日志；工具操作遵循输入框中的审核设置。':'可以提问或粘贴文本；连接绑定服务器后，SSH 工具自动可用。' : '先在模型设置中添加 API 地址、模型与密钥，再开始对话。') : agentAvailability.ready
            ? connected ? '可以让我执行命令、检查服务状态或分析日志。' : localTerminal ? '当前是本地 CMD，Agent 无法连接或代为执行本地命令，但仍可进行普通对话。' : '可以直接与 Agent 对话；当前页签连接服务器后还可以执行 SSH 命令。'
            : '可以先输入问题或添加附件，智能体就绪后再发送。'}</p>
        </div>}

        {messages.map((message, index) => message.role === 'user'
          ? <div className="user-message-group" key={message.id}>
            <div className="user-message">{message.text && <div>{message.text}</div>}{message.inputPending&&<small className="pending-input-note">补充已保存，尚未被当前轮接收；不会自动重新执行</small>}{!!message.attachments?.length && <MessageAttachments files={message.attachments} attach={attachFiles} disabled={locked} />}</div>
            <div className="message-copy-actions chat-message-meta request"><button type="button" className="chat-restore-request" aria-label="恢复请求" title="恢复到输入框" disabled={locked} onClick={() => {
              if (draft.trim() || attachments.length) { setAttachmentError('请先清空当前草稿，再恢复这条请求。'); return; }
              try { chatDraft.attach(message.attachments ?? []); setDraft(message.text); setAttachmentError(''); textareaRef.current?.focus(); }
              catch (error) { setAttachmentError((error as Error).message); }
            }}><Icon name="edit" size={14}/></button><MessageTime timestamp={message.timestamp}/><CopyMarkdownButton getText={() => messageToMarkdown(message)} label="复制请求（Markdown）" iconOnly /></div>
          </div>
          : <div className={`assistant-message ${message.error ? 'error' : ''} ${(busy || stopping) && index === messages.length - 1 ? 'active' : ''}`} key={message.id}>
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
                : <div className="message-copy-actions chat-message-meta response"><CopyMarkdownButton getText={() => messageToMarkdown(message)} label="复制回复（Markdown）" iconOnly /><MessageTime timestamp={message.timestamp}/></div>}
            </div>
          </div>)}
        {contextStatus?.phase === 'running' && !((busy || stopping) && lastMessage?.role === 'assistant' && lastMessage.id === contextStatus.requestId) &&
          <div className="assistant-message active"><div className="assistant-main"><ReplyLoading key={contextStatus.requestId} stopping={stopping} compacting /></div></div>}
      </div>
    </section>

    <div className="composer-dock" aria-hidden={collapsed}>
      {composerProject&&!approvalPending&&<div className="composer-project-strip">
        <Icon name={composerProject.project?'folder':'edit'} size={16}/>
        {!messages.length?<Select label="新对话连接" value={composerProject.project?.id??''}
          displayValue={composerProject.project?.name??'文字对话'} className="composer-project-picker" menuMinWidth={280} menuClassName="composer-project-menu"
          disabled={projectSelectionLocked} onChange={id=>void chooseProject(id)}
          options={[{value:'',label:'文字对话',description:'不连接 SSH，仅进行文字交流'},...composerProject.projects.map(project=>({value:project.id,label:project.name,
            description:project.identity?`${project.identity.username}@${project.identity.host}:${project.identity.port}`:'已创建的 SSH 项目'}))]}/>
          :<span className="composer-project-label" title={composerProject.project?.name??'文字对话'}>{composerProject.project?.name??'文字对话'}</span>}
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
        <span>{agentAvailability.loading ? '正在加载智能体，你可以先编辑草稿。' : agentAvailability.error || '智能体暂不可用，草稿可以继续编辑。'}</span>
        {!agentAvailability.loading && <button type="button" onClick={agentAvailability.retry}><Icon name="refresh" size={13} />重试加载</button>}
      </div>}
      {!!attachments.length && <DraftAttachments items={attachments} draft={chatDraft} locked={editingLocked} report={setAttachmentError} />}
      <div className="composer-input-row"><textarea ref={textareaRef} rows={1} aria-label="智能体任务输入" placeholder={busy?'继续输入，新消息将进入队列':'与 ShellPilot 协作'} value={draft} disabled={editingLocked} onChange={event => setDraft(event.target.value)}
        onPaste={event => {
          const files = pastedFiles(event.clipboardData);
          const text = event.clipboardData.getData('text/plain');
          if (models) { if (files.length) { event.preventDefault(); setAttachmentError('聊天附件尚未接入，请直接粘贴纯文本。'); } return; }
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
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /></div>
      <div className="composer-bottom-bar">
        <button type="button" className="composer-attach-button" aria-label="添加附件" disabled={editingLocked || !!models} onClick={() => attachmentInput.current?.click()} title={models ? '聊天附件尚未接入' : '选择图片、PDF 或文本文件'}><Icon name="plus" size={20} /></button>
        <input ref={attachmentInput} type="file" multiple tabIndex={-1} className="visually-hidden" aria-label="选择聊天附件" accept={chatAttachmentPolicy.extensions.map(ext => `.${ext}`).join(',')} onChange={event => {
          if (!editingLocked && event.target.files?.length) addFiles(Array.from(event.target.files));
          event.target.value = '';
        }} />
        {!models && <span className="composer-attachment-note">{attachments.length}/4 · 合计 ≤ 20 MB</span>}
        {execution&&<div className="composer-policy-slot" ref={approvalPending?undefined:setPolicyTarget}/>}
        {models && <div className="agent-model-controls composer-model-controls">
          <div className="agent-model-picker"><Select label="对话模型" value={selectedModel ?? ''} disabled={busy || stopping || disabled || !models.length}
            options={models.length ? models.map(model => ({value:model.agentId,label:`${model.agentName}${model.modelName ? ` · ${model.modelName}` : ''}`})) : [{value:'',label:'请先添加模型'}]}
            menuMinWidth={260} menuAlign="end" onChange={value => selectModel?.(value)}/></div>
          <button className="agent-model-settings-button" type="button" aria-label="模型设置" title="模型设置" onClick={openModelSettings}><Icon name="settings" size={15}/></button>
          <AgentContextStatus status={contextStatus} error={contextError} retry={refreshContext}/>
        </div>}
        {(busy||stopping)&&<button type="button" className="send-button stop-button" aria-label={stopping?'正在停止':'停止生成'} title="停止生成" onClick={()=>{setQueuePaused(true);stop();}} disabled={stopping}><Icon name="stop" size={16}/></button>}
        {(!(busy||stopping)||!!draft.trim()||attachments.length>0)&&<button type="submit" className="send-button" aria-label={busy||sending?'加入消息队列':'发送消息'} title={busy||sending?'加入队列，当前轮结束后自动发送':'发送消息'} disabled={(!draft.trim() && !attachments.length) || editingLocked || notReady || !agentAvailability.ready}><Icon name="arrowUp" size={20}/></button>}
      </div>
      {(attachmentError || notReady) && <p className="composer-attachment-error" role="status">{attachmentError || (attachments.some(item => item.status === 'error') ? '附件上传失败，请重试或移除后再发送。' : '附件正在准备中，请等待上传完成。')}</p>}
    </form></div>
  </aside></ExecutionContext.Provider>;
}
