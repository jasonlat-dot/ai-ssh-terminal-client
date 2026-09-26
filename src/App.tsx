import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { updateSessionFiles } from './state/sessionFiles';
import { useTheme } from './state/useTheme';
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
import { loadClientCommands, saveClientCommands } from './state/clientCommands';
import { sshApi } from './api/ssh';
import { terminalApi } from './api/terminal';
import { RemoteTerminal } from './state/remoteTerminal';
import type { TerminalDisconnectEvent } from './state/remoteTerminal';
import { loadTerminalSessions, saveTerminalSessions } from './state/terminalSessions';
import { copyText } from './state/clipboard';
import { NotificationToast } from './components/NotificationToast';
import type { Notice, NoticeType } from './components/NotificationToast';
import { ConnectionSidebar } from './components/Connections';
import { SshConnectionDialog } from './components/SshConnectionDialog';
import { useSshConnections } from './state/useSshConnections';
import { PanelDivider } from './components/PanelDivider';
import { AgentPanel } from './components/AgentPanel';
import { AddCommandDialog, CreateFileDialog } from './components/Dialogs';
import { SessionFiles } from './components/Sidebar';
import { FileUploadDialog } from './components/FileUploadDialog';
import { FileUploadQueue } from './state/fileUploads';
import { AttachmentPreviews, ChatAttachmentDraft, attachmentReferences, validateChatContent } from './state/chatAttachments';
import { ChatRequestError } from './api/chatErrors';
import { ActivityBar, AppHeader } from './components/Shell';
import { BackendSettingsDialog } from './components/BackendSettingsDialog';
import { readBackendUrl, saveBackendUrl } from './config/backend';
import { CommandShelf, TerminalWorkspace } from './components/Workspace';
import { createSessionFileState, initialCommands } from './data/mock';
import type { ChatAttachment, ChatAgentActivity, ChatMessage, ChatMessageSegment, ChatToolActivity, Host, Navigation, SessionFileState } from './types';
import './App.css';
import './reference.css';

const RemoteTerminalView = lazy(() => import('./components/RemoteTerminalView').then(module => ({ default: module.RemoteTerminalView })));

type Dialog = 'command' | 'connection' | 'file' | null;
type CommandRequest = { sessionId: string; command: string };
const STALE_TERMINAL_TAB_MS = 5 * 60 * 1000;

