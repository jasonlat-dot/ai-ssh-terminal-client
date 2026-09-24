import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import agentRobotAvatar from '../assets/agent-robot-avatar.png';
import type { ClientChatSession } from '../state/clientChatHistory';
import type { ChatAgentActivity, ChatMessage, ChatToolActivity, Host } from '../types';
import { Icon } from './Ui';

function AgentAvatar({ compact = false }: { compact?: boolean }) {
  return <span className={`agent-avatar ${compact ? 'compact' : ''}`}><img src={agentRobotAvatar} alt="Agent 机器人" /></span>;
}

/**
 * 使用 react-markdown 渲染模型回复。
 * 默认不会执行回复中的原始 HTML；remark-gfm 补充表格、删除线、任务列表等常见 Markdown 语法。
 */
function MarkdownMessage({ children }: { children: string }) {
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
}

function ToolActivity({ tool }: { tool: ChatToolActivity }) {
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
  </details>;
}

function AgentTextActivity({ text, running }: { text: string; running: boolean }) {
  return <details className="agent-activity-thought">
    <summary>
      <Icon name="bulb" size={15} />
      <span>{running ? '分析中' : '已分析'}</span>
      <small className="agent-activity-thought-open-label">查看文字</small>
      <small className="agent-activity-thought-close-label">收起文字</small>
      <Icon name="down" size={14} className="agent-activity-thought-chevron" />
    </summary>
    <div className="agent-activity-text"><MarkdownMessage>{text}</MarkdownMessage></div>
  </details>;
}

function AgentActivity({ agent }: { agent: ChatAgentActivity }) {
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
          ? <AgentTextActivity text={segment.text} running={agent.status === 'running'} key={segment.id} />
          : <ToolActivity tool={segment.tool} key={segment.id} />)
        : agent.tools.map(tool => <ToolActivity tool={tool} key={tool.id} />)}
      {showFinalFallback && <AgentTextActivity text={agent.output!} running={false} />}
      {!agent.segments?.length && !agent.tools.length && !showFinalFallback && <p className="agent-activity-empty">
        {agent.status === 'running' ? '子智能体正在分析…' : '子智能体没有返回文本。'}
      </p>}
    </div>}
  </section>;
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

export function AgentPanel({ host, messages, busy, stopping, send, stop, clear, disabled, history, collapsed, toggleCollapsed }: {
  host?: Host;
  messages: ChatMessage[];
  busy: boolean;
  stopping: boolean;
  send: (text: string) => void;
  stop: () => void;
  clear: () => void;
  disabled: boolean;
  history: HistoryControls;
  collapsed: boolean;
  toggleCollapsed: () => void;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (draft.trim() && !busy && !disabled) {
      // 新一轮对话从底部开始；之后是否继续跟随由用户的滚动位置决定。
      followOutputRef.current = true;
      send(draft.trim());
      setDraft('');
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

  useEffect(() => { setDraft(''); }, [history.activeSessionId]);

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
    <button type="button" className="agent-panel-toggle panel-edge-toggle" onClick={toggleCollapsed} aria-label={collapsed ? '展开智能体对话' : '收起智能体对话'} aria-expanded={!collapsed} aria-controls="agent-panel-content" title={collapsed ? '展开智能体对话' : '收起智能体对话'}><Icon name="sidebarToggle" size={16} /></button>
    <section className="conversation-card" id="agent-panel-content" aria-hidden={collapsed}>
      <header>
        <div className="conversation-title">
          <AgentAvatar compact />
          <span><h3>智能体对话</h3><small><i className={`status-dot ${host?.online ? '' : 'offline'}`} />{host?.name ?? '尚未选择服务器'}</small></span>
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
          <p>{disabled ? '智能体正在加载，请稍后再试。' : host?.online ? '可以让我执行命令、检查服务状态或分析日志。' : '可以直接与 Agent 对话；连接服务器后还可以执行 SSH 命令。'}</p>
        </div>}

        {messages.map((message, index) => message.role === 'user'
          ? <div className="user-message" key={message.id}>{message.text}</div>
          : <div className={`assistant-message ${message.error ? 'error' : ''} ${busy && index === messages.length - 1 ? 'active' : ''}`} key={message.id}>
            <AgentAvatar />
            <div className="assistant-main">
              {message.segments
                ? message.segments.map(segment => segment.type === 'text'
                  ? <div className="assistant-content" key={segment.id}><MarkdownMessage>{segment.text}</MarkdownMessage></div>
                  : segment.type === 'agent'
                    ? <AgentActivity agent={segment.agent} key={segment.id} />
                    : <section className="tool-activities" aria-label="工具调用记录" key={segment.id}><ToolActivity tool={segment.tool} /></section>)
                : <>
                  {(message.text || message.summary) && <div className="assistant-content">
                    {message.text && <MarkdownMessage>{message.text}</MarkdownMessage>}
                    {message.summary && <MarkdownMessage>{message.summary}</MarkdownMessage>}
                  </div>}
                  {message.tools?.length ? <section className="tool-activities" aria-label="工具调用记录">
                    {message.tools.map(tool => <ToolActivity tool={tool} key={tool.id} />)}
                  </section> : null}
                </>}
              {busy && index === messages.length - 1 && <div className="assistant-content"><div className="assistant-processing">
                <strong>Agent 正在处理 <span className="typing-dots"><i /><i /><i /></span></strong>
                <span className="processing-status"><i />处理中</span>
              </div></div>}
            </div>
          </div>)}
      </div>
    </section>

    <form className="chat-composer" aria-hidden={collapsed} onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="composer-input-row"><textarea ref={textareaRef} rows={1} aria-label="智能体任务输入" placeholder="例如：帮我查看 Nginx 状态" value={draft} disabled={disabled || busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        {busy || stopping
          ? <button type="button" className="send-button stop-button" aria-label={stopping ? '正在停止' : '停止生成'}
              title={stopping ? '正在停止' : '停止生成'} onClick={stop} disabled={stopping}><Icon name="stop" size={16} /></button>
          : <button type="submit" className="send-button" aria-label="发送消息" disabled={!draft.trim() || disabled}><Icon name="send" size={20} /></button>}
      </div>
    </form>
  </aside>;
}
