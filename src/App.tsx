import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { updateSessionFiles } from './state/sessionFiles';
import { agentApi } from './api/agent';
import type { AgentConfig, AgentStreamEvent } from './api/agent';
import { DisconnectDialog } from './components/DisconnectDialog';
import { recordDisconnect } from './state/connectionHistory';
import { terminalApi } from './api/terminal';
import { RemoteTerminal } from './state/remoteTerminal';
import { NotificationToast } from './components/NotificationToast';
import type { Notice, NoticeType } from './components/NotificationToast';
import { Connections } from './components/Connections';
import { SshConnectionDialog } from './components/SshConnectionDialog';
import { useSshConnections } from './state/useSshConnections';
import { PanelDivider } from './components/PanelDivider';
import { AgentPanel } from './components/AgentPanel';
import { AddCommandDialog, CreateFileDialog, SearchDialog } from './components/Dialogs';
import { SessionFiles } from './components/Sidebar';
import { ActivityBar, AppHeader, StatusBar } from './components/Shell';
import { Modal } from './components/Ui';
import { CommandShelf, TerminalWorkspace } from './components/Workspace';
import { createSessionFileState, initialCommands, mockTransferProgress } from './data/mock';
import type { ChatMessage, Host, Navigation, TerminalSession, SessionFileState } from './types';
import './App.css';
import './reference.css';

const RemoteTerminalView = lazy(() => import('./components/RemoteTerminalView').then(module => ({ default: module.RemoteTerminalView })));

type Dialog = 'command' | 'connection' | 'file' | 'search' | null;
type PendingCommand = { sessionId: string; command: string };
const initialSessions: TerminalSession[] = [];

