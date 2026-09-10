import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Host } from '../types';
import { Icon, IconButton, Toggle } from './Ui';

function Robot() {
  return <div className="robot-art" aria-hidden="true"><span className="robot-antenna" /><div className="robot-head"><span className="robot-face"><i /><i /></span></div><div className="robot-body"><i /></div><span className="robot-hand left" /><span className="robot-hand right" /></div>;
}
export function AgentPanel({ host, local, messages, busy, send, clear, confirm, setConfirm, runLogs, notify, disabled, connect, openFiles, openCommands, settings }: {
  host?: Host; local: boolean; messages: ChatMessage[]; busy: boolean; send: (text: string) => void; clear: () => void;
  confirm: boolean; setConfirm: (value: boolean) => void; runLogs: () => void; notify: (text: string) => void; disabled: boolean;
  connect: () => void; openFiles: () => void; openCommands: () => void; settings: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [updated, setUpdated] = useState(() => new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  const scrollRef = useRef<HTMLDivElement>(null);
  const submit = () => { if (draft.trim() && !busy) { send(draft.trim()); setDraft(''); } };
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, busy]);
  const healthy = local || !!host?.online;
  return <aside className="agent-panel">
    <div className="agent-dashboard-scroll">
      <section className="agent-welcome">
        <div className="agent-heading"><h2>智能体</h2>{messages.length > 0 && <button className="text-button new-chat" onClick={() => { clear(); setDraft(''); }}>新建对话</button>}</div>
        <div className="welcome-body"><button className="connection-select outlined-button" onClick={connect}><i className={`status-dot ${healthy ? '' : 'offline'}`} />{local ? '本地连接' : host?.name ?? '选择连接'}<Icon name="down" size={13} /></button><div className="welcome-note"><p>我可以帮你管理服务器<br />执行命令、分析日志、<br />解决问题～</p><Robot /></div></div>
        <div className="quick-actions"><button className="quick-action green" onClick={connect}><span className="quick-icon"><Icon name="server" size={23} /></span><strong>新建连接</strong><small>快速连接主机</small></button><button className="quick-action" onClick={openFiles}><span className="quick-icon"><Icon name="folder" size={23} /></span><strong>打开文件</strong><small>浏览远程文件</small></button><button className="quick-action violet" onClick={openCommands}><span className="quick-icon"><Icon name="terminal" size={23} /></span><strong>执行命令</strong><small>智能命令助手</small></button></div>
      </section>
      <section className="system-card"><header><span className="card-heading"><span className="card-icon"><Icon name="network" size={17} /></span><h3>系统状态</h3></span><small>更新于 {updated}</small><IconButton icon="refresh" label="刷新系统状态" onClick={() => { setUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false })); notify('系统状态已更新（模拟数据）'); }} /></header><div className="system-results">{['容器状态', '磁盘检查'].map((title, index) => <button key={title} className="system-result" onClick={() => notify(`${title}：${healthy ? '演示环境正常，未查询真实服务器。' : '主机未连接。'}`)}><span className={`check-circle ${healthy ? '' : 'unavailable'}`}><Icon name={healthy ? 'check' : 'close'} size={14} /></span><span>{title}</span><em>{healthy ? index === 0 ? '正常运行' : '正常' : '未连接'}</em><Icon name="right" size={15} /></button>)}<p>{healthy ? '服务器运行正常，磁盘使用率 35%，可用空间 52 GB。' : '当前主机未连接，连接后可查看模拟系统状态。'}</p></div></section>
      <section className="advice-card"><header><span className="card-heading"><span className="card-icon amber"><Icon name="bulb" size={18} /></span><h3>操作建议</h3></span></header><div><Icon name="file" size={17} /><span>建议定期检查容器运行日志</span><button disabled={disabled} onClick={runLogs}>查看日志</button></div><div><Icon name="upload" size={17} /><span>可设置日志轮转，防止磁盘占满</span><button onClick={settings}>去设置</button></div></section>
      {messages.length > 0 && <section className="conversation-card"><header><h3>任务对话</h3><IconButton icon="close" label="清空任务对话" onClick={clear} /></header><div className="chat-messages" ref={scrollRef} aria-label="聊天记录" aria-live="polite">{messages.map(message => message.role === 'user' ? <div className="user-message" key={message.id}>{message.text}</div> : <div className="assistant-message" key={message.id}><span className="agent-avatar"><Icon name="bot" size={20} /></span><div className="assistant-content"><p>{message.text}</p><p>{message.summary}</p>{message.suggestion && <button className="text-button" disabled={disabled} onClick={runLogs}>查看错误日志<Icon name="right" size={13} /></button>}</div></div>)}{busy && <div className="chat-pending">正在生成模拟回复<span className="typing-dots">•••</span></div>}</div></section>}
    </div>
    <form className="chat-composer" onSubmit={e => { e.preventDefault(); submit(); }}><p>输入任务，让 Agent 帮你完成…</p><div className="composer-input-row"><IconButton icon="attach" label="添加聊天附件" onClick={() => notify('演示版本暂未接入聊天附件。')} /><textarea aria-label="智能体任务输入" placeholder="例如：帮我查看 Nginx 状态" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} /><button type="submit" className="send-button" aria-label="发送消息" disabled={!draft.trim() || busy}><Icon name="send" size={20} /></button></div><div className="composer-toolbar"><button type="button" className="model-select outlined-button" onClick={() => notify('当前模型：Agent（本地模拟）。')}>Agent<Icon name="down" size={13} /></button><label className="confirm-label">执行前确认<Toggle value={confirm} onChange={setConfirm} label="执行前确认" /></label></div></form>
  </aside>;
}
