import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { updateSessionFiles } from './state/sessionFiles';
import { agentApi } from './api/agent';
import type { AgentConfig, AgentStreamEvent } from './api/agent';
import {
  listClientChatSessions,
  loadClientChatSession,
  saveClientChatSession,
} from './state/clientChatHistory';
import type { ClientChatSession } from './state/clientChatHistory';
import { DisconnectDialog } from './components/DisconnectDialog';
import { recordDisconnect } from './state/connectionHistory';
import { terminalApi } from './api/terminal';
import { RemoteTerminal } from './state/remoteTerminal';
import { NotificationToast } from './components/NotificationToast';
import type { Notice, NoticeType } from './components/NotificationToast';
import { ConnectionSidebar } from './components/Connections';
import { SshConnectionDialog } from './components/SshConnectionDialog';
import { useSshConnections } from './state/useSshConnections';
import { PanelDivider } from './components/PanelDivider';
import { AgentPanel } from './components/AgentPanel';
import { AddCommandDialog, CreateFileDialog, SearchDialog } from './components/Dialogs';
import { SessionFiles } from './components/Sidebar';
import { ActivityBar, AppHeader } from './components/Shell';
import { BackendSettingsDialog } from './components/BackendSettingsDialog';
import { readBackendUrl, saveBackendUrl } from './config/backend';
import { Modal } from './components/Ui';
import { CommandShelf, TerminalWorkspace } from './components/Workspace';
import { createSessionFileState, initialCommands, mockTransferProgress } from './data/mock';
import type { ChatAgentActivity, ChatMessage, ChatMessageSegment, ChatToolActivity, Host, Navigation, TerminalSession, SessionFileState } from './types';
import './App.css';
import './reference.css';

const RemoteTerminalView = lazy(() => import('./components/RemoteTerminalView').then(module => ({ default: module.RemoteTerminalView })));

type Dialog = 'command' | 'connection' | 'file' | 'search' | null;
type PendingCommand = { sessionId: string; command: string };
const initialSessions: TerminalSession[] = [];