function AppContent({ backendUrl, onBackendChange }: { backendUrl: string; onBackendChange: (url: string) => void }) {
  const { theme, setTheme } = useTheme();
  const [navigation, setNavigation] = useState<Navigation>('命令');
  const connections = useSshConnections();
  const { hosts } = connections;
  const [agentWidth, setAgentWidth] = useState(22);
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [manageConnections, setManageConnections] = useState(false);
  const [sessions, setSessions] = useState(() => loadTerminalSessions(backendUrl));
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [activeId, setActiveId] = useState(() => sessions[0]?.id ?? '');
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
  const [disconnectTarget, setDisconnectTarget] = useState<{ tabId: string; host: Host } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [backendSettingsOpen, setBackendSettingsOpen] = useState(false);
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const [uploads] = useState(() => new FileUploadQueue());
  useEffect(() => { uploads.activate(); return uploads.deactivate; }, [uploads]);
  const [attachmentPreviews] = useState(() => new AttachmentPreviews());
  const [chatDraft] = useState(() => new ChatAttachmentDraft(attachmentPreviews));
  const draftAttachments = useSyncExternalStore(chatDraft.subscribe, chatDraft.getSnapshot);
  useEffect(() => {
    chatDraft.activate();
    return () => { chatDraft.deactivate(); attachmentPreviews.dispose(); };
  }, [chatDraft, attachmentPreviews]);
  useEffect(() => {
    attachmentPreviews.reconcile([
      ...chatDraft.getSnapshot().map(item => item.previewUrl),
      ...messagesRef.current.flatMap(message => message.attachments?.map(file => file.previewUrl) ?? []),
    ]);
  }, [draftAttachments, messages, chatDraft, attachmentPreviews]);
  const [fileDialogSessionId, setFileDialogSessionId] = useState<string | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  const noticeSequence = useRef(0);
  const [commandCollapsed, setCommandCollapsed] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const chatVersion = useRef(0);
  const chatting = useRef(false);
  const chatSessionId = useRef('');
  const chatAbort = useRef<AbortController | null>(null);
  const stopPending = useRef(false);
  const historySelection = useRef(0);
  const running = useRef(new Set<string>());
  const remoteClients = useRef(new Map<string, RemoteTerminal>());
  const restoredClientsInitialized = useRef(false);
  const restoredSessionsVerified = useRef(false);
  if (!restoredClientsInitialized.current) {
    sessions.forEach(session => {
      if (session.terminalSessionId) {
        remoteClients.current.set(session.id, new RemoteTerminal({
          sessionId: session.terminalSessionId,
          connectionId: session.connectionId,
          initialOutput: '',
        }, true));
      }
    });
    restoredClientsInitialized.current = true;
  }
  const opening = useRef(new Set<string>());
  const tabLastUsedAt = useRef(new Map<string, number>());
  const [terminalError, setTerminalError] = useState('');
  const [connectAfterSave, setConnectAfterSave] = useState(false);
  const active = sessions.find(session => session.id === activeId);
  const host = hosts.find(item => item.id === active?.connectionId) ?? active?.host;
  const activeClient = active ? remoteClients.current.get(active.id) : undefined;
  const canRun = !!active && active.connected && !active.busy
    && activeClient?.sessionId === active.terminalSessionId
    && !activeClient.closed && !activeClient.disconnected;

  useEffect(() => {
    try { saveTerminalSessions(backendUrl, sessions); }
    catch (error) { console.warn('保存终端页签恢复信息失败', error); }
  }, [backendUrl, sessions]);
  useEffect(() => {
    let cancelled = false;
    void loadClientCommands()
      .then(stored => {
        if (cancelled) return;
        const persisted = stored ?? [];
        const merged = [
          ...persisted,
          ...initialCommands.filter(defaultCommand => !persisted.some(command => command.id === defaultCommand.id || command.command === defaultCommand.command)),
        ];
        setCommands(merged);
        if (!stored || merged.length !== stored.length) {
          void saveClientCommands(merged).catch(error => console.warn('更新客户端默认命令失败', error));
        }
      })
      .catch(error => {
        if (!cancelled) console.warn('加载客户端常用命令失败', error);
      });
    return () => { cancelled = true; };
  }, []);
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
  const closeDialog = () => { setDialog(null); setFileDialogSessionId(null); };
  const copy = async (text: string) => {
    try { await copyText(text); notify('已复制到剪贴板', 'success'); }
    catch { notify('复制失败：请选中文字后使用 Ctrl+C 复制。', 'error'); }
  };
  const openNewConnection = () => { setConnectAfterSave(false); setDialog('connection'); };
  const openNewTerminal = () => { setConnectAfterSave(true); setDialog('connection'); };
  const openTerminalRuntime = async (connectionId: string, stillWanted = () => true) => {
    let opened: Awaited<ReturnType<typeof terminalApi.open>> | undefined;
    try {
      if (!stillWanted()) throw new Error('终端页签已关闭');
      await sshApi.connect(connectionId);
      if (!stillWanted()) throw new Error('终端页签已关闭');
      opened = await terminalApi.open(connectionId);
      if (!opened?.sessionId) throw new Error('后端未返回终端会话 ID');
      if (!stillWanted()) throw new Error('终端页签已关闭');
      const runtime = new RemoteTerminal(opened);
      if (runtime.disconnected) throw new Error('终端会话已断开，请重试。');
      return runtime;
    } catch (error) {
      if (opened?.sessionId) await terminalApi.close(opened.sessionId).catch(() => undefined);
      throw error;
    }
  };
  const selectHost = async (id: string, suppliedHost?: Host) => {
    const nextHost = suppliedHost ?? hosts.find(item => item.id === id);
    if (!nextHost) return;
    const tabId = crypto.randomUUID();
    opening.current.add(tabId);
    try {
      notify('正在打开远程终端…');
      const runtime = await openTerminalRuntime(id);
      remoteClients.current.set(tabId, runtime);
      tabLastUsedAt.current.set(tabId, Date.now());
      setSessions(previous => [...previous, {
        id: tabId,
        connectionId: id,
        terminalSessionId: runtime.sessionId,
        connected: true,
        connectionStatus: 'connected',
        disconnectReason: null,
        reconnectAllowed: false,
        reconnectAttempts: 0,
        reconnecting: false,
        readLoopGeneration: runtime.readLoopGeneration,
        manuallyClosed: false,
        host: nextHost,
        title: nextHost.name,
        busy: false,
        fileState: createSessionFileState(),
      }]);
      setActiveId(tabId); setNavigation('命令');
      notify('远程终端已打开，可以开始操作。', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '打开终端失败', 'error'); }
    finally { opening.current.delete(tabId); }
  };
  const handleTerminalDisconnected = (sessionId: string, event: TerminalDisconnectEvent, sourceRuntime?: RemoteTerminal) => {
    if (sourceRuntime && remoteClients.current.get(sessionId) !== sourceRuntime) {
      console.info(`忽略旧终端实例的断开通知 oldTerminalSessionId=${sourceRuntime.sessionId} logicalSessionId=${sessionId}`);
      return;
    }
    if (sourceRuntime?.manuallyClosed) return;
    setSessions(previous => previous.map(item => item.id === sessionId && !item.manuallyClosed ? {
      ...item,
      terminalSessionId: event.reconnectAllowed ? item.terminalSessionId : '',
      connected: false,
      connectionStatus: 'disconnected',
      disconnectReason: event.reason,
      reconnectAllowed: event.reconnectAllowed,
      reconnecting: false,
      readLoopGeneration: sourceRuntime?.readLoopGeneration ?? item.readLoopGeneration,
      busy: false,
    } : item));
    running.current.delete(sessionId);
    if (event.reason !== 'CLIENT_CLOSED') notify(event.message, 'error');
  };
  const verifyTerminalSession = useCallback(async (tabId: string, terminalSessionId: string) => {
    if (!terminalSessionId) return false;
    const runtime = remoteClients.current.get(tabId);
    if (!runtime || runtime.sessionId !== terminalSessionId) return false;
    try {
      const state = await runtime.verifyConnected();
      if (remoteClients.current.get(tabId) !== runtime || runtime.manuallyClosed) return false;
      setSessions(previous => previous.map(session => session.id === tabId && session.terminalSessionId === terminalSessionId && !session.manuallyClosed
        ? {
          ...session,
          terminalSessionId: state.connected || state.reconnectAllowed ? terminalSessionId : '',
          connected: state.connected,
          connectionStatus: state.connected ? 'connected' : 'disconnected',
          disconnectReason: state.disconnectReason,
          reconnectAllowed: state.connected ? false : state.reconnectAllowed === true,
          reconnectAttempts: state.connected ? 0 : session.reconnectAttempts,
          reconnecting: false,
          readLoopGeneration: runtime.readLoopGeneration,
          busy: state.connected ? session.busy : false,
        }
        : session));
      return state.connected;
    } catch (error) {
      console.info(`查询终端连接状态失败 terminalSessionId=${terminalSessionId} reason=${error instanceof Error ? error.message : '未知错误'}`);
      return undefined;
    }
  }, []);
  const selectTerminalTab = (tabId: string) => {
    const now = Date.now();
    if (activeId && activeId !== tabId) tabLastUsedAt.current.set(activeId, now);
    const lastUsedAt = tabLastUsedAt.current.get(tabId) ?? 0;
    const session = sessions.find(item => item.id === tabId);
    tabLastUsedAt.current.set(tabId, now);
    setActiveId(tabId);
    if (session?.terminalSessionId && (!session.connected || now - lastUsedAt >= STALE_TERMINAL_TAB_MS)) {
      void verifyTerminalSession(tabId, session.terminalSessionId);
    }
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
    const session = sessionsRef.current.find(item => item.id === sessionId);
    if (!session || opening.current.has(sessionId)) return false;
    if (options?.automatic && (!session.reconnectAllowed || session.manuallyClosed || sourceRuntime?.manuallyClosed)) {
      console.info(`忽略未获后端允许的自动重连 logicalSessionId=${sessionId}`);
      return false;
    }
    opening.current.add(sessionId);
    const previousRuntime = remoteClients.current.get(sessionId);
    previousRuntime?.prepareReconnect(!options?.automatic);
    sessionsRef.current = sessionsRef.current.map(item => item.id === sessionId ? { ...item, manuallyClosed: false } : item);
    setSessions(previous => previous.map(item => item.id === sessionId ? {
      ...item,
      connectionStatus: 'reconnecting',
      reconnecting: true,
      reconnectAttempts: options?.attempt ?? item.reconnectAttempts,
      manuallyClosed: false,
    } : item));
    if (options?.automatic) {
      console.info(`SSH 自动重连请求 connectionId=${session.connectionId} oldTerminalSessionId=${previousRuntime?.sessionId} attempt=${options.attempt ?? 1}`);
    } else {
      notify('正在重新连接服务器并创建终端会话…');
    }
    const stillWanted = () => {
      const current = sessionsRef.current.find(item => item.id === sessionId);
      return !!current && !current.manuallyClosed && !previousRuntime?.manuallyClosed
        && remoteClients.current.get(sessionId) === previousRuntime;
    };
    try {
      if (previousRuntime?.sessionId) await terminalApi.close(previousRuntime.sessionId).catch(() => undefined);
      const runtime = await openTerminalRuntime(session.connectionId, stillWanted);
      const currentSession = sessionsRef.current.find(item => item.id === sessionId);
      const currentRuntime = remoteClients.current.get(sessionId);
      if (!currentSession || currentSession.manuallyClosed || previousRuntime?.manuallyClosed
        || (previousRuntime ? currentRuntime !== previousRuntime : !!currentRuntime)) {
        await runtime.close().catch(() => undefined);
        return false;
      }
      remoteClients.current.set(sessionId, runtime);
      setSessions(previous => previous.map(item => item.id === sessionId ? {
        ...item,
        terminalSessionId: runtime.sessionId,
        connected: true,
        connectionStatus: 'connected',
        disconnectReason: null,
        reconnectAllowed: false,
        reconnectAttempts: 0,
        reconnecting: false,
        readLoopGeneration: runtime.readLoopGeneration,
        manuallyClosed: false,
        busy: false,
      } : item));
      notify(options?.automatic ? `SSH 自动重连成功（第 ${options.attempt ?? 1} 次）。` : '已重新连接，可以继续操作。', 'success');
      return true;
    } catch (error) {
      if (!stillWanted()) return false;
      setSessions(previous => previous.map(item => item.id === sessionId ? {
        ...item, connected: false, connectionStatus: 'disconnected', reconnecting: false, busy: false,
      } : item));
      if (!options?.automatic) notify(error instanceof Error ? error.message : '重新连接失败', 'error');
      else console.info(`SSH 自动重连请求失败 connectionId=${session.connectionId} attempt=${options.attempt ?? 1} reason=${error instanceof Error ? error.message : '重新连接失败'}`);
      return false;
    } finally { opening.current.delete(sessionId); }
  };
  const handleReconnectExhausted = (tabId: string, sourceRuntime?: RemoteTerminal) => {
    if (sourceRuntime && remoteClients.current.get(tabId) !== sourceRuntime) return;
    setSessions(previous => previous.map(session => session.id === tabId && !session.manuallyClosed ? {
      ...session,
      terminalSessionId: '',
      connected: false,
      connectionStatus: 'disconnected',
      reconnectAllowed: false,
      reconnecting: false,
      busy: false,
    } : session));
  };
  const closeTerminalSession = async (tabId: string) => {
    const session = sessionsRef.current.find(item => item.id === tabId);
    if (!session) return true;
    setTerminalError('');
    try {
      const runtime = remoteClients.current.get(tabId);
      const shouldClose = !!session.terminalSessionId && (!runtime?.disconnected || session.manuallyClosed) && !runtime?.closed;
      runtime?.markManuallyClosed();
      setSessions(previous => previous.map(item => item.id === tabId ? {
        ...item,
        connected: false,
        connectionStatus: 'disconnected',
        disconnectReason: 'CLIENT_CLOSED',
        reconnectAllowed: false,
        reconnecting: false,
        manuallyClosed: true,
        busy: false,
      } : item));
      if (shouldClose) await terminalApi.close(session.terminalSessionId);
      setSessions(previous => previous.map(item => item.id === tabId ? { ...item, terminalSessionId: '' } : item));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '关闭终端失败';
      setTerminalError(message); notify(message, 'error'); return false;
    }
  };
  const removeHost = async (hostId: string) => {
    return connections.remove(hostId);
  };
  const removeSessionTab = (id: string) => {
    remoteClients.current.get(id)?.markManuallyClosed();
    const remaining = sessionsRef.current.filter(session => session.id !== id);
    sessionsRef.current = remaining;
    setSessions(previous => previous.filter(session => session.id !== id));
    setActiveId(current => current === id ? remaining[0]?.id ?? '' : current);
    running.current.delete(id);
    remoteClients.current.delete(id);
    tabLastUsedAt.current.delete(id);
  };
  const closeSession = (id: string) => {
    const session = sessionsRef.current.find(item => item.id === id);
    if (!session || disconnectTarget) return;
    const runtime = remoteClients.current.get(id);
    if (!session.connected || runtime?.disconnected || runtime?.closed) {
      // A restored tab may still be waiting for /connected. Close its saved ID
      // in the background, but an already-invalid ID needs no extra request.
      if (session.terminalSessionId && !runtime?.disconnected && !runtime?.closed) {
        runtime?.markManuallyClosed();
        void terminalApi.close(session.terminalSessionId).catch(() => undefined);
      }
      removeSessionTab(id);
      return;
    }
    setDialog(null);
    setTerminalError('');
    setDisconnectTarget({ tabId: id, host: hosts.find(item => item.id === session.connectionId) ?? session.host });
  };
  const confirmDisconnect = async () => {
    if (!disconnectTarget) return false;
    const target = disconnectTarget;
    const targetSession = sessions.find(session => session.id === target.tabId);
    if (!targetSession || !await closeTerminalSession(target.tabId)) return false;
    let historySaved = true;
    try { recordDisconnect(target.host); }
    catch { historySaved = false; }
    removeSessionTab(target.tabId);
    setDisconnectTarget(null);
    notify(historySaved ? `当前 ${target.host.name} 终端页签已断开并关闭。` : `当前终端页签已关闭，但本机存储不可用，未能保留连接记录。`, historySaved ? 'success' : 'error');
    return true;
  };
  const fill = (command: string) => {
    setNavigation('命令');
    if (!active) { openNewTerminal(); notify('请先添加并连接一台远程服务器。'); return; }
    const client = remoteClients.current.get(active.id);
    if (!active.connected || !client || client.sessionId !== active.terminalSessionId || client.closed || client.disconnected) {
      notify('当前终端连接不可用，请点击“重新连接”。'); return;
    }
    void client.write(command).catch(error => notify(error instanceof Error ? error.message : '命令写入失败', 'error'));
  };
  const execute = async (request: CommandRequest) => {
    const session = sessions.find(item => item.id === request.sessionId);
    if (!session || running.current.has(session.id)) return;
    if (!session.connected) { notify('当前终端连接不可用，请点击“重新连接”。', 'error'); return; }
    running.current.add(session.id);
    setSessions(previous => previous.map(item => item.id === session.id ? { ...item, busy: true } : item));
    try {
      const client = remoteClients.current.get(session.id);
      if (!client || client.sessionId !== session.terminalSessionId) throw new Error('当前终端会话不可用，请点击“重新连接”。');
      await client.exec(request.command);
    } catch (error) { notify(`${error instanceof Error ? error.message : '命令提交失败'}；未自动重试，请先检查终端输出。`, 'error'); }
    finally {
      running.current.delete(session.id);
      setSessions(previous => previous.map(item => item.id === session.id ? { ...item, busy: false } : item));
    }
  };
  const requestRun = (command: string) => {
    if (!command.trim()) return;
    if (!active) { openNewTerminal(); notify('请先添加并连接一台远程服务器。'); return; }
    if (!canRun) { notify(active.busy ? '命令正在执行，请稍候。' : '当前终端连接不可用，请点击“重新连接”。'); return; }
    void execute({ sessionId: active.id, command: command.trim() });
  };
  const navigate = (name: Navigation) => {
    setManageConnections(name === '连接');
    setNavigation('命令');
  };
  const updateFiles = (sessionId: string, update: (state: SessionFileState) => SessionFileState) => {
    setSessions(previous => updateSessionFiles(previous, sessionId, update));
  };
  const sendMessage = async (text: string, selectedAttachments: ChatAttachment[] = []): Promise<boolean> => {
    if (chatting.current || stopPending.current || historyLoadingId) return false;
    // Fix this turn's references before any session creation or network await.
    const attachments = selectedAttachments.map(file => ({ ...file }));
    const invalid = validateChatContent(text, attachments);
    if (invalid) { notify(invalid, 'error'); return false; }
    const currentSession = active;
    const client = currentSession ? remoteClients.current.get(currentSession.id) : undefined;
    const terminalSessionId = currentSession?.connected
      && client?.sessionId === currentSession.terminalSessionId
      && !client.closed && !client.disconnected
      ? currentSession.terminalSessionId
      : '';
    if (!selectedAgent) {
      notify('智能体尚未加载完成，请稍后重试。', 'error');
      return false;
    }

    chatting.current = true;
    const version = chatVersion.current;
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    chatAbort.current = controller;
    updateMessages(previous => [
      ...previous,
      { id: crypto.randomUUID(), role: 'user', text, attachments },
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
          throw new ChatRequestError(event.content || 'Agent 执行失败', event.code);
      }
    };

    try {
      if (!chatSessionId.current) {
        const created = await agentApi.createSession(selectedAgent.agentId, controller.signal);
        if (!created?.sessionId) throw new Error('后端未返回 Agent 会话 ID');
        if (controller.signal.aborted || version !== chatVersion.current) return false;
        chatSessionId.current = created.sessionId;
        setActiveChatSessionId(created.sessionId);
      }
      await agentApi.chatStream({
        agentId: selectedAgent.agentId,
        userId: agentApi.userId,
        sessionId: chatSessionId.current,
        terminalSessionId,
        message: text,
        ...(attachments.length ? { attachments: attachmentReferences(attachments) } : {}),
      }, receive, controller.signal);
      if (controller.signal.aborted || stopPending.current || version !== chatVersion.current) return false;
      updateAssistant(message => message.text ? message : appendText(message, '任务已完成。'));
      return true;
    } catch (error) {
      if (controller.signal.aborted || stopPending.current
          || (error instanceof DOMException && error.name === 'AbortError')) {
        updateAssistant(current => current.text || current.segments?.length
          ? current : appendText(current, '已停止生成。'));
        return false;
      }
      if (version !== chatVersion.current) return false;
      const message = error instanceof Error ? error.message : 'Agent 对话失败';
      updateAssistant(current => ({ ...appendText(current, `${current.text ? '\n\n' : ''}${message}`), error: true, errorCode: error instanceof ChatRequestError ? error.code : undefined }));
      notify(message, 'error');
      return false;
    } finally {
      if (chatAbort.current === controller) chatAbort.current = null;
      if (version === chatVersion.current) {
        chatting.current = false;
        setChatBusy(false);
      }
      if (version === chatVersion.current) {
        const sessionId = chatSessionId.current;
        try {
          await persistClientSession(selectedAgent.agentId, sessionId);
        } catch (persistError) {
          console.warn('客户端对话历史最终保存失败', persistError);
          if (version === chatVersion.current) notify('客户端历史保存失败，当前消息仍保留在页面中。', 'error');
        }
        if (version === chatVersion.current) await refreshChatSessions(selectedAgent.agentId);
      }
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
    chatDraft.clear();
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
      chatDraft.clear();
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
      const configured = hosts.find(item => item.id === session.connectionId);
      return configured && (session.title !== configured.name || session.host !== configured)
        ? { ...session, title: configured.name, host: configured }
        : session;
    }));
  }, [hosts]);

  useEffect(() => {
    if (restoredSessionsVerified.current) return;
    restoredSessionsVerified.current = true;
    sessions.forEach(session => {
      if (session.terminalSessionId) void verifyTerminalSession(session.id, session.terminalSessionId);
    });
  }, [sessions, verifyTerminalSession]);

  useEffect(() => {
    const verifyAfterNetworkRestore = () => {
      sessions.forEach(session => {
        if (session.terminalSessionId && !session.manuallyClosed) {
          void verifyTerminalSession(session.id, session.terminalSessionId);
        }
      });
    };
    window.addEventListener('online', verifyAfterNetworkRestore);
    return () => window.removeEventListener('online', verifyAfterNetworkRestore);
  }, [sessions, verifyTerminalSession]);

  return <div style={{ '--agent-width': `${agentWidth}%` } as CSSProperties} className={`app-shell ${agentCollapsed ? 'agent-collapsed' : ''} ${navCollapsed ? 'nav-collapsed' : ''} ${navigation === '连接' ? 'connections-view' : 'terminal-view'}`}>
    <AppHeader notify={notify} theme={theme} setTheme={setTheme} uploads={uploads} openUploads={() => setUploadsOpen(true)} />
    <ActivityBar active={manageConnections ? '连接' : navigation} onSelect={navigate} onSettings={() => setBackendSettingsOpen(true)} settingsOpen={backendSettingsOpen} collapsed={navCollapsed} toggleCollapsed={() => setNavCollapsed(value => !value)} />
    <ConnectionSidebar connections={{ ...connections, remove: removeHost }} sessions={sessions} activeHostId={active?.connectionId} terminal={selectHost} create={openNewConnection} manage={manageConnections} setManage={setManageConnections} />
    <main hidden={navigation !== '命令'} className={`central-workspace ${!active ? 'no-session' : ''} ${commandCollapsed ? 'command-collapsed' : ''}`}>
      <TerminalWorkspace
        remoteViews={sessions.map(session => {
          const runtime = remoteClients.current.get(session.id);
          return <Suspense key={session.id} fallback={session.id === activeId ? <p>正在加载终端…</p> : null}>
            <RemoteTerminalView key={runtime?.sessionId ?? `${session.id}:disconnected`} runtime={runtime} visible={session.id === activeId && navigation === '命令'}
              connected={session.connected && !!runtime && runtime.sessionId === session.terminalSessionId}
              disconnectReason={session.disconnectReason}
              reconnectAllowed={session.reconnectAllowed}
              reconnectAttempts={session.reconnectAttempts}
              reconnecting={session.reconnecting}
              manuallyClosed={session.manuallyClosed}
              onDisconnected={event => handleTerminalDisconnected(session.id, event, runtime)}
              onReconnectExhausted={() => handleReconnectExhausted(session.id, runtime)}
              reconnect={options => reconnectTerminal(session.id, options, runtime)}
              disconnect={() => closeSession(session.id)} />
          </Suspense>;
        })}
        connections={() => navigate('连接')}
        sessions={sessions}
        activeId={activeId}
        host={host}
        select={selectTerminalTab}
        close={closeSession}
        add={openNewTerminal}
        copy={copy}
        filesOpen={!!active?.fileState.open}
        toggleFiles={() => { if (active) updateFiles(active.id, state => ({ ...state, open: !state.open })); }}
        commandCollapsed={commandCollapsed}
        toggleCommands={() => setCommandCollapsed(value => !value)}
        agentCollapsed={agentCollapsed}
        toggleAgent={() => setAgentCollapsed(value => !value)}
        filePanel={active && <SessionFiles key={active.id} sessionTitle={active.title} files={active.fileState.files} selected={active.fileState.selected} expanded={active.fileState.expanded} select={selected => updateFiles(active.id, state => ({ ...state, selected }))} toggle={id => updateFiles(active.id, state => { const expanded = new Set(state.expanded); if (expanded.has(id)) expanded.delete(id); else expanded.add(id); return { ...state, expanded }; })} openUploads={() => setUploadsOpen(true)} refresh={() => { updateFiles(active.id, state => ({ ...createSessionFileState(), open: state.open })); notify('已恢复当前终端的演示文件树', 'success'); }} create={() => { setFileDialogSessionId(active.id); setDialog('file'); }} close={() => updateFiles(active.id, state => ({ ...state, open: false }))} copy={copy} notify={notify} />}
      />
      <CommandShelf commands={commands} category={category} setCategory={setCategory} fill={fill} run={requestRun} copy={copy} add={() => setDialog('command')} disabled={!canRun} collapsed={commandCollapsed} />
    </main>
    <PanelDivider value={agentWidth} change={setAgentWidth} />
    <AgentPanel chatDraft={chatDraft} draftScope={chatVersion.current} host={host} connected={!!active?.connected} messages={messages} busy={chatBusy} stopping={chatStopping} send={sendMessage} stop={stopChat} collapsed={agentCollapsed}
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
    {uploadsOpen && <FileUploadDialog queue={uploads} close={() => setUploadsOpen(false)} />}
    {toast && <NotificationToast key={toast.id} notice={toast} close={dismissNotice} />}
    {dialog === 'command' && <AddCommandDialog close={closeDialog} categories={[...new Set(commands.map(command => command.category))]} save={async command => {
      const next = [...commands, command];
      await saveClientCommands(next);
      setCommands(next);
      setCategory(command.category);
      closeDialog();
      notify('命令已保存到客户端', 'success');
    }} />}
    {dialog === 'file' && fileDialogSessionId && <CreateFileDialog close={closeDialog} path="/var/www/app" files={sessions.find(session => session.id === fileDialogSessionId)?.fileState.files ?? []} save={file => { updateFiles(fileDialogSessionId, state => ({ ...state, files: [...state.files, file], selected: file.id })); closeDialog(); notify('已在当前终端的演示文件树中创建', 'success'); }} />}
    {dialog === 'connection' && <SshConnectionDialog connections={connections} connectAfterSave={connectAfterSave} onClose={closeDialog} onSaved={saved => { if (connectAfterSave) void selectHost(saved.id, saved); else notify('SSH 连接已保存。', 'success'); }} />}
    {disconnectTarget && <DisconnectDialog key={disconnectTarget.tabId} host={hosts.find(item => item.id === disconnectTarget.host.id) ?? disconnectTarget.host} connected={sessions.find(session => session.id === disconnectTarget.tabId)?.connected === true} busy={false} error={terminalError} close={() => setDisconnectTarget(null)} confirm={confirmDisconnect} />}
    {backendSettingsOpen && <BackendSettingsDialog currentUrl={backendUrl} onClose={() => setBackendSettingsOpen(false)} onSave={url => {
      if (chatBusy || chatStopping || sessions.length > 0) {
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