export default function App() {
  const [navigation, setNavigation] = useState<Navigation>('连接');
  const connections = useSshConnections();
  const { hosts } = connections;
  const [agentWidth, setAgentWidth] = useState(22);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [sessions, setSessions] = useState(initialSessions);
  const [activeId, setActiveId] = useState('');
  const [commands, setCommands] = useState(initialCommands);
  const [category, setCategory] = useState('全部');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(null);
  const confirm = true;
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<{ sessionId: string; host: Host } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [fileDialogSessionId, setFileDialogSessionId] = useState<string | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  const noticeSequence = useRef(0);
  const [focusTick, setFocusTick] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [commandCollapsed, setCommandCollapsed] = useState(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const chatVersion = useRef(0);
  const chatting = useRef(false);
  const chatSessionId = useRef('');
  const chatAbort = useRef<AbortController | null>(null);
  const running = useRef(new Set<string>());
  const remoteClients = useRef(new Map<string, RemoteTerminal>());
  const opening = useRef(new Set<string>());
  const [terminalError, setTerminalError] = useState('');
  const [connectAfterSave, setConnectAfterSave] = useState(false);
  const active = sessions.find(session => session.id === activeId);
  const host = hosts.find(item => item.id === active?.hostId);
  const canRun = !!active?.hostId && !active.busy && !!host?.online && !!remoteClients.current.get(active.id) && !remoteClients.current.get(active.id)?.closed && !remoteClients.current.get(active.id)?.disconnected;

  const later = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.current.delete(timer); callback(); }, delay);
    timers.current.add(timer);
    return timer;
  }, []);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const notify = useCallback((message: string, type: NoticeType = 'info', durationMs?: number) => {
    setToast({ id: ++noticeSequence.current, message, type, ...(durationMs === undefined ? {} : { durationMs }) });
  }, []);
  const dismissNotice = useCallback(() => setToast(null), []);
  useEffect(() => { if (connections.error) notify(connections.error, 'error'); }, [connections.error, notify]);
  useEffect(() => {
    let cancelled = false;
    void agentApi.list()
      .then(items => {
        if (cancelled) return;
        if (!items.length) throw new Error('后端没有可用的智能体配置。');
        setSelectedAgent(items[0]);
      })
      .catch(error => {
        if (!cancelled) notify(error instanceof Error ? error.message : '加载智能体失败', 'error');
      });
    return () => { cancelled = true; };
  }, [notify]);
  useEffect(() => () => chatAbort.current?.abort(), []);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!pending && !disconnectTarget) setDialog(value => value === 'search' ? null : 'search'); } };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [pending, disconnectTarget]);

  const closeDialog = () => { setDialog(null); setFileDialogSessionId(null); };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); notify('已复制到剪贴板', 'success'); }
    catch { notify('复制失败：请选中文字后使用 Ctrl+C 复制。', 'error'); }
  };
  const openNewConnection = () => { setPending(null); setConnectAfterSave(false); setDialog('connection'); };
  const openNewTerminal = () => { setPending(null); setConnectAfterSave(true); setDialog('connection'); };
  const selectHost = async (id: string, suppliedHost?: Host) => {
    if ((!suppliedHost && connections.busy) || opening.current.has(id)) return;
    const nextHost = suppliedHost ?? hosts.find(item => item.id === id);
    if (!nextHost) return;
    opening.current.add(id);
    try {
      if (!nextHost.online && !await connections.connect(id)) { setNavigation('连接'); return; }
      const existing = sessions.find(session => session.hostId === id);
      const sessionId = existing?.id ?? crypto.randomUUID();
      if (!remoteClients.current.get(sessionId) || remoteClients.current.get(sessionId)?.closed || remoteClients.current.get(sessionId)?.disconnected) {
        notify('正在打开远程终端…');
        const opened = await terminalApi.open(id);
        if (!opened?.sessionId) throw new Error('后端未返回终端会话 ID');
        remoteClients.current.set(sessionId, new RemoteTerminal(opened));
      }
      if (!existing) setSessions(previous => [...previous, { id: sessionId, hostId: id, title: nextHost.name, input: '', entries: [], busy: false, fileState: createSessionFileState() }]);
      else setSessions(previous => [...previous]);
      setActiveId(sessionId); setNavigation('命令');
      notify('远程终端已打开，可以开始操作。', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '打开终端失败', 'error'); }
    finally { opening.current.delete(id); }
  };
  const handleTerminalDisconnected = (sessionId: string, message: string) => {
    const session = sessions.find(item => item.id === sessionId);
    if (!session?.hostId) return;
    connections.markDisconnected(session.hostId);
    setSessions(previous => previous.map(item => item.id === sessionId ? { ...item, busy: false } : item));
    running.current.delete(sessionId);
    notify(message, 'error');
  };
  const reconnectTerminal = async (sessionId: string) => {
    const session = sessions.find(item => item.id === sessionId);
    if (!session?.hostId || connections.busy || opening.current.has(session.hostId)) return false;
    opening.current.add(session.hostId);
    remoteClients.current.get(sessionId)?.prepareReconnect();
    notify('正在重新连接服务器并创建终端会话…');
    try {
      if (!await connections.connect(session.hostId)) return false;
      const opened = await terminalApi.open(session.hostId);
      if (!opened?.sessionId) throw new Error('后端未返回终端会话 ID');
      remoteClients.current.set(sessionId, new RemoteTerminal(opened));
      setSessions(previous => previous.map(item => item.id === sessionId ? { ...item, busy: false } : item));
      notify('已重新连接，可以继续操作。', 'success');
      return true;
    } catch (error) {
      connections.markDisconnected(session.hostId);
      notify(error instanceof Error ? error.message : '重新连接失败', 'error');
      return false;
    } finally { opening.current.delete(session.hostId); }
  };
  const closeHostTerminals = async (hostId: string) => {
    setTerminalError('');
    try {
      for (const session of sessions.filter(item => item.hostId === hostId)) await remoteClients.current.get(session.id)?.close();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '关闭终端失败';
      setTerminalError(message); notify(message, 'error'); return false;
    }
  };
  const disconnectHost = async (hostId: string) => {
    if (!await closeHostTerminals(hostId)) return false;
    return connections.disconnect(hostId);
  };
  const removeSessionTab = (id: string) => {
    const remaining = sessions.filter(session => session.id !== id);
    setSessions(remaining);
    if (activeId === id) setActiveId(remaining[0]?.id ?? '');
    if (!remaining.length) setMaximized(false);
    running.current.delete(id);
  };
  const closeSession = (id: string) => {
    const session = sessions.find(item => item.id === id);
    if (!session || disconnectTarget) return;
    if (!session.hostId) { removeSessionTab(id); return; }
    const targetHost = hosts.find(item => item.id === session.hostId);
    if (!targetHost) { removeSessionTab(id); return; }
    setDialog(null); setPending(null);
    setTerminalError('');
    setDisconnectTarget({ sessionId: id, host: targetHost });
  };
  const confirmDisconnect = async () => {
    if (!disconnectTarget || connections.busy) return false;
    const target = disconnectTarget;
    if (!await disconnectHost(target.host.id)) return false;
    let historySaved = true;
    try { recordDisconnect(target.host); }
    catch { historySaved = false; }
    const shouldClose = (session: TerminalSession) => session.id === target.sessionId || session.hostId === target.host.id;
    const remaining = sessions.filter(session => !shouldClose(session));
    sessions.filter(shouldClose).forEach(session => remoteClients.current.delete(session.id));
    sessions.filter(session => session.hostId === target.host.id).forEach(session => running.current.delete(session.id));
    setSessions(previous => previous.filter(session => !shouldClose(session)).map(session => session.hostId === target.host.id ? { ...session, busy: false } : session));
    setActiveId(previous => sessions.some(session => session.id === previous && shouldClose(session)) ? remaining[0]?.id ?? '' : previous);
    if (!remaining.length) setMaximized(false);
    setDisconnectTarget(null);
    notify(historySaved ? `已断开 ${target.host.name}，终端已关闭。` : `已断开 ${target.host.name}，但本机存储不可用，未能保留连接记录。`, historySaved ? 'success' : 'error');
    return true;
  };
  const fill = (command: string) => {
    setNavigation('命令');
    if (!active) { openNewTerminal(); notify('请先添加并连接一台远程服务器。'); return; }
    setSessions(previous => previous.map(session => session.id === active.id ? { ...session, input: command } : session));
    setFocusTick(value => value + 1);
  };
  const execute = async (request: PendingCommand) => {
    const session = sessions.find(item => item.id === request.sessionId);
    if (!session || running.current.has(session.id)) return;
    if (session.hostId && !hosts.find(item => item.id === session.hostId)?.online) { notify('当前终端连接不可用，请点击“重新连接”。', 'error'); return; }
    running.current.add(session.id);
    setSessions(previous => previous.map(item => item.id === session.id ? { ...item, busy: true, input: '' } : item));
    try {
      const client = remoteClients.current.get(session.id);
      if (!session.hostId || !client) throw new Error('当前终端会话不可用，请点击“重新连接”。');
      await client.exec(request.command);
    } catch (error) { notify(`${error instanceof Error ? error.message : '命令提交失败'}；未自动重试，请先检查终端输出。`, 'error'); }
    finally {
      running.current.delete(session.id);
      setSessions(previous => previous.map(item => item.id === session.id ? { ...item, busy: false } : item));
    }
  };
  const requestRun = (command = active?.input ?? '') => {
    if (!command.trim()) return;
    if (!active) { openNewTerminal(); notify('请先添加并连接一台远程服务器。'); return; }
    if (!canRun) { notify(active.busy ? '命令正在执行，请稍候。' : '当前终端连接不可用，请点击“重新连接”。'); return; }
    const request = { sessionId: active.id, command: command.trim() };
    if (confirm) setPending(request); else execute(request);
  };
  const navigate = (name: Navigation) => {
    setNavigation(name);
    setMaximized(false);
    setFocusTick(value => value + 1);
  };
  const updateFiles = (sessionId: string, update: (state: SessionFileState) => SessionFileState) => {
    setSessions(previous => updateSessionFiles(previous, sessionId, update));
  };
  const upload = (sessionId: string, chosen: FileList) => {
    const items = Array.from(chosen).map(file => ({ id: crypto.randomUUID(), name: file.name, progress: 0 }));
    updateFiles(sessionId, state => ({ ...state, transfers: [...state.transfers, ...items] }));
    const tick = (progress: number) => {
      const next = mockTransferProgress(progress);
      updateFiles(sessionId, state => ({ ...state, transfers: state.transfers.map(item => items.some(newItem => newItem.id === item.id) ? { ...item, progress: next } : item) }));
      if (next < 100) later(() => tick(next), 300);
      else notify('模拟传输完成，未上传到真实服务器。');
    };
    later(() => tick(0), 300);
    notify('开始模拟传输，仅演示进度。');
  };
  const sendMessage = async (text: string) => {
    if (chatting.current) return;
    const currentSession = active;
    const client = currentSession ? remoteClients.current.get(currentSession.id) : undefined;
    const terminalSessionId = currentSession?.hostId && client && !client.closed && !client.disconnected && host?.online
      ? client.sessionId
      : '';
    if (!selectedAgent) {
      notify('智能体尚未加载完成，请稍后重试。', 'error');
      return;
    }

    chatting.current = true;
    const version = chatVersion.current;
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    chatAbort.current = controller;
    setMessages(previous => [
      ...previous,
      { id: crypto.randomUUID(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '' },
    ]);
    setChatBusy(true);

    const updateAssistant = (update: (message: ChatMessage) => ChatMessage) => {
      if (version !== chatVersion.current) return;
      setMessages(previous => previous.map(message => message.id === assistantId ? update(message) : message));
    };
    const receive = (event: AgentStreamEvent) => {
      if (version !== chatVersion.current) return;
      switch (event.event) {
        case 'text':
          updateAssistant(message => ({ ...message, text: event.fullText ?? message.text + event.content }));
          break;
        case 'tool_call':
          updateAssistant(message => ({
            ...message,
            tools: [...(message.tools ?? []).filter(tool => tool.id !== event.toolCallId), {
               id: event.toolCallId,
               name: event.toolName,
               command: event.command,
               status: event.status === 'error' ? 'error' : 'running',
            }],
          }));
          break;
        case 'tool_result':
          updateAssistant(message => {
            const tools = [...(message.tools ?? [])];
            const index = tools.findIndex(tool => tool.id === event.toolCallId);
            const completed = {
              id: event.toolCallId || crypto.randomUUID(),
              name: index >= 0 ? tools[index].name : event.toolName || 'executeCommand',
              command: event.command || (index >= 0 ? tools[index].command : undefined),
              status: event.status === 'error' ? 'error' as const : 'success' as const,
              output: event.content,
            };
            if (index >= 0) tools[index] = completed;
            else tools.push(completed);
            return { ...message, tools };
          });
          break;
        case 'done':
          updateAssistant(message => ({ ...message, text: message.text || event.content || '任务已完成。' }));
          break;
        case 'error':
          throw new Error(event.content || 'Agent 执行失败');
      }
    };

    try {
      if (!chatSessionId.current) {
        const created = await agentApi.createSession(selectedAgent.agentId);
        if (!created?.sessionId) throw new Error('后端未返回 Agent 会话 ID');
        chatSessionId.current = created.sessionId;
      }
      await agentApi.chatStream({
        agentId: selectedAgent.agentId,
        userId: agentApi.userId,
        sessionId: chatSessionId.current,
        terminalSessionId,
        message: text,
      }, receive, controller.signal);
      updateAssistant(message => ({ ...message, text: message.text || '任务已完成。' }));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : 'Agent 对话失败';
      updateAssistant(current => ({ ...current, text: current.text || message, error: true }));
      notify(message, 'error');
    } finally {
      if (chatAbort.current === controller) chatAbort.current = null;
      if (version === chatVersion.current) {
        chatting.current = false;
        setChatBusy(false);
      }
    }
  };
  const clearChat = () => {
    chatVersion.current += 1;
    chatAbort.current?.abort();
    chatAbort.current = null;
    chatSessionId.current = '';
    chatting.current = false;
    setChatBusy(false);
    setMessages([]);
  };

  useEffect(() => {
    setSessions(previous => previous.map(session => {
      const configured = hosts.find(item => item.id === session.hostId);
      return configured && session.title !== configured.name ? { ...session, title: configured.name } : session;
    }));
  }, [hosts]);

  useEffect(() => {
    for (const session of sessions) {
      const client = remoteClients.current.get(session.id);
      if (session.hostId && client && !client.closed && !client.disconnected && !hosts.find(item => item.id === session.hostId)?.online) {
        void client.close().catch(error => notify(error.message, 'error'));
      }
    }
  }, [hosts, sessions, notify]);

  return <div style={{ '--agent-width': `${agentWidth}%` } as CSSProperties} className={`app-shell ${maximized ? 'terminal-maximized' : ''} ${navCollapsed ? 'nav-collapsed' : ''} ${navigation === '连接' ? 'connections-view' : 'terminal-view'}`}>
    <AppHeader search={() => setDialog('search')} notify={notify} />
    <ActivityBar active={navigation} onSelect={navigate} collapsed={navCollapsed} toggleCollapsed={() => setNavCollapsed(value => !value)} />
    {navigation === '连接' && <Connections connections={{ ...connections, disconnect: disconnectHost, remove: async id => {
      if (!await closeHostTerminals(id)) return false;
      const removed = await connections.remove(id);
      if (removed) {
        sessions.filter(session => session.hostId === id).forEach(session => remoteClients.current.delete(session.id));
        const remaining = sessions.filter(session => session.hostId !== id);
        setSessions(remaining);
        if (!remaining.some(session => session.id === activeId)) setActiveId(remaining[0]?.id ?? '');
      }
      return removed;
    } }} terminal={selectHost} create={openNewConnection} copy={copy} />}
    <main hidden={navigation !== '命令'} className={`central-workspace ${!active ? 'no-session' : ''} ${commandCollapsed ? 'command-collapsed' : ''}`}>
      <TerminalWorkspace
        remoteViews={sessions.filter(session => session.hostId && remoteClients.current.has(session.id)).map(session => <Suspense key={session.id} fallback={session.id === activeId ? <p>正在加载终端…</p> : null}><RemoteTerminalView runtime={remoteClients.current.get(session.id)!} visible={session.id === activeId && navigation === '命令'} confirm={confirm} online={!!hosts.find(item => item.id === session.hostId)?.online} onDisconnected={message => handleTerminalDisconnected(session.id, message)} reconnect={() => reconnectTerminal(session.id)} disconnect={() => closeSession(session.id)} /></Suspense>)}
        connections={() => navigate('连接')}
        sessions={sessions}
        activeId={activeId}
        host={host}
        select={setActiveId}
        close={closeSession}
        add={openNewTerminal}
        changeInput={input => setSessions(previous => previous.map(session => session.id === activeId ? { ...session, input } : session))}
        run={() => requestRun()}
        fillFocus={focusTick}
        maximize={() => setMaximized(value => !value)}
        isMaximized={maximized}
        copy={copy}
        filesOpen={!!active?.fileState.open}
        toggleFiles={() => { if (active) updateFiles(active.id, state => ({ ...state, open: !state.open })); }}
        filePanel={active && <SessionFiles key={active.id} sessionTitle={active.title} files={active.fileState.files} selected={active.fileState.selected} expanded={active.fileState.expanded} select={selected => updateFiles(active.id, state => ({ ...state, selected }))} toggle={id => updateFiles(active.id, state => { const expanded = new Set(state.expanded); if (expanded.has(id)) expanded.delete(id); else expanded.add(id); return { ...state, expanded }; })} transfers={active.fileState.transfers} upload={chosen => upload(active.id, chosen)} refresh={() => { updateFiles(active.id, state => ({ ...createSessionFileState(), open: state.open, transfers: state.transfers })); notify('已恢复当前终端的演示文件树', 'success'); }} create={() => { setFileDialogSessionId(active.id); setDialog('file'); }} close={() => updateFiles(active.id, state => ({ ...state, open: false }))} copy={copy} notify={notify} />}
      />
      <CommandShelf commands={commands} category={category} setCategory={setCategory} fill={fill} run={requestRun} copy={copy} add={() => setDialog('command')} disabled={!canRun} collapsed={commandCollapsed} toggleCollapsed={() => setCommandCollapsed(value => !value)} />
    </main>
    <PanelDivider value={agentWidth} change={setAgentWidth} />
    <AgentPanel host={host} messages={messages} busy={chatBusy} send={sendMessage} clear={clearChat} notify={notify} disabled={!selectedAgent} agentName={selectedAgent?.agentName} />
    <StatusBar host={host} />
    {toast && <NotificationToast key={toast.id} notice={toast} close={dismissNotice} />}
    {dialog === 'command' && <AddCommandDialog close={closeDialog} save={command => { setCommands(previous => [...previous, command]); setCategory(command.category); closeDialog(); notify('命令已添加到当前演示', 'success'); }} />}
    {dialog === 'file' && fileDialogSessionId && <CreateFileDialog close={closeDialog} path="/var/www/app" files={sessions.find(session => session.id === fileDialogSessionId)?.fileState.files ?? []} save={file => { updateFiles(fileDialogSessionId, state => ({ ...state, files: [...state.files, file], selected: file.id })); closeDialog(); notify('已在当前终端的演示文件树中创建', 'success'); }} />}
    {dialog === 'connection' && <SshConnectionDialog connections={connections} connectAfterSave={connectAfterSave} onClose={closeDialog} onSaved={saved => { if (connectAfterSave) void selectHost(saved.id, saved); else notify('SSH 连接已保存。', 'success'); }} />}
    {dialog === 'search' && <SearchDialog close={closeDialog} hosts={hosts} files={active?.fileState.files ?? []} commands={commands} choose={(kind, value) => { closeDialog(); if (kind === 'host') selectHost(value); if (kind === 'command') { fill(value); later(() => setFocusTick(tick => tick + 1), 0); } if (kind === 'file' && active) { const parts = value.split('/'); updateFiles(active.id, state => ({ ...state, open: true, selected: value, expanded: new Set([...state.expanded, ...parts.slice(0, -1)]) })); setNavigation('命令'); later(() => document.getElementById('files')?.focus(), 0); } }} />}
    {disconnectTarget && <DisconnectDialog key={disconnectTarget.sessionId} host={hosts.find(item => item.id === disconnectTarget.host.id) ?? disconnectTarget.host} busy={connections.busy} error={terminalError || connections.error} close={() => setDisconnectTarget(null)} confirm={confirmDisconnect} />}
    {pending && <Modal title="确认执行命令" onClose={() => setPending(null)}><div className="confirm-content"><p>目标：{sessions.find(session => session.id === pending.sessionId)?.title}</p><pre>{pending.command}</pre><p className="muted">此命令将在远程主机实际执行，请确认命令内容。</p><div className="dialog-actions"><button className="outlined-button" onClick={() => setPending(null)}>取消</button><button className="primary-button" onClick={() => { const request = pending; setPending(null); execute(request); }}>确认执行</button></div></div></Modal>}
  </div>;
}