function AppContent({ backendUrl, onBackendChange }: { backendUrl: string; onBackendChange: (url: string) => void }) {
  const [navigation, setNavigation] = useState<Navigation>('命令');
  const connections = useSshConnections();
  const { hosts } = connections;
  const [agentWidth, setAgentWidth] = useState(22);
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [manageConnections, setManageConnections] = useState(false);
  const [sessions, setSessions] = useState(initialSessions);
  const [activeId, setActiveId] = useState('');
  const [commands, setCommands] = useState(initialCommands);
  const [category, setCategory] = useState('全部');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const clientHistoryDirty = useRef(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStopping, setChatStopping] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(null);
  const [chatSessions, setChatSessions] = useState<ClientChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingId, setHistoryLoadingId] = useState('');
  const [historyError, setHistoryError] = useState('');
  const historyRefreshVersion = useRef(0);
  const confirm = true;
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<{ sessionId: string; host: Host } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [backendSettingsOpen, setBackendSettingsOpen] = useState(false);
  const [fileDialogSessionId, setFileDialogSessionId] = useState<string | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  const noticeSequence = useRef(0);
  const [focusTick, setFocusTick] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [commandCollapsed, setCommandCollapsed] = useState(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const chatVersion = useRef(0);
  const chatting = useRef(false);
  const chatSessionId = useRef('');
  const chatAbort = useRef<AbortController | null>(null);
  const stopPending = useRef(false);
  const historySelection = useRef(0);
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
  const replaceMessages = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    clientHistoryDirty.current = false;
    setMessages(next);
  }, []);
  const updateMessages = useCallback((update: (current: ChatMessage[]) => ChatMessage[]) => {
    const next = update(messagesRef.current);
    messagesRef.current = next;
    clientHistoryDirty.current = true;
    setMessages(next);
  }, []);
  const persistClientSession = useCallback(async (
    agentId: string,
    sessionId: string,
    snapshot: ChatMessage[] = messagesRef.current,
  ) => {
    if (!sessionId || !snapshot.length) return;
    const firstUserMessage = snapshot.find(message => message.role === 'user')?.text.trim();
    const title = firstUserMessage ? firstUserMessage.slice(0, 80) : '新会话';
    await saveClientChatSession({
      backendUrl,
      userId: agentApi.userId,
      agentId,
      sessionId,
    }, title, snapshot);
    // 保存期间如果又收到了流式内容，messagesRef 已指向新数组，下一轮仍需继续保存。
    if (messagesRef.current === snapshot) clientHistoryDirty.current = false;
  }, [backendUrl]);
  const refreshChatSessions = useCallback(async (agentId: string) => {
    const version = ++historyRefreshVersion.current;
    setHistoryLoading(true);
    try {
      const sessions = await listClientChatSessions({
        backendUrl,
        userId: agentApi.userId,
        agentId,
      });
      if (version === historyRefreshVersion.current) {
        setChatSessions(sessions);
        setHistoryError('');
      }
    } catch (error) {
      if (version === historyRefreshVersion.current) {
        setHistoryError(error instanceof Error ? error.message : '加载历史会话失败');
      }
    } finally {
      if (version === historyRefreshVersion.current) setHistoryLoading(false);
    }
  }, [backendUrl]);
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
    const closeWindowTerminals = () => {
      remoteClients.current.forEach(client => {
        if (!client.closed) terminalApi.closeOnUnload(client.sessionId);
      });
    };
    window.addEventListener('pagehide', closeWindowTerminals);
    return () => window.removeEventListener('pagehide', closeWindowTerminals);
  }, []);
  useEffect(() => {
    if (selectedAgent?.agentId) void refreshChatSessions(selectedAgent.agentId);
  }, [selectedAgent?.agentId, refreshChatSessions]);
  useEffect(() => {
    if (!selectedAgent?.agentId || !activeChatSessionId || !messages.length || !clientHistoryDirty.current) return;
    // 流式 token 更新频率很高，采用短防抖保存，既能保留实时过程又避免每个 token 都写磁盘。
    const timer = setTimeout(() => {
      void persistClientSession(selectedAgent.agentId, activeChatSessionId)
        .catch(error => console.warn('客户端对话历史自动保存失败', error));
    }, 300);
    return () => clearTimeout(timer);
  }, [messages, activeChatSessionId, selectedAgent?.agentId, persistClientSession]);
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
      if (!nextHost.online && !await connections.connect(id)) { setNavigation('命令'); return; }
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
  const handleTerminalDisconnected = (sessionId: string, message: string, sourceRuntime?: RemoteTerminal) => {
    if (sourceRuntime && remoteClients.current.get(sessionId) !== sourceRuntime) {
      console.info(`忽略旧终端实例的断开通知 oldTerminalSessionId=${sourceRuntime.sessionId} logicalSessionId=${sessionId}`);
      return;
    }
    const session = sessions.find(item => item.id === sessionId);
    if (!session?.hostId) return;
    connections.markDisconnected(session.hostId);
    setSessions(previous => previous.map(item => item.id === sessionId ? { ...item, busy: false } : item));
    running.current.delete(sessionId);
    notify(message, 'error');
  };
  const reconnectTerminal = async (
    sessionId: string,
    options?: { automatic?: boolean; attempt?: number },
    sourceRuntime?: RemoteTerminal,
  ) => {
    if (sourceRuntime && remoteClients.current.get(sessionId) !== sourceRuntime) {
      console.info(`忽略旧终端实例的重连请求 oldTerminalSessionId=${sourceRuntime.sessionId} logicalSessionId=${sessionId}`);
      return true;
    }
    const session = sessions.find(item => item.id === sessionId);
    if (!session?.hostId || connections.busy || opening.current.has(session.hostId)) return false;
    opening.current.add(session.hostId);
    remoteClients.current.get(sessionId)?.prepareReconnect();
    if (options?.automatic) {
      console.info(`SSH 自动重连请求 hostId=${session.hostId} oldTerminalSessionId=${remoteClients.current.get(sessionId)?.sessionId} attempt=${options.attempt ?? 1}`);
    } else {
      notify('正在重新连接服务器并创建终端会话…');
    }
    try {
      if (!await connections.connect(session.hostId)) return false;
      const opened = await terminalApi.open(session.hostId);
      if (!opened?.sessionId) throw new Error('后端未返回终端会话 ID');
      remoteClients.current.set(sessionId, new RemoteTerminal(opened));
      setSessions(previous => previous.map(item => item.id === sessionId ? { ...item, busy: false } : item));
      notify(options?.automatic ? `网络已恢复，SSH 自动重连成功（第 ${options.attempt ?? 1} 次）。` : '已重新连接，可以继续操作。', 'success');
      return true;
    } catch (error) {
      connections.markDisconnected(session.hostId);
      if (!options?.automatic) notify(error instanceof Error ? error.message : '重新连接失败', 'error');
      else console.info(`SSH 自动重连请求失败 hostId=${session.hostId} attempt=${options.attempt ?? 1} reason=${error instanceof Error ? error.message : '重新连接失败'}`);
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
  const removeHost = async (hostId: string) => {
    if (!await closeHostTerminals(hostId)) return false;
    const removed = await connections.remove(hostId);
    if (removed) {
      sessions.filter(session => session.hostId === hostId).forEach(session => remoteClients.current.delete(session.id));
      const remaining = sessions.filter(session => session.hostId !== hostId);
      setSessions(remaining);
      if (!remaining.some(session => session.id === activeId)) setActiveId(remaining[0]?.id ?? '');
    }
    return removed;
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
    setManageConnections(name === '连接');
    setNavigation('命令');
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
    if (chatting.current || stopPending.current || historyLoadingId) return;
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
    updateMessages(previous => [
      ...previous,
      { id: crypto.randomUUID(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '', segments: [] },
    ]);
    setChatBusy(true);

    const updateAssistant = (update: (message: ChatMessage) => ChatMessage) => {
      if (version !== chatVersion.current) return;
      updateMessages(previous => previous.map(message => message.id === assistantId ? update(message) : message));
    };
    const appendText = (message: ChatMessage, content: string): ChatMessage => {
      if (!content) return message;
      const segments = [...(message.segments ?? [])];
      const last = segments[segments.length - 1];
      if (last?.type === 'text') segments[segments.length - 1] = { ...last, text: last.text + content };
      else segments.push({ id: crypto.randomUUID(), type: 'text', text: content });
      return { ...message, text: message.text + content, segments };
    };
    const upsertTool = (message: ChatMessage, activity: ChatToolActivity): ChatMessage => {
      const segments = [...(message.segments ?? [])];
      const index = segments.findIndex(segment => segment.type === 'tool' && segment.tool.id === activity.id);
      const segment: ChatMessageSegment = { id: activity.id, type: 'tool', tool: activity };
      if (index >= 0) segments[index] = segment;
      else segments.push(segment);
      return { ...message, segments };
    };
    const upsertAgent = (message: ChatMessage, activity: ChatAgentActivity): ChatMessage => {
      const segments = [...(message.segments ?? [])];
      const index = segments.findIndex(segment => segment.id === activity.id && segment.type !== 'text');
      const segment: ChatMessageSegment = { id: activity.id, type: 'agent', agent: activity };
      if (index >= 0) segments[index] = segment;
      else segments.push(segment);
      return { ...message, segments };
    };
    const updateAgentTool = (message: ChatMessage, agentCallId: string, sourceAgent: string | undefined, tool: ChatToolActivity): ChatMessage => {
      const previous = message.segments?.find(segment => segment.type === 'agent' && segment.agent.id === agentCallId);
      const agent: ChatAgentActivity = previous?.type === 'agent' ? previous.agent : {
        id: agentCallId, name: sourceAgent || '子智能体', status: 'running', tools: [],
      };
      const tools = [...agent.tools];
      const index = tools.findIndex(item => item.id === tool.id);
      if (index >= 0) tools[index] = tool;
      else tools.push(tool);
      const segments = [...(agent.segments ?? [])];
      const segmentIndex = segments.findIndex(item => item.type === 'tool' && item.tool.id === tool.id);
      if (segmentIndex >= 0) segments[segmentIndex] = { id: tool.id, type: 'tool', tool };
      else segments.push({ id: tool.id, type: 'tool', tool });
      return upsertAgent(message, { ...agent, tools, segments });
    };
    const receive = (event: AgentStreamEvent) => {
      if (version !== chatVersion.current || controller.signal.aborted || stopPending.current) return;
      switch (event.event) {
        case 'text':
          updateAssistant(message => appendText(message, event.content));
          break;
        case 'agent_start':
          updateAssistant(message => {
            const previous = message.segments?.find(segment => segment.type === 'agent' && segment.agent.id === event.agentCallId);
            const agent = previous?.type === 'agent' ? previous.agent : undefined;
            return upsertAgent(message, {
              id: event.agentCallId,
              name: event.agentName,
              task: event.task || agent?.task,
              parentToolCallId: event.parentToolCallId || agent?.parentToolCallId,
              status: agent?.status === 'success' || agent?.status === 'error' ? agent.status : 'running',
              output: agent?.output,
              tools: agent?.tools ?? [],
              segments: agent?.segments ?? [],
            });
          });
          break;
        case 'agent_text':
          updateAssistant(message => {
            const previous = message.segments?.find(segment => segment.type === 'agent' && segment.agent.id === event.agentCallId);
            const agent: ChatAgentActivity = previous?.type === 'agent' ? previous.agent : {
              id: event.agentCallId, name: event.sourceAgent || '子智能体', status: 'running', tools: [],
            };
            const segments = [...(agent.segments ?? [])];
            const last = segments[segments.length - 1];
            if (last?.type === 'text') segments[segments.length - 1] = { ...last, text: last.text + event.content };
            else segments.push({ id: crypto.randomUUID(), type: 'text', text: event.content });
            return upsertAgent(message, { ...agent, segments });
          });
          break;
        case 'agent_result':
          updateAssistant(message => {
            const previous = message.segments?.find(segment => segment.type === 'agent' && segment.agent.id === event.agentCallId);
            const agent = previous?.type === 'agent' ? previous.agent : undefined;
            return upsertAgent(message, {
              id: event.agentCallId, name: event.agentName || agent?.name || '子智能体',
              task: agent?.task, parentToolCallId: agent?.parentToolCallId,
              status: event.status, output: event.content, tools: agent?.tools ?? [],
              segments: agent?.segments ?? [],
            });
          });
          break;
        case 'tool_call':
          updateAssistant(message => {
            const agentSegment = event.agentCallId
              ? message.segments?.find(segment => segment.type === 'agent' && segment.agent.id === event.agentCallId)
              : undefined;
            const previous = event.agentCallId && agentSegment?.type === 'agent'
              ? agentSegment.agent.tools.find(tool => tool.id === event.toolCallId)
              : message.segments?.find(segment => segment.type === 'tool' && segment.tool.id === event.toolCallId);
            const previousTool = previous && 'type' in previous ? previous.type === 'tool' ? previous.tool : undefined : previous;
            const finished = previousTool?.status === 'success' || previousTool?.status === 'error';
            const activity: ChatToolActivity = {
              id: event.toolCallId,
              name: event.toolName || previousTool?.name || '工具',
              command: event.command || previousTool?.command,
              status: finished && event.status === 'running' ? previousTool.status : event.status,
              output: previousTool?.output,
              sourceAgent: event.sourceAgent || previousTool?.sourceAgent,
            };
            return event.agentCallId
              ? updateAgentTool(message, event.agentCallId, event.sourceAgent, activity)
              : upsertTool(message, activity);
          });
          break;
        case 'tool_result':
          updateAssistant(message => {
            const matchingAgent = message.segments?.find(segment => segment.type === 'agent' && segment.agent.id === event.toolCallId);
            if (matchingAgent?.type === 'agent') {
              return upsertAgent(message, { ...matchingAgent.agent, status: event.status,
                output: matchingAgent.agent.output || event.content });
            }
            const agentSegment = event.agentCallId
              ? message.segments?.find(segment => segment.type === 'agent' && segment.agent.id === event.agentCallId)
              : undefined;
            const previous = event.agentCallId && agentSegment?.type === 'agent'
              ? agentSegment.agent.tools.find(tool => tool.id === event.toolCallId)
              : message.segments?.find(segment => segment.type === 'tool' && segment.tool.id === event.toolCallId);
            const previousTool = previous && 'type' in previous ? previous.type === 'tool' ? previous.tool : undefined : previous;
            const completed: ChatToolActivity = {
              id: event.toolCallId,
              name: event.toolName || previousTool?.name || '工具',
              command: event.command || previousTool?.command,
              status: event.status,
              output: event.content,
              sourceAgent: event.sourceAgent || previousTool?.sourceAgent,
            };
            return event.agentCallId
              ? updateAgentTool(message, event.agentCallId, event.sourceAgent, completed)
              : upsertTool(message, completed);
          });
          break;
        case 'done':
          updateAssistant(message => message.text ? message : appendText(message, event.content || '任务已完成。'));
          break;
        case 'error':
          throw new Error(event.content || 'Agent 执行失败');
      }
    };

    try {
      if (!chatSessionId.current) {
        const created = await agentApi.createSession(selectedAgent.agentId, controller.signal);
        if (!created?.sessionId) throw new Error('后端未返回 Agent 会话 ID');
        if (controller.signal.aborted) return;
        chatSessionId.current = created.sessionId;
        setActiveChatSessionId(created.sessionId);
      }
      await agentApi.chatStream({
        agentId: selectedAgent.agentId,
        userId: agentApi.userId,
        sessionId: chatSessionId.current,
        terminalSessionId,
        message: text,
      }, receive, controller.signal);
      if (controller.signal.aborted || stopPending.current) return;
      updateAssistant(message => message.text ? message : appendText(message, '任务已完成。'));
    } catch (error) {
      if (controller.signal.aborted || stopPending.current
          || (error instanceof DOMException && error.name === 'AbortError')) {
        updateAssistant(current => current.text || current.segments?.length
          ? current : appendText(current, '已停止生成。'));
        return;
      }
      const message = error instanceof Error ? error.message : 'Agent 对话失败';
      updateAssistant(current => ({ ...(current.text ? current : appendText(current, message)), error: true }));
      notify(message, 'error');
    } finally {
      if (chatAbort.current === controller) chatAbort.current = null;
      if (version === chatVersion.current) {
        chatting.current = false;
        setChatBusy(false);
      }
      const sessionId = chatSessionId.current;
      try {
        await persistClientSession(selectedAgent.agentId, sessionId);
      } catch (persistError) {
        console.warn('客户端对话历史最终保存失败', persistError);
        notify('对话已完成，但客户端历史保存失败。', 'error');
      }
      await refreshChatSessions(selectedAgent.agentId);
    }
  };
  const stopChat = () => {
    if (stopPending.current) return;
    stopPending.current = true;
    setChatStopping(true);
    const agentId = selectedAgent?.agentId;
    const sessionId = chatSessionId.current;
    const activeController = chatAbort.current;
    if (agentId && sessionId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      // 请求服务端先取消正在执行的任务；等待确认期间忽略后续流事件，
      // 最终再断开本地流。断连回调同时作为服务端取消的兜底。
      void agentApi.stopChat(agentId, sessionId, controller.signal)
        .catch(error => {
          console.warn('服务端停止请求未确认', error);
          notify('已停止显示，但后端停止未确认；请检查服务端执行状态。', 'error');
        })
        .finally(() => {
          clearTimeout(timeout);
          activeController?.abort();
          stopPending.current = false;
          setChatStopping(false);
        });
    } else {
      chatAbort.current?.abort();
      stopPending.current = false;
      setChatStopping(false);
    }
  };
  const clearChat = () => {
    const previousSessionId = chatSessionId.current;
    const previousAgentId = selectedAgent?.agentId;
    if (previousAgentId && previousSessionId && messagesRef.current.length) {
      void persistClientSession(previousAgentId, previousSessionId)
        .then(() => refreshChatSessions(previousAgentId))
        .catch(error => console.warn('新建会话前保存客户端历史失败', error));
    }
    if (chatting.current) stopChat();
    chatVersion.current += 1;
    historySelection.current += 1;
    chatAbort.current?.abort();
    chatAbort.current = null;
    chatSessionId.current = '';
    setActiveChatSessionId('');
    setHistoryOpen(false);
    setHistoryLoadingId('');
    chatting.current = false;
    setChatBusy(false);
    replaceMessages([]);
  };

  const selectChatSession = async (sessionId: string) => {
    if (!selectedAgent || chatting.current || stopPending.current) return;
    const selection = ++historySelection.current;
    setHistoryLoadingId(sessionId);
    try {
      const history = await loadClientChatSession({
        backendUrl,
        userId: agentApi.userId,
        agentId: selectedAgent.agentId,
        sessionId,
      });
      if (selection !== historySelection.current) return;
      if (!history) throw new Error('客户端中未找到该会话记录');
      chatVersion.current += 1;
      chatSessionId.current = sessionId;
      setActiveChatSessionId(sessionId);
      replaceMessages(history);
      setHistoryOpen(false);
    } catch (error) {
      if (selection === historySelection.current) {
        notify(error instanceof Error ? error.message : '加载历史消息失败', 'error');
      }
    } finally {
      if (selection === historySelection.current) setHistoryLoadingId('');
    }
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
    <ActivityBar active={manageConnections ? '连接' : navigation} onSelect={navigate} onSettings={() => setBackendSettingsOpen(true)} settingsOpen={backendSettingsOpen} collapsed={navCollapsed} toggleCollapsed={() => setNavCollapsed(value => !value)} />
    <ConnectionSidebar connections={{ ...connections, disconnect: disconnectHost, remove: removeHost }} activeHostId={active?.hostId} terminal={selectHost} create={openNewConnection} manage={manageConnections} setManage={setManageConnections} />
    <main hidden={navigation !== '命令'} className={`central-workspace ${!active ? 'no-session' : ''} ${commandCollapsed ? 'command-collapsed' : ''}`}>
      <TerminalWorkspace
        remoteViews={sessions.filter(session => session.hostId && remoteClients.current.has(session.id)).map(session => {
          const runtime = remoteClients.current.get(session.id)!;
          return <Suspense key={session.id} fallback={session.id === activeId ? <p>正在加载终端…</p> : null}>
            <RemoteTerminalView key={runtime.sessionId} runtime={runtime} visible={session.id === activeId && navigation === '命令'}
              confirm={confirm} online={!!hosts.find(item => item.id === session.hostId)?.online}
              onDisconnected={message => handleTerminalDisconnected(session.id, message, runtime)}
              reconnect={options => reconnectTerminal(session.id, options, runtime)}
              disconnect={() => closeSession(session.id)} />
          </Suspense>;
        })}
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
    <AgentPanel host={host} messages={messages} busy={chatBusy} stopping={chatStopping} send={sendMessage} stop={stopChat}
      clear={clearChat} disabled={!selectedAgent || Boolean(historyLoadingId) || chatStopping}
      history={{
        sessions: chatSessions, activeSessionId: activeChatSessionId, open: historyOpen,
        loading: historyLoading, loadingSessionId: historyLoadingId, error: historyError,
        toggle: () => {
          if (!historyOpen && selectedAgent) void refreshChatSessions(selectedAgent.agentId);
          setHistoryOpen(value => !value);
        },
        refresh: () => { if (selectedAgent) void refreshChatSessions(selectedAgent.agentId); },
        select: sessionId => { void selectChatSession(sessionId); },
      }} />
    {toast && <NotificationToast key={toast.id} notice={toast} close={dismissNotice} />}
    {dialog === 'command' && <AddCommandDialog close={closeDialog} save={command => { setCommands(previous => [...previous, command]); setCategory(command.category); closeDialog(); notify('命令已添加到当前演示', 'success'); }} />}
    {dialog === 'file' && fileDialogSessionId && <CreateFileDialog close={closeDialog} path="/var/www/app" files={sessions.find(session => session.id === fileDialogSessionId)?.fileState.files ?? []} save={file => { updateFiles(fileDialogSessionId, state => ({ ...state, files: [...state.files, file], selected: file.id })); closeDialog(); notify('已在当前终端的演示文件树中创建', 'success'); }} />}
    {dialog === 'connection' && <SshConnectionDialog connections={connections} connectAfterSave={connectAfterSave} onClose={closeDialog} onSaved={saved => { if (connectAfterSave) void selectHost(saved.id, saved); else notify('SSH 连接已保存。', 'success'); }} />}
    {dialog === 'search' && <SearchDialog close={closeDialog} hosts={hosts} files={active?.fileState.files ?? []} commands={commands} choose={(kind, value) => { closeDialog(); if (kind === 'host') selectHost(value); if (kind === 'command') { fill(value); later(() => setFocusTick(tick => tick + 1), 0); } if (kind === 'file' && active) { const parts = value.split('/'); updateFiles(active.id, state => ({ ...state, open: true, selected: value, expanded: new Set([...state.expanded, ...parts.slice(0, -1)]) })); setNavigation('命令'); later(() => document.getElementById('files')?.focus(), 0); } }} />}
    {disconnectTarget && <DisconnectDialog key={disconnectTarget.sessionId} host={hosts.find(item => item.id === disconnectTarget.host.id) ?? disconnectTarget.host} busy={connections.busy} error={terminalError || connections.error} close={() => setDisconnectTarget(null)} confirm={confirmDisconnect} />}
    {pending && <Modal title="确认执行命令" onClose={() => setPending(null)}><div className="confirm-content"><p>目标：{sessions.find(session => session.id === pending.sessionId)?.title}</p><pre>{pending.command}</pre><p className="muted">此命令将在远程主机实际执行，请确认命令内容。</p><div className="dialog-actions"><button className="outlined-button" onClick={() => setPending(null)}>取消</button><button className="primary-button" onClick={() => { const request = pending; setPending(null); execute(request); }}>确认执行</button></div></div></Modal>}
    {backendSettingsOpen && <BackendSettingsDialog currentUrl={backendUrl} onClose={() => setBackendSettingsOpen(false)} onSave={url => {
      if (chatBusy || chatStopping || sessions.some(session => Boolean(session.hostId))) {
        throw new Error('请先停止对话并关闭终端标签，再切换后端服务器。');
      }
      onBackendChange(url);
    }} />}
  </div>;
}

export default function App() {
  const [backendUrl, setBackendUrl] = useState(readBackendUrl);
  const changeBackend = (url: string) => setBackendUrl(saveBackendUrl(url));

  if (!backendUrl) {
    return <BackendSettingsDialog currentUrl="" required onClose={() => {}} onSave={changeBackend} />;
  }

  return <AppContent key={backendUrl} backendUrl={backendUrl} onBackendChange={changeBackend} />;
}
