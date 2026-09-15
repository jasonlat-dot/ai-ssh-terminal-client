import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import agentRobotAvatar from '../assets/agent-robot-avatar.png';
import type { ChatMessage, ChatToolActivity, Host } from '../types';
import { Icon, IconButton } from './Ui';

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

export function AgentPanel({ host, messages, busy, send, clear, notify, disabled, agentName }: {
  host?: Host;
  messages: ChatMessage[];
  busy: boolean;
  send: (text: string) => void;
  clear: () => void;
  notify: (text: string) => void;
  disabled: boolean;
  agentName?: string;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const submit = () => {
    if (draft.trim() && !busy && !disabled) {
      send(draft.trim());
      setDraft('');
    }
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

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

  return <aside className="agent-panel conversation-only">
    <section className="conversation-card">
      <header>
        <div className="conversation-title">
          <AgentAvatar compact />
          <span><h3>智能体对话</h3><small><i className={`status-dot ${host?.online ? '' : 'offline'}`} />{host?.name ?? '尚未选择服务器'}</small></span>
        </div>
        <button className="new-agent-session" onClick={() => { clear(); setDraft(''); }} aria-label="新建智能体会话">
          <Icon name="edit" size={15} />
          <strong>新会话</strong>
          <kbd>Ctrl + Shift + O</kbd>
        </button>
      </header>

      <div className="chat-messages" ref={scrollRef} aria-label="聊天记录" aria-live="polite">
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

    <form className="chat-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      <p>{disabled ? '智能体正在加载，请稍后再试' : host?.online ? '输入任务，让 Agent 帮你完成…' : '无需连接终端，也可以直接与 Agent 对话'}</p>
      <div className="composer-input-row"><IconButton icon="attach" label="添加聊天附件" onClick={() => notify('暂未接入聊天附件。')} /><textarea aria-label="智能体任务输入" placeholder="例如：帮我查看 Nginx 状态" value={draft} disabled={disabled || busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} /><button type="submit" className="send-button" aria-label="发送消息" disabled={!draft.trim() || busy || disabled}><Icon name="send" size={20} /></button></div>
      <div className="composer-toolbar"><button type="button" className="model-select outlined-button" onClick={() => notify(`当前智能体：${agentName || '正在加载'}`)}>{agentName || 'Agent'}<Icon name="down" size={13} /></button></div>
    </form>
  </aside>;
}
