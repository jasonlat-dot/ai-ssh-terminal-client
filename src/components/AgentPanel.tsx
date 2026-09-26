import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import agentRobotAvatar from '../assets/agent-robot-avatar.png';
import type { ClientChatSession } from '../state/clientChatHistory';
import type { ChatAttachment, ChatAgentActivity, ChatMessage, ChatToolActivity, Host } from '../types';
import { Icon } from './Ui';
import { CopyMarkdownButton } from './CopyMarkdownButton';
import { ChatAttachmentDraft, chatAttachmentPolicy, pastedFiles, insertPastedText, validateChatContent } from '../state/chatAttachments';
import { DraftAttachments, MessageAttachments } from './ChatAttachments';
import { chatErrorGuidance } from '../api/chatErrors';
import { agentToMarkdown, messageToMarkdown, toolToMarkdown } from '../state/chatMarkdown';

function AgentAvatar({ compact = false }: { compact?: boolean }) {
  return <span className={`agent-avatar ${compact ? 'compact' : ''}`}><img src={agentRobotAvatar} alt="Agent 机器人" /></span>;
}

/**
 * 使用 react-markdown 渲染模型回复。
 * 默认不会执行回复中的原始 HTML；remark-gfm 补充表格、删除线、任务列表等常见 Markdown 语法。
 */
const MarkdownMessage = memo(function MarkdownMessage({ children }: { children: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: linkText, href, title }) => <a href={href} title={title} target="_blank" rel="noreferrer">{linkText}</a>,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>;
});

function ToolActivity({ tool, copyable }: { tool: ChatToolActivity; copyable: boolean }) {
  const label = tool.status === 'running' ? '调用中'
    : tool.status === 'success' ? '成功'
      : tool.status === 'error' ? '失败' : '状态未知';
  const title = tool.name === 'executeCommand' ? '执行命令' : tool.name;
  const header = <>
    <Icon name="terminal" size={15} />
    <span className="tool-identity"><span className="tool-name"><strong>{title}</strong>{title !== tool.name && <small>{tool.name}</small>}</span>{tool.command && <code title={tool.command}>{tool.command}</code>}</span>
    <em className="tool-status"><i aria-hidden="true" />{label}</em>
  </>;

  if (tool.status === 'running') {
    return <div className="tool-activity running" aria-label={`${title}：${label}`}>
      <div className="tool-activity-header">{header}</div>
    </div>;
  }

  return <details className={`tool-activity ${tool.status}`}>
    <summary>{header}<small className="tool-view-result">查看结果</small></summary>
    {tool.output ? <pre>{tool.output}</pre> : <p className="tool-empty-result">工具没有返回文本。</p>}
    {copyable && <div className="message-copy-actions"><CopyMarkdownButton getText={() => toolToMarkdown(tool)} label="复制工具结果（Markdown）" /></div>}
  </details>;
}

