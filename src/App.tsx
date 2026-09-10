import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentPanel } from './components/AgentPanel';
import { AddCommandDialog, CreateFileDialog, SearchDialog } from './components/Dialogs';
import { ConnectionSidebar } from './components/Sidebar';
import { ActivityBar, AppHeader, StatusBar } from './components/Shell';
import { Icon, Modal, Toggle } from './components/Ui';
import { CommandShelf, TerminalWorkspace } from './components/Workspace';
import { commandOutput, createFiles, hosts, initialCommands, mockReply, mockTransferProgress } from './data/mock';
import type { ChatMessage, HistoryItem, Navigation, TerminalSession, TransferItem } from './types';
import './App.css';
import './reference.css';

type Dialog = 'command' | 'file' | 'search' | 'history' | 'settings' | 'connections' | null;
type PendingCommand = { sessionId: string; command: string };
const initialSessions: TerminalSession[] = [
  { id: 'local-session', hostId: null, title: '本地终端', input: '', entries: [], busy: false },
];

export default function App() {
  const [navigation, setNavigation] = useState<Navigation>('连接');
  const [sessions, setSessions] = useState(initialSessions);
  const [activeId, setActiveId] = useState('local-session');
  const [files, setFiles] = useState(createFiles);
  const [selectedFile, setSelectedFile] = useState('logs/access.log');
  const [expanded, setExpanded] = useState(new Set(['logs']));
  const [commands, setCommands] = useState(initialCommands);
  const [category, setCategory] = useState('全部');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [confirm, setConfirm] = useState(true);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [transfers, setTransfers] = useState<TransferItem[]>([{ id: 'seed', name: 'deploy.tar.gz', progress: 100 }]);
  const [toast, setToast] = useState('');
  const [focusTick, setFocusTick] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [commandCollapsed, setCommandCollapsed] = useState(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chatVersion = useRef(0);
  const chatting = useRef(false);
  const running = useRef(new Set<string>());
  const active = sessions.find(session => session.id === activeId);
  const host = hosts.find(item => item.id === active?.hostId);
  const canRun = !!active && !active.busy && (!active.hostId || !!host?.online);

  const later = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.current.delete(timer); callback(); }, delay);
    timers.current.add(timer);
    return timer;
  }, []);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const notify = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) { clearTimeout(toastTimer.current); timers.current.delete(toastTimer.current); }
    toastTimer.current = later(() => setToast(''), 3600);
  }, [later]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!pending) setDialog(value => value === 'search' ? null : 'search'); } };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [pending]);

  const closeDialog = () => { setDialog(null); setNavigation(value => value === '设置' || value === '历史' ? '连接' : value); };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); notify('已复制到剪贴板'); }
    catch { notify('复制失败：请选中文字后使用 Ctrl+C 复制。'); }
  };
  const newSession = () => {
    const id = crypto.randomUUID();
    setSessions(previous => [...previous, { id, hostId: null, title: `本地终端 ${previous.filter(s => !s.hostId).length + 1}`, input: '', entries: [], busy: false }]);
    setActiveId(id);
    return id;
  };
  const selectHost = (id: string) => {
    const nextHost = hosts.find(item => item.id === id)!;
    const existing = sessions.find(session => session.hostId === id);
    if (existing) setActiveId(existing.id);
    else {
      const sessionId = crypto.randomUUID();
      setSessions(previous => [...previous, { id: sessionId, hostId: id, title: nextHost.name, input: '', entries: [], busy: false }]);
      setActiveId(sessionId);
    }
    if (!nextHost.online) notify('api-prod-02 当前离线，无法执行命令。');
  };
  const closeSession = (id: string) => {
    const remaining = sessions.filter(session => session.id !== id);
    setSessions(remaining);
    if (activeId === id) setActiveId(remaining[0]?.id ?? '');
    if (!remaining.length) setMaximized(false);
    running.current.delete(id);
  };
  const fill = (command: string) => {
    const id = active?.id ?? newSession();
    setSessions(previous => previous.map(session => session.id === id ? { ...session, input: command } : session));
    setFocusTick(value => value + 1);
  };
  const execute = (request: PendingCommand) => {
    const session = sessions.find(item => item.id === request.sessionId);
    if (!session || running.current.has(session.id)) return;
    if (session.hostId && !hosts.find(item => item.id === session.hostId)?.online) { notify('主机离线，无法执行命令。'); return; }
    running.current.add(session.id);
    setSessions(previous => previous.map(item => item.id === session.id ? { ...item, busy: true, input: '' } : item));
    setHistory(previous => [{ id: crypto.randomUUID(), command: request.command, session: session.title, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }, ...previous]);
    later(() => {
      running.current.delete(session.id);
      setSessions(previous => previous.map(item => item.id === session.id ? { ...item, busy: false, entries: [...item.entries, { id: crypto.randomUUID(), command: request.command, output: commandOutput(request.command) }] } : item));
    }, 550);
  };
  const requestRun = (command = active?.input ?? '') => {
    if (!command.trim()) return;
    if (!active) { notify('请先新建终端会话。'); return; }
    if (!canRun) { notify(active.busy ? '命令正在执行，请稍候。' : '主机离线，无法执行命令。'); return; }
    const request = { sessionId: active.id, command: command.trim() };
    if (confirm) setPending(request); else execute(request);
  };
  const navigate = (name: Navigation) => {
    setNavigation(name);
    if (name === '连接') { setDialog('connections'); return; }
    if (name === '命令') setCommandCollapsed(false);
    if (name === '设置' || name === '历史') { setDialog(name === '设置' ? 'settings' : 'history'); return; }
    setMaximized(false);
    const id = name === '文件' ? 'files' : 'commands';
    later(() => document.getElementById(id)?.focus(), 0);
  };
  const upload = (chosen: FileList) => {
    const items = Array.from(chosen).map(file => ({ id: crypto.randomUUID(), name: file.name, progress: 0 }));
    setTransfers(previous => [...previous, ...items]);
    const tick = (progress: number) => {
      const next = mockTransferProgress(progress);
      setTransfers(previous => previous.map(item => items.some(newItem => newItem.id === item.id) ? { ...item, progress: next } : item));
      if (next < 100) later(() => tick(next), 300);
      else notify('模拟传输完成，未上传到真实服务器。');
    };
    later(() => tick(0), 300);
    notify('开始模拟传输，仅演示进度。');
  };
  const sendMessage = (text: string) => {
    if (chatting.current) return;
    chatting.current = true;
    const version = chatVersion.current;
    setMessages(previous => [...previous, { id: crypto.randomUUID(), role: 'user', text }]);
    setChatBusy(true);
    later(() => {
      if (version !== chatVersion.current) return;
      setMessages(previous => [...previous, mockReply(text)]);
      chatting.current = false;
      setChatBusy(false);
    }, 900);
  };
  const clearChat = () => { chatVersion.current += 1; chatting.current = false; setChatBusy(false); setMessages([]); };

  return <div className={`app-shell ${maximized ? 'terminal-maximized' : ''}`}>
    <AppHeader search={() => setDialog('search')} settings={() => navigate('设置')} notify={notify} />
    <ActivityBar active={navigation} onSelect={navigate} />
    <ConnectionSidebar hosts={hosts} hostId={active?.hostId} chooseHost={selectHost} files={files} selected={selectedFile} expanded={expanded} select={setSelectedFile} toggle={id => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} transfers={transfers} upload={upload} refresh={() => { setFiles(createFiles()); setExpanded(new Set(['logs'])); setSelectedFile('logs/access.log'); notify('已恢复演示文件树'); }} create={() => setDialog('file')} copy={copy} notify={notify} />
    <main className={`central-workspace ${commandCollapsed ? 'command-collapsed' : ''}`}><TerminalWorkspace sessions={sessions} activeId={activeId} host={host} select={setActiveId} close={closeSession} add={newSession} changeInput={input => setSessions(previous => previous.map(session => session.id === activeId ? { ...session, input } : session))} run={() => requestRun()} fillFocus={focusTick} maximize={() => setMaximized(value => !value)} isMaximized={maximized} notify={notify} /><CommandShelf commands={commands} category={category} setCategory={setCategory} fill={fill} run={requestRun} copy={copy} add={() => setDialog('command')} disabled={!canRun} collapsed={commandCollapsed} toggleCollapsed={() => setCommandCollapsed(value => !value)} /></main>
    <AgentPanel host={host} local={!!active && !active.hostId} messages={messages} busy={chatBusy} send={sendMessage} clear={clearChat} confirm={confirm} setConfirm={setConfirm} runLogs={() => requestRun('tail -f logs/error.log')} notify={notify} disabled={!canRun} connect={() => setDialog('connections')} openFiles={() => navigate('文件')} openCommands={() => { navigate('命令'); setFocusTick(value => value + 1); }} settings={() => navigate('设置')} />
    <StatusBar host={host} local={!!active && !active.hostId} onInfo={() => notify('演示模式：SSH、SFTP、延迟与智能体结果均为模拟数据。')} />
    {toast && <div className="toast" role="status"><Icon name="bulb" size={18} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><Icon name="close" size={15} /></button></div>}
    {dialog === 'command' && <AddCommandDialog close={closeDialog} save={command => { setCommands(previous => [...previous, command]); setCategory(command.category); closeDialog(); notify('命令已添加到当前演示'); }} />}
    {dialog === 'file' && <CreateFileDialog close={closeDialog} files={files} save={file => { setFiles(previous => [...previous, file]); setSelectedFile(file.id); closeDialog(); notify('已在演示文件树中创建'); }} />}
    {dialog === 'search' && <SearchDialog close={closeDialog} hosts={hosts} files={files} commands={commands} choose={(kind, value) => { closeDialog(); if (kind === 'host') selectHost(value); if (kind === 'command') { fill(value); later(() => setFocusTick(tick => tick + 1), 0); } if (kind === 'file') { setSelectedFile(value); const parts = value.split('/'); setExpanded(previous => new Set([...previous, ...parts.slice(0, -1)])); navigate('文件'); } }} />}
    {dialog === 'connections' && <Modal title="连接主机" onClose={closeDialog}><div className="connection-options"><p className="muted">选择演示主机，或打开本地终端。</p>{hosts.map(item => <button className="connection-option" key={item.id} onClick={() => { selectHost(item.id); closeDialog(); }}><i className={`status-dot ${item.online ? '' : 'offline'}`} /><span><strong>{item.name}</strong><small>{item.user} · {item.address}</small></span><em>{item.online ? '在线' : '离线'}</em><Icon name="right" size={16} /></button>)}<button className="primary-button" onClick={() => { newSession(); closeDialog(); }}><Icon name="terminal" size={17} />新建本地终端</button></div></Modal>}
    {dialog === 'settings' && <Modal title="演示设置" onClose={closeDialog}><div className="settings-content"><div><span><strong>执行前确认</strong><small>提交任何模拟命令前显示确认弹窗</small></span><Toggle value={confirm} onChange={setConfirm} label="设置执行前确认" /></div><p>当前使用本地模拟数据。没有连接真实 SSH、SFTP 或 AI 服务；刷新页面后，新增内容和偏好会恢复默认。</p><p className="muted">Agent SSH · v0.1.0</p></div></Modal>}
    {dialog === 'history' && <Modal title="命令执行历史（模拟）" onClose={closeDialog} wide><div className="history-list">{history.length ? history.map(item => <div key={item.id}><span><strong>{item.session}</strong><time>{item.time}</time></span><code>{item.command}</code></div>) : <p className="empty-state">暂无执行记录。运行一条常用命令后会显示在这里。</p>}</div></Modal>}
    {pending && <Modal title="确认执行命令" onClose={() => setPending(null)}><div className="confirm-content"><p>目标：{sessions.find(session => session.id === pending.sessionId)?.title}</p><pre>{pending.command}</pre><p className="muted">命令仅在演示环境中模拟执行，不会访问本机 shell 或真实服务器。</p><div className="dialog-actions"><button className="outlined-button" onClick={() => setPending(null)}>取消</button><button className="primary-button" onClick={() => { const request = pending; setPending(null); execute(request); }}>确认执行</button></div></div></Modal>}
  </div>;
}