function AgentTextActivity({ text, running, copyable }: { text: string; running: boolean; copyable: boolean }) {
  return <details className="agent-activity-thought">
    <summary>
      <Icon name="bulb" size={15} />
      <span>{running ? '分析中' : '已分析'}</span>
      <small className="agent-activity-thought-open-label">查看文字</small>
      <small className="agent-activity-thought-close-label">收起文字</small>
      <Icon name="down" size={14} className="agent-activity-thought-chevron" />
    </summary>
    <div className="agent-activity-text"><MarkdownMessage>{text}</MarkdownMessage></div>
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
      <Icon name="bot" size={16} />
      <span className="agent-activity-title"><small>派发子智能体</small><strong>{agent.name}</strong></span>
      <span className="agent-activity-disclosure">{expanded ? '收起过程' : agent.status === 'running' ? '查看实时过程' : '查看过程'}</span>
      <em className="tool-status"><i aria-hidden="true" />{label}</em>
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

function ReplyLoading({ message, stopping }: { message: ChatMessage; stopping: boolean }) {
  const activeAgent = message.segments?.some(segment => segment.type === 'agent' && segment.agent.status === 'running');
  const activeTool = message.tools?.some(tool => tool.status === 'running')
    || message.segments?.some(segment => segment.type === 'tool' && segment.tool.status === 'running');
  const hasText = Boolean(message.text.trim() || message.segments?.some(segment => segment.type === 'text' && segment.text.trim()));
  const label = stopping ? '正在停止…' : activeAgent ? '智能体正在协作' : activeTool ? '正在执行工具' : hasText ? '正在生成回复' : '正在思考';
  return <div className="reply-loading" role="status" aria-atomic="true">
    <span className="reply-loading-wave" aria-hidden="true"><i /><i /><i /></span>
    <span>{label}</span>
  </div>;
}

type HistoryControls = {
  sessions: ClientChatSession[];
  activeSessionId: string;
  open: boolean;
  loading: boolean;
  loadingSessionId: string;
  error: string;
  toggle: () => void;
  refresh: () => void;
  select: (sessionId: string) => void;
};

function sessionTime(value: ClientChatSession['updatedAt']): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function AgentPanel({ chatDraft, draftScope, host, connected, messages, busy, stopping, send, stop, clear, disabled, history, collapsed }: {
  chatDraft: ChatAttachmentDraft;
  draftScope: number;
  host?: Host;
  connected: boolean;
  messages: ChatMessage[];
  busy: boolean;
  stopping: boolean;
  send: (text: string, attachments: ChatAttachment[]) => Promise<boolean>;
  stop: () => void;
  clear: () => void;
  disabled: boolean;
  history: HistoryControls;
  collapsed: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const scopeRef = useRef(draftScope);
  scopeRef.current = draftScope;
  const attachmentInput = useRef<HTMLInputElement>(null);
  const attachments = useSyncExternalStore(chatDraft.subscribe, chatDraft.getSnapshot);
  const locked = disabled || busy || stopping || sending;
  const notReady = attachments.some(item => item.status !== 'success');
  const addFiles = (files: File[]) => {
    try { chatDraft.add(files); setAttachmentError(''); }
    catch (error) { setAttachmentError((error as Error).message); }
  };
  const attachFiles = (files: ChatAttachment[]) => {
    if (locked) return;
    try { chatDraft.attach(files); setAttachmentError(''); textareaRef.current?.focus(); }
    catch (error) { setAttachmentError((error as Error).message); }
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    if (locked || sendingRef.current) return;
    const scope = draftScope;
    try {
      const files = chatDraft.ready();
      const invalid = validateChatContent(draft, files);
      if (invalid) { setAttachmentError(invalid); return; }
      followOutputRef.current = true;
      sendingRef.current = true;
      setSending(true);
      setAttachmentError('');
      const success = await send(draft.trim(), files);
      if (scopeRef.current !== scope) return;
      if (success) { setDraft(''); chatDraft.clear(); }
    } catch (error) {
      if (scopeRef.current === scope) setAttachmentError((error as Error).message);
    } finally {
      if (scopeRef.current === scope) { sendingRef.current = false; setSending(false); }
    }
  };

  useLayoutEffect(() => {
    followOutputRef.current = true;
  }, [history.activeSessionId]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container && followOutputRef.current) container.scrollTop = container.scrollHeight;
  }, [messages, busy]);

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
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 180)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, [draft]);

  useEffect(() => { setDraft(''); setAttachmentError(''); setSending(false); sendingRef.current = false; }, [draftScope]);

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

  return <aside className={`agent-panel conversation-only ${collapsed ? 'collapsed' : ''}`}>
    <section className="conversation-card" id="agent-panel-content" aria-hidden={collapsed}>
      <header>
        <div className="conversation-title">
          <AgentAvatar compact />
          <span><h3>智能体对话</h3><small><i className={`status-dot ${connected ? '' : 'offline'}`} />{host?.name ?? '尚未选择服务器'}</small></span>
        </div>
        <button type="button" className="agent-history-button" aria-label="历史会话" aria-expanded={history.open}
          aria-controls="agent-history-list" onClick={history.toggle} disabled={disabled || busy}>
          <Icon name="history" size={16} /><span>历史</span>
        </button>
        <button type="button" className="new-agent-session" onClick={() => { clear(); setDraft(''); }} aria-label="新建智能体会话">
          <Icon name="edit" size={15} />
          <strong>新会话</strong>
        </button>
      </header>

      {history.open && <section id="agent-history-list" className="agent-history-popover" aria-label="历史会话列表">
        <div className="agent-history-heading"><strong>历史会话</strong><button type="button" onClick={history.refresh} disabled={history.loading} aria-label="刷新历史会话"><Icon name="refresh" size={15} /></button></div>
        {history.error && <p className="agent-history-note error">{history.error}</p>}
        {history.loading && !history.sessions.length && <p className="agent-history-note">正在加载历史会话…</p>}
        {!history.loading && !history.error && !history.sessions.length && <p className="agent-history-note">暂无历史会话</p>}
        <div className="agent-history-items">
          {history.sessions.map(session => <button type="button" key={session.sessionId}
            className={`agent-history-item ${session.sessionId === history.activeSessionId ? 'active' : ''}`}
            aria-current={session.sessionId === history.activeSessionId ? 'page' : undefined}
            disabled={Boolean(history.loadingSessionId)} onClick={() => history.select(session.sessionId)}>
            <span className="agent-history-title">{session.title?.trim() || '新会话'}</span>
            <span className="agent-history-meta">{history.loadingSessionId === session.sessionId ? '正在加载…' : `${session.messageCount ?? 0} 条消息`}{sessionTime(session.updatedAt) && ` · ${sessionTime(session.updatedAt)}`}</span>
          </button>)}
        </div>
      </section>}

      <div className="chat-messages" ref={scrollRef} aria-label="聊天记录" aria-live="polite"
        onScroll={handleMessagesScroll} onWheel={event => { if (event.deltaY < 0) followOutputRef.current = false; }}>
        {messages.length === 0 && !busy && <div className="agent-chat-empty">
          <img className="empty-agent-avatar" src={agentRobotAvatar} alt="Agent 机器人" />
          <h3>有什么需要我协助？</h3>
          <p>{disabled ? '智能体正在加载，请稍后再试。' : connected ? '可以让我执行命令、检查服务状态或分析日志。' : '可以直接与 Agent 对话；当前页签连接服务器后还可以执行 SSH 命令。'}</p>
        </div>}

        {messages.map((message, index) => message.role === 'user'
          ? <div className="user-message-group" key={message.id}>
            <div className="user-message">{message.text && <div>{message.text}</div>}{!!message.attachments?.length && <MessageAttachments files={message.attachments} attach={attachFiles} disabled={locked} />}</div>
            <div className="message-copy-actions"><button type="button" className="chat-restore-request" disabled={locked} onClick={() => {
              if (draft.trim() || attachments.length) { setAttachmentError('请先清空当前草稿，再恢复这条请求。'); return; }
              try { chatDraft.attach(message.attachments ?? []); setDraft(message.text); setAttachmentError(''); textareaRef.current?.focus(); }
              catch (error) { setAttachmentError((error as Error).message); }
            }}>恢复请求</button><CopyMarkdownButton getText={() => messageToMarkdown(message)} label="复制请求（Markdown）" /></div>
          </div>
          : <div className={`assistant-message ${message.error ? 'error' : ''} ${(busy || stopping) && index === messages.length - 1 ? 'active' : ''}`} key={message.id}>
            <AgentAvatar />
            <div className="assistant-main">
              {message.segments
                ? message.segments.map(segment => segment.type === 'text'
                  ? <div className="assistant-content" key={segment.id}><MarkdownMessage>{segment.text}</MarkdownMessage></div>
                  : segment.type === 'agent'
                    ? <AgentActivity agent={segment.agent} copyable={!((busy || stopping) && index === messages.length - 1)} key={segment.id} />
                    : <section className="tool-activities" aria-label="工具调用记录" key={segment.id}><ToolActivity tool={segment.tool} copyable={!((busy || stopping) && index === messages.length - 1)} /></section>)
                : <>
                  {(message.text || message.summary) && <div className="assistant-content">
                    {message.text && <MarkdownMessage>{message.text}</MarkdownMessage>}
                    {message.summary && <MarkdownMessage>{message.summary}</MarkdownMessage>}
                  </div>}
                  {message.tools?.length ? <section className="tool-activities" aria-label="工具调用记录">
                    {message.tools.map(tool => <ToolActivity tool={tool} copyable={!((busy || stopping) && index === messages.length - 1)} key={tool.id} />)}
                  </section> : null}
                </>}
              {message.error && <p className="chat-error-guidance">{chatErrorGuidance(message.errorCode)}</p>}
              {(busy || stopping) && index === messages.length - 1
                ? <ReplyLoading message={message} stopping={stopping} />
                : <div className="message-copy-actions"><CopyMarkdownButton getText={() => messageToMarkdown(message)} label="复制回复（Markdown）" /></div>}
            </div>
          </div>)}
      </div>
    </section>

    <form className="chat-composer" aria-hidden={collapsed} onSubmit={event => { event.preventDefault(); void submit(); }}>
      {!!attachments.length && <DraftAttachments items={attachments} draft={chatDraft} locked={locked} report={setAttachmentError} />}
      <div className="composer-input-row"><textarea ref={textareaRef} rows={1} aria-label="智能体任务输入" placeholder="输入问题，或粘贴截图与文件" value={draft} disabled={locked} onChange={event => setDraft(event.target.value)}
        onPaste={event => {
          const files = pastedFiles(event.clipboardData);
          if (!files.length) return;
          event.preventDefault();
          if (locked) return;
          const text = event.clipboardData.getData('text/plain');
          if (text) {
            const next = insertPastedText(event.currentTarget.value, text, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
            setDraft(next.text);
            const scope = draftScope;
            requestAnimationFrame(() => { if (scopeRef.current === scope) textareaRef.current?.setSelectionRange(next.cursor, next.cursor); });
          }
          addFiles(files);
        }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /></div>
      <div className="composer-bottom-bar">
        <button type="button" className="composer-attach-button" disabled={locked} onClick={() => attachmentInput.current?.click()} title="选择图片、PDF 或文本文件"><Icon name="attach" size={16} />附件</button>
        <input ref={attachmentInput} type="file" multiple tabIndex={-1} className="visually-hidden" aria-label="选择聊天附件" accept={chatAttachmentPolicy.extensions.map(ext => `.${ext}`).join(',')} onChange={event => {
          if (!locked && event.target.files?.length) addFiles(Array.from(event.target.files));
          event.target.value = '';
        }} />
        <span className="composer-attachment-note">{attachments.length}/4 · 合计 ≤ 20 MB</span>
        {busy || stopping
          ? <button type="button" className="send-button stop-button" aria-label={stopping ? '正在停止' : '停止生成'} title={stopping ? '正在停止' : '停止生成'} onClick={stop} disabled={stopping}><Icon name="stop" size={16} /></button>
          : <button type="submit" className="send-button" aria-label="发送消息" disabled={(!draft.trim() && !attachments.length) || locked || notReady}><Icon name="send" size={20} /></button>}
      </div>
      {(attachmentError || notReady) && <p className="composer-attachment-error" role="status">{attachmentError || (attachments.some(item => item.status === 'error') ? '附件上传失败，请重试或移除后再发送。' : '附件正在准备中，请等待上传完成。')}</p>}
    </form>
  </aside>;
}
