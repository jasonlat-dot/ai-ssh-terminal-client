import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTheme } from './state/useTheme';
import { useApplyClientAppearance } from './state/useClientAppearance';
import type { ThemePreference } from './state/useTheme';
import { agentApi } from './api/agent';
import type { AgentConfig, AgentStreamEvent, AgentHistory } from './api/agent';
import { readAgentHistory, turnMessages } from './state/agentHistory';
import {
  listClientChatSessions,
  loadClientChatSession,
  saveClientChatSession,
} from './state/clientChatHistory';
import type { ClientChatSession } from './state/clientChatHistory';
import { DisconnectDialog } from './components/DisconnectDialog';
import { recordDisconnect } from './state/connectionHistory';
import { loadClientCommands, saveClientCommands } from './state/clientCommands';
import { terminalApi } from './api/terminal';
import { SshConnectAttempt } from './state/sshConnectAttempt';
import { RemoteTerminal } from './state/remoteTerminal';
import type { TerminalDisconnectEvent } from './state/remoteTerminal';
import { LocalTerminal } from './state/localTerminal';
import type { TerminalRuntime } from './state/terminalRuntime';
import { isTauriRuntime } from './state/runtime';
import { isSessionConnected, loadTerminalSessions, saveTerminalSessions, terminalSessionsStorageKey } from './state/terminalSessions';
import { reorderTerminalSessions, replaceTerminalPane, selectTerminalPane, visibleTerminalIds } from './state/terminalLayout';
import type { TerminalLayout } from './state/terminalLayout';
import { canSubmitTerminalCommand, resolveTerminalCommandTargets, submitTerminalCommandBatch } from './state/terminalBroadcast';
import type { TerminalCommandMode } from './state/terminalBroadcast';
import { TerminalCommandBar } from './components/TerminalCommandBar';
import { copyText } from './state/clipboard';
import { NotificationToast } from './components/NotificationToast';
import type { Notice, NoticeType } from './components/NotificationToast';
import { ConnectionSidebar } from './components/Connections';
import { SshConnectionDialog } from './components/SshConnectionDialog';
import { useSshConnections } from './state/useSshConnections';
import { PanelDivider } from './components/PanelDivider';
import { AgentPanel } from './components/AgentPanel';
import type { AgentComposerHandle } from './components/AgentPanel';
import { AddCommandDialog } from './components/Dialogs';
import { SessionFiles } from './components/Sidebar';
import { AttachmentPreviews, ChatAttachmentDraft, attachmentReferences, validateChatContent } from './state/chatAttachments';
import { ChatRequestError } from './api/chatErrors';
import { ActivityBar, AppHeader } from './components/Shell';
import { RustBackendSettingsDialog as BackendSettingsDialog } from './components/RustBackendSettingsDialog';
import { usingRustBuiltinBackend } from './config/rustPreview';
import { FileUploadDialog } from './components/FileUploadDialog';
import { FileUploadQueue } from './state/fileUploads';
import { adoptBundledBackendUrl, readBackendUrl, saveBackendUrl } from './config/backend';
import { watchBundledBackendStatus, restartBundledBackend, type BundledBackendStatus } from './api/bundledBackend';
import { probeBackendHealth } from './api/health';
import { StartupScreen } from './components/StartupScreen';
import type { StartupHealth, StartupPhase } from './components/StartupScreen';
import { CommandShelf, TerminalWorkspace } from './components/Workspace';
import { Select } from './components/Select';
import { createSessionFileState, initialCommands } from './data/mock';
import type { ChatAttachment, ChatAgentActivity, ChatMessage, ChatMessageSegment, ChatToolActivity, Host, Navigation, TerminalSession } from './types';
import './App.css';
import './reference.css';
import './typography.css';
import './wallpaper.css';
import './client-text-colors.css';
import './client-typography.css';
import { useApplyClientTextColors } from './state/useClientTextColors';
import { useApplyClientTypography } from './state/useClientTypography';
import { StartupUpdatePrompt } from './components/StartupUpdatePrompt';
import './panel-resize.css';
import './components/TerminalLayout.css';

const RemoteTerminalView = lazy(() => import('./components/RemoteTerminalView').then(module => ({ default: module.RemoteTerminalView })));

type Dialog = 'command' | 'connection' | null;
const STALE_TERMINAL_TAB_MS = 5 * 60 * 1000;
const CONNECTION_SIDEBAR_COLLAPSED_KEY = 'ai-ssh-terminal:connection-sidebar-collapsed';

function AppContent({ backendUrl, onBackendChange, theme, setTheme, updateSettingsRequested, clearUpdateSettingsRequest }: {
  backendUrl: string;
  onBackendChange: (url: string) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  updateSettingsRequested: boolean;
  clearUpdateSettingsRequest: () => void;
}) {
  const rustBuiltin = usingRustBuiltinBackend();
  const [navigation, setNavigation] = useState<Navigation>('命令');
  const connections = useSshConnections();
  const { hosts } = connections;
  const [agentWidth, setAgentWidth] = useState(22);
  const [commandWidth, setCommandWidth] = useState(260);
  const [connectionSidebarWidth, setConnectionSidebarWidth] = useState(() => window.innerWidth <= 1280 ? 194 : 224);
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [connectionSidebarCollapsed, setConnectionSidebarCollapsed] = useState(
    () => localStorage.getItem(CONNECTION_SIDEBAR_COLLAPSED_KEY) === 'true',
  );
  const [sessions, setSessions] = useState(() => loadTerminalSessions(backendUrl));
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [activeId, setActiveId] = useState(() => sessions[0]?.id ?? '');
  const [terminalLayout, setTerminalLayout] = useState<TerminalLayout>('single');
  const [terminalPanes, setTerminalPanes] = useState<string[]>([]);
  const [commandMode, setCommandMode] = useState<TerminalCommandMode>('single');
  const [commandTargetIds, setCommandTargetIds] = useState<string[]>([]);
  const [broadcastDraft, setBroadcastDraft] = useState('');
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState('');
  const broadcastInput = useRef<HTMLTextAreaElement>(null);
  const broadcastSubmitting = useRef(false);
  const terminalIdsKey = sessions.map(session => session.id).join(',');
  useEffect(() => {
    const ids = new Set(sessionsRef.current.map(session => session.id));
    setCommandTargetIds(previous => previous.every(id => ids.has(id)) ? previous : previous.filter(id => ids.has(id)));
  }, [terminalIdsKey]);
  useEffect(() => { setCommandMode('single'); setCommandTargetIds([]); setBroadcastDraft(''); setBroadcastResult(''); }, [backendUrl]);
  const visibleIds = visibleTerminalIds(sessions.map(session => session.id), activeId, terminalLayout, terminalPanes);
  const visibleKey = visibleIds.join(',');
  useLayoutEffect(() => {
    if (terminalLayout !== 'single') setTerminalPanes(previous => previous.join(',') === visibleKey ? previous : visibleIds);
  }, [visibleKey, terminalLayout]);
  const [commands, setCommands] = useState(initialCommands);
  const [category, setCategory] = useState('全部');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const clientHistoryDirty = useRef(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStopping, setChatStopping] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(null);
  const [agentModels, setAgentModels] = useState<AgentConfig[]>([]);
  const [modelSettingsRequested, setModelSettingsRequested] = useState(false);
  const [historyMore, setHistoryMore] = useState('');
  const [canonicalHistory, setCanonicalHistory] = useState<AgentHistory | null>(null);
  const chatTarget = useRef<{connectionId:string;terminalSessionId:string}|null>(null);
  const recoveredRunning = canonicalHistory?.turns.some(turn => turn.state === 'running') ?? false;
  const [agentLoading, setAgentLoading] = useState(true);
  const [agentLoadError, setAgentLoadError] = useState('');
  const [agentLoadAttempt, setAgentLoadAttempt] = useState(0);
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
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadQueue] = useState(() => new FileUploadQueue());
  useEffect(() => { uploadQueue.activate(); return () => uploadQueue.deactivate(); }, [uploadQueue]);
  useEffect(() => { if (updateSettingsRequested) setBackendSettingsOpen(true); }, [updateSettingsRequested]);
  const [attachmentPreviews] = useState(() => new AttachmentPreviews());
  const [chatDraft] = useState(() => new ChatAttachmentDraft(attachmentPreviews));
  const agentComposer = useRef<AgentComposerHandle>(null);
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
  const [fileWindows, setFileWindows] = useState<{ connectionId: string; title: string }[]>([]);
  const [visibleFiles, setVisibleFiles] = useState('');
  const openFiles = (connectionId: string, title: string) => {
    setFileWindows(previous => previous.some(item => item.connectionId === connectionId) ? previous : [...previous, { connectionId, title }]);
    setVisibleFiles(connectionId);
  };
  const [toast, setToast] = useState<Notice | null>(null);
  const noticeSequence = useRef(0);
  const [commandCollapsed, setCommandCollapsed] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(rustBuiltin);
  // 应用关闭流程的全局标志位：避免 Tauri onCloseRequested 与 in-page 关闭按钮、
  // 终端页签关闭等其他路径在快速关窗时重复触发清理。
  const closingApp = useRef(false);
  // 由各个文件管理窗口注册的“应用关闭前”清理器；
  // connectionId -> () => Promise<void>，调用方负责关掉后端 SFTP 会话。
  const sftpCleanups = useRef(new Map<string, () => Promise<void>>());
  const registerAppCloseCleanup = useCallback((id: string, handler: () => Promise<void>) => {
    sftpCleanups.current.set(id, handler);
    return () => { sftpCleanups.current.delete(id); };
  }, []);
  const chatVersion = useRef(0);
  const chatting = useRef(false);
  const chatSessionId = useRef('');
  const chatRequestId = useRef('');
  const chatAbort = useRef<AbortController | null>(null);
  const stopPending = useRef(false);
  const historySelection = useRef(0);
  const running = useRef(new Map<string, TerminalRuntime>());
  const terminalClients = useRef(new Map<string, TerminalRuntime>());
  const restoredClientsInitialized = useRef(false);
  const restoredSessionsVerified = useRef(false);
  if (!restoredClientsInitialized.current) {
    sessions.forEach(session => {
      if (session.terminalSessionId) {
        terminalClients.current.set(session.id, new RemoteTerminal({
          sessionId: session.terminalSessionId,
          connectionId: session.connectionId,
          initialOutput: '',
        }, true, backendUrl));
      }
    });
    restoredClientsInitialized.current = true;
  }
  const opening = useRef(new Set<string>());
  const openingConnections = useRef(new Map<string, { attempt: SshConnectAttempt; tabId: string }>());
  const reconnectingAttempts = useRef(new Map<string, SshConnectAttempt>());
  const [connectingHostIds, setConnectingHostIds] = useState<Set<string>>(() => new Set());
  const tabLastUsedAt = useRef(new Map<string, number>());
  const [terminalError, setTerminalError] = useState('');
  const [connectAfterSave, setConnectAfterSave] = useState(false);
  const active = sessions.find(session => session.id === activeId);
  const host = hosts.find(item => item.id === active?.connectionId) ?? active?.host;
  const activeClient = active ? terminalClients.current.get(active.id) : undefined;
  const canRun = !!active && isSessionConnected(active) && !active.busy
    && activeClient?.sessionId === active.terminalSessionId
    && !activeClient.closed && !activeClient.disconnected && activeClient.transportAvailable !== false;
  const commandPlan = resolveTerminalCommandTargets(sessions, terminalClients.current, commandMode, activeId, commandTargetIds);

  useEffect(() => {
    try { saveTerminalSessions(backendUrl, sessions); }
    catch (error) { console.warn('保存终端页签恢复信息失败', error); }
  }, [backendUrl, sessions]);
  useEffect(() => {
    localStorage.setItem(CONNECTION_SIDEBAR_COLLAPSED_KEY, String(connectionSidebarCollapsed));
  }, [connectionSidebarCollapsed]);
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

  useEffect(() => {
    const initialAttempts = openingConnections.current;
    const retries = reconnectingAttempts.current;
    const clients = terminalClients.current;
    const fileCleanups = sftpCleanups.current;
    return () => {
      initialAttempts.forEach(({ attempt }) => attempt.cancel());
      retries.forEach(attempt => attempt.cancel());
      initialAttempts.clear();
      retries.clear();
      // 重新初始化会卸载旧工作区：停止旧实例的输出订阅与文件传输。
      clients.forEach(client => { void client.close().catch(() => undefined); });
      clients.clear();
      fileCleanups.forEach(cleanup => { void cleanup().catch(() => undefined); });
      fileCleanups.clear();
    };
  }, []);

  useEffect(() => {
    // 必须等待连接列表成功加载，不能把“接口尚未返回时的空数组”当成真实空数据库。
    if (!connections.loaded) return;

    const configuredConnectionIds = new Set(hosts.map(item => item.id));
    const staleSessions = sessionsRef.current.filter(session =>
      session.kind === 'ssh' && !configuredConnectionIds.has(session.connectionId));
    if (staleSessions.length === 0) return;

    const staleTabIds = new Set(staleSessions.map(session => session.id));
    const staleConnectionIds = new Set(staleSessions.map(session => session.connectionId));
    const remainingSessions = sessionsRef.current.filter(session => !staleTabIds.has(session.id));

    // 连接记录已经不在当前数据库中，旧页签无法重新连接；同时释放可能仍存活的后端终端会话。
    staleSessions.forEach(session => {
      reconnectingAttempts.current.get(session.id)?.cancel();
      reconnectingAttempts.current.delete(session.id);
      const runtime = terminalClients.current.get(session.id);
      if (runtime) void runtime.close().catch(() => undefined);
      terminalClients.current.delete(session.id);
      tabLastUsedAt.current.delete(session.id);
      running.current.delete(session.id);
      opening.current.delete(session.id);
    });

    sessionsRef.current = remainingSessions;
    setSessions(remainingSessions);
    setActiveId(current => staleTabIds.has(current) ? remainingSessions[0]?.id ?? '' : current);
    setDisconnectTarget(current => current && staleTabIds.has(current.tabId) ? null : current);

    // 文件窗口同样依赖连接配置；删除对应窗口，避免留下另一个不可操作的旧入口。
    setFileWindows(previous => previous.filter(window => !staleConnectionIds.has(window.connectionId)));
    setVisibleFiles(current => staleConnectionIds.has(current) ? '' : current);

    notify(
      staleSessions.length === 1
        ? `已关闭失效的终端标签“${staleSessions[0].title}”：当前数据库中已没有对应的 SSH 连接。`
        : `已关闭 ${staleSessions.length} 个失效的终端标签：当前数据库中已没有对应的 SSH 连接。`,
      'info',
      5_000,
    );
  }, [connections.loaded, hosts, notify]);

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
    if (rustBuiltin) { clientHistoryDirty.current = false; return; }
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
  }, [backendUrl, rustBuiltin]);
  const refreshChatSessions = useCallback(async (agentId: string, after = '') => {
    const version = ++historyRefreshVersion.current;
    setHistoryLoading(true);
    try {
      const nativeSessions = rustBuiltin ? await agentApi.sessions(agentId, after) : null;
      const sessions = nativeSessions ? nativeSessions.map(session => ({
        sessionId: session.id, title: session.task?.goal.slice(0,80) || '新会话', messageCount: 0, createdAt: 0, updatedAt: 0,
      })) : await listClientChatSessions({
        backendUrl,
        userId: agentApi.userId,
        agentId,
      });
      if (version === historyRefreshVersion.current) {
        setChatSessions(previous => after ? [...previous, ...sessions.filter(s => !previous.some(p => p.sessionId === s.sessionId))] : sessions);
        setHistoryMore(nativeSessions?.length === 20 ? nativeSessions[19].id : '');
        setHistoryError('');
      }
    } catch (error) {
      if (version === historyRefreshVersion.current) {
        setHistoryError(error instanceof Error ? error.message : '加载历史会话失败');
      }
    } finally {
      if (version === historyRefreshVersion.current) setHistoryLoading(false);
    }
  }, [backendUrl, rustBuiltin]);
  const dismissNotice = useCallback(() => setToast(null), []);
  useEffect(() => { if (connections.error) notify(connections.error, 'error'); }, [connections.error, notify]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setAgentLoading(true);
    setAgentLoadError('');
    const timeout = setTimeout(() => {
      if (cancelled) return;
      controller.abort();
      setAgentLoading(false);
      setAgentLoadError('加载智能体超时，请检查应用工作区后重试。');
    }, 15_000);
    void agentApi.list(controller.signal)
      .then(items => {
        if (cancelled || controller.signal.aborted) return;
        const available = Array.isArray(items) ? items.filter(item => typeof item?.agentId === 'string' && item.agentId.trim()) : [];
        setAgentModels(available);
        setSelectedAgent(previous => available.find(item => item.agentId === previous?.agentId) ?? available[0] ?? null);
        if (!available.length) setAgentLoadError('请在模型设置中添加可用配置。');
      })
      .catch(error => {
        if (!cancelled && !controller.signal.aborted) setAgentLoadError(error instanceof Error ? error.message : '加载智能体失败，请重试。');
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!cancelled) setAgentLoading(false);
      });
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [agentLoadAttempt, rustBuiltin]);
  useEffect(() => {
    chatVersion.current += 1; historySelection.current += 1; historyRefreshVersion.current += 1;
    chatSessionId.current = ''; chatTarget.current = null; setCanonicalHistory(null);
    setActiveChatSessionId(''); setChatSessions([]); setHistoryMore(''); setHistoryLoadingId('');
    chatDraft.clear(); replaceMessages([]);
  }, [selectedAgent?.agentId, chatDraft, replaceMessages]);
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
  const closeDialog = () => { setDialog(null); };
  const copy = async (text: string) => {
    try { await copyText(text); notify('已复制到剪贴板', 'success'); }
    catch { notify('复制失败：请选中文字后使用 Ctrl+C 复制。', 'error'); }
  };
  const openNewConnection = () => { setConnectAfterSave(false); setDialog('connection'); };
  const openNewTerminal = async () => {
    if (!isTauriRuntime()) {
      notify('本地 CMD 仅在桌面客户端中可用。', 'error');
      return;
    }

    const tabId = crypto.randomUUID();
    opening.current.add(tabId);
    try {
      notify('正在启动本地 CMD…');
      const runtime = await LocalTerminal.open();
      const host: Host = {
        id: runtime.connectionId,
        name: '本地 CMD',
        user: '本机',
        address: runtime.cwd,
        saved: false,
      };
      terminalClients.current.set(tabId, runtime);
      tabLastUsedAt.current.set(tabId, Date.now());
      setSessions(previous => [...previous, {
        id: tabId,
        kind: 'local',
        connectionId: runtime.connectionId,
        terminalSessionId: runtime.sessionId,
        connected: true,
        connectionStatus: 'connected',
        disconnectReason: null,
        reconnectAllowed: false,
        reconnectAttempts: 0,
        reconnecting: false,
        readLoopGeneration: 0,
        manuallyClosed: false,
        host,
        title: '本地 CMD',
        busy: false,
        fileState: createSessionFileState(),
      }]);
      setActiveId(tabId);
      setNavigation('命令');
      notify('本地 CMD 已打开。', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '启动本地 CMD 失败', 'error');
    } finally {
      opening.current.delete(tabId);
    }
  };
  const openTerminalRuntime = async (attempt: SshConnectAttempt, stillWanted = () => true) => {
    let opened: Awaited<ReturnType<typeof terminalApi.connect>> | undefined;
    try {
      if (attempt.signal.aborted || !stillWanted()) throw new DOMException('SSH 连接已取消', 'AbortError');
      opened = await attempt.open();
      if (!opened?.sessionId) throw new Error('应用未返回终端会话 ID');
      if (attempt.signal.aborted || !stillWanted()) throw new DOMException('SSH 连接已取消', 'AbortError');
      const runtime = new RemoteTerminal(opened, false, attempt.backendUrl);
      if (runtime.disconnected) throw new Error('终端会话已断开，请重试。');
      return runtime;
    } catch (error) {
      if (opened?.sessionId) void terminalApi.close(opened.sessionId, undefined, attempt.backendUrl).catch(() => undefined);
      throw error;
    }
  };
  const cancelHostConnection = (id: string) => {
    const pending = openingConnections.current.get(id);
    if (!pending) return;
    openingConnections.current.delete(id);
    opening.current.delete(pending.tabId);
    pending.attempt.cancel();
    setConnectingHostIds(current => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    notify(`已取消连接 ${hosts.find(item => item.id === id)?.name ?? '服务器'}。`);
  };
  const selectHost = async (id: string, suppliedHost?: Host) => {
    const nextHost = suppliedHost ?? hosts.find(item => item.id === id);
    if (!nextHost) return;
    if (openingConnections.current.has(id)) {
      notify(`${nextHost.name} 正在连接中，请等待当前连接请求完成。`, 'info', 5000);
      return;
    }
    const tabId = crypto.randomUUID();
    const attempt = new SshConnectAttempt(id, backendUrl);
    const pending = { attempt, tabId };
    openingConnections.current.set(id, pending);
    setConnectingHostIds(current => new Set(current).add(id));
    opening.current.add(tabId);
    try {
      // 首次连接可能一直等待到 SSH 超时，提示在请求结束前保持可见，避免用户误以为没有响应而重复点击。
      notify(`正在连接 ${nextHost.name} 并打开远程终端，请稍候…`, 'info', 60_000);
      const runtime = await openTerminalRuntime(attempt, () => openingConnections.current.get(id) === pending);
      if (attempt.signal.aborted || openingConnections.current.get(id) !== pending) {
        runtime.markManuallyClosed();
        attempt.cancel();
        void terminalApi.close(runtime.sessionId, undefined, attempt.backendUrl).catch(() => undefined);
        return;
      }
      terminalClients.current.set(tabId, runtime);
      tabLastUsedAt.current.set(tabId, Date.now());
      setSessions(previous => [...previous, {
        id: tabId,
        kind: 'ssh',
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
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        notify(error instanceof Error ? error.message : '打开终端失败', 'error', 8000);
      }
      attempt.cancel();
    }
    finally {
      if (openingConnections.current.get(id) === pending) {
        openingConnections.current.delete(id);
        setConnectingHostIds(current => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
      opening.current.delete(tabId);
    }
  };
  const handleTerminalDisconnected = (sessionId: string, event: TerminalDisconnectEvent, sourceRuntime?: TerminalRuntime) => {
    if (sourceRuntime && terminalClients.current.get(sessionId) !== sourceRuntime) {
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
  const handleTerminalTransport = (sessionId: string, available: boolean, sourceRuntime?: TerminalRuntime) => {
    if (!sourceRuntime || terminalClients.current.get(sessionId) !== sourceRuntime || sourceRuntime.manuallyClosed) return;
    setSessions(previous => previous.map(session => {
      if (session.id !== sessionId || session.kind !== 'ssh' || session.manuallyClosed || session.reconnecting
        || session.terminalSessionId !== sourceRuntime.sessionId || sourceRuntime.disconnected) return session;
      const connectionStatus = available ? 'connected' : 'unreachable';
      return session.connectionStatus === connectionStatus ? session : {
        ...session, connectionStatus, connected: available || session.connected,
      };
    }));
  };
  const verifyTerminalSession = useCallback(async (tabId: string, terminalSessionId: string) => {
    if (!terminalSessionId) return false;
    const runtime = terminalClients.current.get(tabId);
    if (!runtime || runtime.sessionId !== terminalSessionId) return false;
    try {
      const state = await runtime.verifyConnected();
      if (terminalClients.current.get(tabId) !== runtime || runtime.manuallyClosed) return false;
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
  const selectTerminalTab = (tabId: string, panes?: string[]) => {
    if (terminalLayout !== 'single') setTerminalPanes(panes ?? selectTerminalPane(visibleIds, activeId, tabId));
    const now = Date.now();
    if (activeId && activeId !== tabId) tabLastUsedAt.current.set(activeId, now);
    const lastUsedAt = tabLastUsedAt.current.get(tabId) ?? 0;
    const session = sessions.find(item => item.id === tabId);
    tabLastUsedAt.current.set(tabId, now);
    setActiveId(tabId);
    if (session?.kind === 'ssh' && session.terminalSessionId && (!session.connected || now - lastUsedAt >= STALE_TERMINAL_TAB_MS)) {
      void verifyTerminalSession(tabId, session.terminalSessionId);
    }
  };
  const activateTerminalFromSidebar = (tabId: string) => {
    selectTerminalTab(tabId);
    setNavigation('命令');
  };
  const cancelTerminalReconnect = (sessionId: string, quiet = false) => {
    const attempt = reconnectingAttempts.current.get(sessionId);
    reconnectingAttempts.current.delete(sessionId);
    opening.current.delete(sessionId);
    attempt?.cancel();
    const runtime = terminalClients.current.get(sessionId);
    runtime?.markManuallyClosed();
    if (runtime?.sessionId) {
      void terminalApi.close(runtime.sessionId, undefined, attempt?.backendUrl ?? backendUrl).catch(() => undefined);
    }
    const cancelState = (session: TerminalSession): TerminalSession => session.id === sessionId ? {
      ...session, connected: false, connectionStatus: 'disconnected', disconnectReason: 'CLIENT_CLOSED',
      reconnectAllowed: false, reconnecting: false, reconnectAttempts: 0, manuallyClosed: true, busy: false,
    } : session;
    sessionsRef.current = sessionsRef.current.map(cancelState);
    setSessions(previous => previous.map(cancelState));
    if (!quiet) notify('已取消连接，可点击“重新连接”再试。');
  };
  const reconnectTerminal = async (
    sessionId: string,
    options?: { automatic?: boolean; attempt?: number; totalAttempts?: number },
    sourceRuntime?: TerminalRuntime,
  ) => {
    if (sourceRuntime && terminalClients.current.get(sessionId) !== sourceRuntime) {
      console.info(`忽略旧终端实例的重连请求 oldTerminalSessionId=${sourceRuntime.sessionId} logicalSessionId=${sessionId}`);
      return true;
    }
    const session = sessionsRef.current.find(item => item.id === sessionId);
    if (!session || opening.current.has(sessionId)) return false;
    if (session.kind === 'local') return false;
    if (options?.automatic && (!session.reconnectAllowed || session.manuallyClosed || sourceRuntime?.manuallyClosed)) {
      console.info(`忽略未获后端允许的自动重连 logicalSessionId=${sessionId}`);
      return false;
    }
    opening.current.add(sessionId);
    const attempt = new SshConnectAttempt(session.connectionId, backendUrl);
    reconnectingAttempts.current.set(sessionId, attempt);
    const previousRuntime = terminalClients.current.get(sessionId);
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
      notify(`SSH 已断开，正在进行第 ${options.attempt ?? 1}/${options.totalAttempts ?? 1} 次自动重连…`);
    } else {
      notify('正在重新连接服务器并创建终端会话…');
    }
    const stillWanted = () => {
      const current = sessionsRef.current.find(item => item.id === sessionId);
      return !attempt.signal.aborted && reconnectingAttempts.current.get(sessionId) === attempt
        && !!current && !current.manuallyClosed && !previousRuntime?.manuallyClosed
        && terminalClients.current.get(sessionId) === previousRuntime;
    };
    try {
      // 重连要关闭旧后端 Channel，但不能把旧运行时标记为“用户主动关闭”，否则 stillWanted 会取消本次重连。
      if (previousRuntime?.sessionId) await terminalApi.close(previousRuntime.sessionId, attempt.signal, attempt.backendUrl)
        .catch(error => { if (attempt.signal.aborted) throw error; });
      const runtime = await openTerminalRuntime(attempt, stillWanted);
      const currentSession = sessionsRef.current.find(item => item.id === sessionId);
      const currentRuntime = terminalClients.current.get(sessionId);
      if (!stillWanted() || !currentSession || currentSession.manuallyClosed || previousRuntime?.manuallyClosed
        || (previousRuntime ? currentRuntime !== previousRuntime : !!currentRuntime)) {
        runtime.markManuallyClosed();
        attempt.cancel();
        void terminalApi.close(runtime.sessionId, undefined, attempt.backendUrl).catch(() => undefined);
        return false;
      }
      terminalClients.current.set(sessionId, runtime);
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
      else {
        const reason = error instanceof Error ? error.message : '重新连接失败';
        console.info(`SSH 自动重连请求失败 connectionId=${session.connectionId} attempt=${options.attempt ?? 1} reason=${reason}`);
        notify(`第 ${options.attempt ?? 1}/${options.totalAttempts ?? 1} 次自动重连失败：${reason}`, 'error');
      }
      attempt.cancel();
      return false;
    } finally {
      if (reconnectingAttempts.current.get(sessionId) === attempt) {
        reconnectingAttempts.current.delete(sessionId);
        opening.current.delete(sessionId);
      }
    }
  };
  const handleReconnectExhausted = (tabId: string, attempts: number, sourceRuntime?: TerminalRuntime) => {
    if (sourceRuntime && terminalClients.current.get(tabId) !== sourceRuntime) return;
    setSessions(previous => previous.map(session => session.id === tabId && !session.manuallyClosed ? {
      ...session,
      terminalSessionId: '',
      connected: false,
      connectionStatus: 'disconnected',
      reconnectAllowed: false,
      reconnecting: false,
      busy: false,
    } : session));
    notify(`SSH 自动重连已连续失败 ${attempts} 次，请检查网络、账号或密码后手动重新连接。`, 'error');
  };
  const closeTerminalSession = async (tabId: string) => {
    const session = sessionsRef.current.find(item => item.id === tabId);
    if (!session) return true;
    setTerminalError('');
    try {
      const runtime = terminalClients.current.get(tabId);
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
      if (shouldClose) await runtime?.close();
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
    if (reconnectingAttempts.current.has(id)) cancelTerminalReconnect(id, true);
    terminalClients.current.get(id)?.markManuallyClosed();
    const remaining = sessionsRef.current.filter(session => session.id !== id);
    sessionsRef.current = remaining;
    setSessions(previous => previous.filter(session => session.id !== id));
    setActiveId(current => current === id ? remaining[0]?.id ?? '' : current);
    running.current.delete(id);
    terminalClients.current.delete(id);
    tabLastUsedAt.current.delete(id);
  };
  const closeSession = (id: string) => {
    const session = sessionsRef.current.find(item => item.id === id);
    if (!session || disconnectTarget) return;
    const runtime = terminalClients.current.get(id);
    if (session.reconnecting || reconnectingAttempts.current.has(id)) {
      cancelTerminalReconnect(id, true);
      removeSessionTab(id);
      return;
    }
    if (session.kind === 'local') {
      void runtime?.close().catch(error => {
        notify(error instanceof Error ? error.message : '关闭本地 CMD 失败', 'error');
      });
      removeSessionTab(id);
      return;
    }
    if (!session.connected || runtime?.disconnected || runtime?.closed) {
      // A restored tab may still be waiting for /connected. Close its saved ID
      // in the background, but an already-invalid ID needs no extra request.
      if (session.terminalSessionId && !runtime?.disconnected && !runtime?.closed) {
        runtime?.markManuallyClosed();
        void runtime?.close().catch(() => undefined);
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
  /**
   * 关窗前的集中清理：取消所有未完成的连接尝试、关闭每个终端运行时、
   * 通知文件管理窗口释放后端 SFTP 会话。所有 IO 失败都吞掉，只记日志。
   *
   * 调用方在 await 之后调 getCurrentWindow().destroy() 真正退出。
   */
  const cleanupBeforeClose = useCallback(async (maximumWaitMs?: number) => {
    if (closingApp.current) return;
    closingApp.current = true;
    // 1) 取消尚未完成的 SSH 连接尝试（包括重连），释放对应 AbortController。
    openingConnections.current.forEach(({ attempt }) => attempt.cancel());
    openingConnections.current.clear();
    setConnectingHostIds(new Set());
    reconnectingAttempts.current.forEach(attempt => attempt.cancel());
    reconnectingAttempts.current.clear();

    // 2) 关闭每个打开的终端（本地 CMD + 远程 SSH）。markManuallyClosed() 让运行时
    //    停止内部的 read loop / 自动重连，close() 才会真正发往后端释放会话。
    const runtimeCloses: Promise<unknown>[] = [];
    terminalClients.current.forEach(runtime => {
      try { runtime.markManuallyClosed(); }
      catch (error) { console.warn('标记终端为手动关闭失败', error); }
      runtimeCloses.push(Promise.resolve(runtime.close()).catch(error => console.warn('关闭终端会话失败', error)));
    });
    terminalClients.current.clear();

    // 3) 释放每个文件管理窗口的 SFTP 会话。组件已经被销毁（关窗过程中）也要兜底。
    const sftpCloses: Promise<unknown>[] = [];
    sftpCleanups.current.forEach((handler, id) => {
      sftpCloses.push(Promise.resolve(handler()).catch(error => console.warn(`关闭 ${id} 的 SFTP 会话失败`, error)));
    });
    sftpCleanups.current.clear();

    // 4) 更新前有等待上限；正常关窗仍等待清理完成，再留 800ms 给状态收尾。
    const closing = Promise.allSettled([...runtimeCloses, ...sftpCloses]);
    if (maximumWaitMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closing, new Promise(resolve => { timer = setTimeout(resolve, maximumWaitMs); })]); }
      finally { clearTimeout(timer); }
    } else await closing;
    await new Promise(resolve => setTimeout(resolve, 800));

    // 5) 清理持久化的页签恢复信息：markManuallyClosed() 已经让 sessions 状态变化，
    //    但 useEffect 不一定在 destroy 之前 flush 完；这里直接清空 localStorage 兜底，
    //    避免下次启动时把已关闭的终端 tab 重新恢复出来。
    try { localStorage.removeItem(terminalSessionsStorageKey(backendUrl)); }
    catch (error) { console.warn('清理终端页签持久化数据失败', error); }
  }, []);

  const prepareForClientUpdate = async () => {
    if (closingApp.current) throw new Error('应用正在关闭，请稍后重试。');
    if (chatBusy || chatStopping || broadcastBusy) throw new Error('请先结束智能体回复或命令提交，再安装更新。');
    if (clientHistoryDirty.current && messagesRef.current.length) {
      if (!selectedAgent?.agentId || !activeChatSessionId) throw new Error('当前对话尚未保存，请先确认历史记录已保存。');
      await persistClientSession(selectedAgent.agentId, activeChatSessionId);
    }
    try { await cleanupBeforeClose(5_000); }
    finally { closingApp.current = false; }
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Tauri v2：先 preventDefault 关掉默认的立刻销毁行为，等清理完再 destroy。
    void getCurrentWindow().onCloseRequested(async event => {
      if (disposed || closingApp.current) {
        // 第二次/卸载后的关闭请求不再拦截，让它走默认行为快速退出。
        return;
      }
      event.preventDefault();
      try { await cleanupBeforeClose(); }
      catch (error) { console.warn('关闭应用前的清理失败', error); }
      if (disposed) return;
      try { await getCurrentWindow().destroy(); }
      catch (error) { console.error('强制销毁主窗口失败', error); }
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.error('监听窗口关闭事件失败', error));
    return () => { disposed = true; unlisten?.(); };
  }, [cleanupBeforeClose]);
  const fill = (command: string) => {
    setNavigation('命令');
    if (commandMode !== 'single') {
      setBroadcastDraft(command);
      broadcastInput.current?.focus();
      return;
    }
    if (!active) { void openNewTerminal(); notify('正在为你打开本地 CMD。'); return; }
    const client = terminalClients.current.get(active.id);
    if (!isSessionConnected(active) || !client || client.sessionId !== active.terminalSessionId || client.closed || client.disconnected || client.transportAvailable === false) {
      notify(active.connectionStatus === 'unreachable' ? '本地工作区暂不可用，请重试读取或重新初始化。' : active.kind === 'local' ? '本地 CMD 已退出，请新建终端。' : '当前终端连接不可用，请点击“重新连接”。'); return;
    }
    void client.write(command).catch(error => notify(error instanceof Error ? error.message : '命令写入失败', 'error'));
  };
  // Human command controls only. Agent keeps its captured single terminalSessionId below.
  const requestRun = async (command: string): Promise<boolean> => {
    if (!command.trim() || broadcastSubmitting.current) return false;
    if (commandMode === 'single' && !active) { void openNewTerminal(); notify('正在为你打开本地 CMD。'); return false; }
    const plan = resolveTerminalCommandTargets(sessionsRef.current, terminalClients.current, commandMode, activeId, commandTargetIds);
    if (!plan.targets.length) { notify(commandMode === 'selected' && !commandTargetIds.length ? '请先勾选目标终端。' : '目标终端不可用或正在提交命令，请检查连接。', 'error'); return false; }
    broadcastSubmitting.current = true; setBroadcastBusy(true); setBroadcastResult('');
    try {
      const results = await submitTerminalCommandBatch(plan.targets, command, running.current, target => {
        const session = sessionsRef.current.find(item => item.id === target.id);
        return !!session && isSessionConnected(session) && session.terminalSessionId === target.runtime.sessionId
          && terminalClients.current.get(target.id) === target.runtime && !target.runtime.closed
          && !target.runtime.disconnected && !target.runtime.manuallyClosed && target.runtime.transportAvailable !== false;
      }, (target, busy) => {
        if (terminalClients.current.get(target.id) !== target.runtime) return;
        setSessions(previous => previous.map(item => item.id === target.id && item.terminalSessionId === target.runtime.sessionId ? { ...item, busy } : item));
      });
      const allResults = [...results, ...plan.skipped];
      const submitted = results.filter(item => item.status === 'submitted').length;
      const unsuccessful = allResults.filter(item => item.status !== 'submitted');
      const message = `已提交 ${submitted} 个终端${unsuccessful.length ? `；${unsuccessful.map(item => `${item.title}：${item.detail}`).join('；')}。未自动重试，请检查各终端输出。` : '，请查看各终端输出。'}`;
      setBroadcastResult(message);
      if (unsuccessful.length) notify(message, 'error', 5_000);
      return submitted > 0 && !unsuccessful.length;
    } finally { broadcastSubmitting.current = false; setBroadcastBusy(false); }
  };
  const navigate = (name: Navigation) => {
    setNavigation('命令');
    if (name === '命令') setConnectionSidebarCollapsed(false);
  };
  const sendMessage = async (text: string, selectedAttachments: ChatAttachment[] = []): Promise<boolean> => {
    if (chatting.current || stopPending.current || historyLoadingId || recoveredRunning || agentLoading || agentLoadError) return false;
    // Fix this turn's references before any session creation or network await.
    const attachments = selectedAttachments.map(file => ({ ...file }));
    if (rustBuiltin && attachments.length) { notify('聊天附件尚未接入，请发送纯文本。', 'error'); return false; }
    const invalid = validateChatContent(text, attachments);
    if (invalid) { notify(invalid, 'error'); return false; }
    const currentSession = active;
    const client = currentSession ? terminalClients.current.get(currentSession.id) : undefined;
    const terminalSessionId = chatSessionId.current && rustBuiltin ? chatTarget.current?.terminalSessionId ?? '' : currentSession?.kind === 'ssh' && isSessionConnected(currentSession)
      && client?.sessionId === currentSession.terminalSessionId
      && !client.closed && !client.disconnected && client.transportAvailable !== false
      ? currentSession.terminalSessionId
      : '';
    if (!selectedAgent) {
      notify(agentLoadError || '智能体尚未加载完成，草稿已保留，请稍后发送。', 'error');
      return false;
    }

    chatting.current = true;
    if (!chatSessionId.current) chatTarget.current = terminalSessionId && currentSession ? {connectionId:currentSession.connectionId,terminalSessionId} : null;
    const version = chatVersion.current;
    const assistantId = crypto.randomUUID();
    chatRequestId.current=assistantId;
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
        if (!created?.sessionId) throw new Error('应用未返回 Agent 会话 ID');
        if (controller.signal.aborted || version !== chatVersion.current) return false;
        chatSessionId.current = created.sessionId;
        setActiveChatSessionId(created.sessionId);
      }
      await agentApi.chatStream({
        requestId:assistantId,
        agentId: selectedAgent.agentId,
        userId: agentApi.userId,
        sessionId: chatSessionId.current,
        terminalSessionId,
        message: text,
        ...(attachments.length ? { attachments: attachmentReferences(attachments) } : {}),
      }, receive, controller.signal);
      if (controller.signal.aborted || stopPending.current || version !== chatVersion.current) return false;
      updateAssistant(message => message.text ? message : appendText(message, '回复已完成。'));
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
      if(chatRequestId.current===assistantId)chatRequestId.current='';
      if (version === chatVersion.current) {
        const sessionId = chatSessionId.current;
        try {
          await persistClientSession(selectedAgent.agentId, sessionId);
        } catch (persistError) {
          console.warn('客户端对话历史最终保存失败', persistError);
          if (version === chatVersion.current) notify('客户端历史保存失败，当前消息仍保留在页面中。', 'error');
        }
        if (version === chatVersion.current) {
          if (rustBuiltin && sessionId) {
            try {
              const history = await readAgentHistory(after => agentApi.history(selectedAgent.agentId, sessionId, after));
              if (version === chatVersion.current) { setCanonicalHistory(history); chatTarget.current = history.session.task?.target ?? null; replaceMessages(turnMessages(history.turns)); }
            } catch (e) { if (version === chatVersion.current) notify(e instanceof Error ? e.message : '重读持久历史失败', 'error'); }
          }
          if (version === chatVersion.current) await refreshChatSessions(selectedAgent.agentId);
        }
      }
      if (version === chatVersion.current) {
        chatting.current = false;
        setChatBusy(false);
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
    const requestId=chatRequestId.current;
    if (agentId && sessionId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      // 请求服务端先取消正在执行的任务；等待确认期间忽略后续流事件，
      // 最终再断开本地流。断连回调同时作为服务端取消的兜底。
      void agentApi.stopChat(agentId, sessionId, controller.signal, requestId||undefined)
        .catch(error => {
          console.warn('服务端停止请求未确认', error);
          notify('已停止显示，但任务停止尚未确认；请检查执行状态。', 'error');
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
  const stopRecoveredChat = async () => {
    if (stopPending.current || chatting.current || historyLoadingId || !selectedAgent) return;
    const turn = canonicalHistory?.turns.find(item => item.state === 'running');
    const sessionId = activeChatSessionId;
    if (!turn || !sessionId) return;
    // Capture this exact turn before awaiting; a later session selection must not redirect the stop.
    const agentId = selectedAgent.agentId;
    const version = chatVersion.current;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    stopPending.current = true;
    setChatStopping(true);
    try {
      await agentApi.stopChat(agentId, sessionId, controller.signal, turn.requestId);
    } catch (error) {
      if (version === chatVersion.current) {
        notify(error instanceof Error ? error.message : '停止尚未确认，请刷新历史查看状态。', 'error');
      }
    } finally {
      clearTimeout(timeout);
      stopPending.current = false;
      setChatStopping(false);
    }
    // A false stop receipt may mean completion won the race. SQLite decides the displayed state.
    if (version === chatVersion.current) await selectChatSession(sessionId);
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
    chatTarget.current = null;
    setCanonicalHistory(null);
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
      const nativeHistory = rustBuiltin ? await readAgentHistory(after => agentApi.history(selectedAgent.agentId, sessionId, after)) : null;
      const history = nativeHistory ? turnMessages(nativeHistory.turns) : await loadClientChatSession({
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
      setCanonicalHistory(nativeHistory);
      chatTarget.current = nativeHistory?.session.task?.target ?? null;
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
    if (!rustBuiltin || !recoveredRunning || !selectedAgent || !activeChatSessionId || chatBusy) return;
    let cancelled = false;
    const version = chatVersion.current;
    const timer = setTimeout(() => {
      void readAgentHistory(after => agentApi.history(selectedAgent.agentId, activeChatSessionId, after))
        .then(history => { if (!cancelled && version === chatVersion.current) { setCanonicalHistory(history); replaceMessages(turnMessages(history.turns)); } })
        .catch(() => { /* Manual refresh remains available after a transient failure. */ });
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rustBuiltin, recoveredRunning, canonicalHistory, selectedAgent, activeChatSessionId, chatBusy, replaceMessages]);

  useEffect(() => {
    setSessions(previous => previous.map(session => {
      const configured = hosts.find(item => item.id === session.connectionId);
      return configured && (session.title !== configured.name || session.host !== configured)
        ? { ...session, title: configured.name, host: configured }
        : session;
    }));
  }, [hosts]);

  useEffect(() => {
    // 连接列表加载完成后再校验，先让上面的清理逻辑排除当前数据库中已经不存在的连接。
    if (!connections.loaded || restoredSessionsVerified.current) return;
    restoredSessionsVerified.current = true;
    const configuredConnectionIds = new Set(hosts.map(item => item.id));
    sessions.forEach(session => {
      if (session.kind === 'ssh'
        && configuredConnectionIds.has(session.connectionId)
        && session.terminalSessionId) {
        void verifyTerminalSession(session.id, session.terminalSessionId);
      }
    });
  }, [connections.loaded, hosts, sessions, verifyTerminalSession]);

  useEffect(() => {
    const verifyAfterNetworkRestore = () => {
      sessions.forEach(session => {
        if (session.kind === 'ssh' && session.terminalSessionId && !session.manuallyClosed) {
          void verifyTerminalSession(session.id, session.terminalSessionId);
        }
      });
    };
    window.addEventListener('online', verifyAfterNetworkRestore);
    return () => window.removeEventListener('online', verifyAfterNetworkRestore);
  }, [sessions, verifyTerminalSession]);

  return <div style={{ '--agent-width': `${agentWidth}%`, '--command-width': `${commandWidth}px`, '--connection-sidebar-width': `${connectionSidebarWidth}px` } as CSSProperties} className={`app-shell ${agentCollapsed ? 'agent-collapsed' : ''} ${navCollapsed ? 'nav-collapsed' : ''} ${connectionSidebarCollapsed ? 'host-sidebar-collapsed' : ''} ${navigation === '连接' ? 'connections-view' : 'terminal-view'} ${backendSettingsOpen ? 'settings-view' : ''}`}>
    <AppHeader notify={notify} theme={theme} setTheme={setTheme} onUpload={() => setUploadOpen(true)} />
    <ActivityBar active={navigation} onSelect={name => { setBackendSettingsOpen(false); clearUpdateSettingsRequest(); navigate(name); }} onSettings={() => { setModelSettingsRequested(false); clearUpdateSettingsRequest(); setBackendSettingsOpen(value => !value); }} settingsOpen={backendSettingsOpen} collapsed={navCollapsed} toggleCollapsed={() => setNavCollapsed(value => !value)} />
    {backendSettingsOpen && <BackendSettingsDialog currentUrl={backendUrl}
      modelsChanged={() => setAgentLoadAttempt(value => value + 1)} modelSettingsRequested={modelSettingsRequested}
      modelSettingsLocked={chatBusy || chatStopping || recoveredRunning}
      onClose={() => { setModelSettingsRequested(false); setBackendSettingsOpen(false); clearUpdateSettingsRequest(); }}
      showUpdates={updateSettingsRequested}
      beforeClientUpdate={prepareForClientUpdate}
      onSave={onBackendChange} />}
    <ConnectionSidebar connections={{ ...connections, remove: removeHost }} sessions={sessions} connectingHostIds={connectingHostIds} activeHostId={active?.kind === 'ssh' ? active.connectionId : undefined} activeSessionId={activeId} terminal={selectHost} cancelConnection={cancelHostConnection} activate={activateTerminalFromSidebar} create={openNewConnection} collapsed={connectionSidebarCollapsed} toggleCollapsed={() => setConnectionSidebarCollapsed(value => !value)} />
    <PanelDivider value={connectionSidebarWidth} change={setConnectionSidebarWidth} side="left" unit="pixels"
      min={194} max={360} defaultValue={window.innerWidth <= 1280 ? 194 : 224} reservePixels={364}
      reserveWidthSelectors=".activity-bar, .agent-panel" className="connection-panel-divider" label="调整连接管理宽度"
      controls="connection-sidebar-content" collapseLabel="连接管理" collapsed={connectionSidebarCollapsed}
      collapse={() => setConnectionSidebarCollapsed(true)} />
    <main hidden={navigation !== '命令'} className={`central-workspace ${!active ? 'no-session' : ''} ${commandCollapsed ? 'command-collapsed' : ''}`}>
      <TerminalWorkspace
        commandControls={<TerminalCommandBar mode={commandMode} changeMode={mode => {
          setCommandMode(mode); setBroadcastResult('');
          if (mode === 'selected' && commandMode === 'single' && activeId) setCommandTargetIds(previous => previous.length ? previous : [activeId]);
        }} sessions={sessions.map(session => ({ id: session.id, title: session.title, address: session.kind === 'local' ? '本地 CMD' : session.host.address,
          available: canSubmitTerminalCommand(session, terminalClients.current.get(session.id)) }))}
          selectedIds={commandTargetIds} toggleTarget={id => setCommandTargetIds(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id])}
          targetCount={commandPlan.targets.length} draft={broadcastDraft} changeDraft={setBroadcastDraft} inputRef={broadcastInput}
          busy={broadcastBusy} result={broadcastResult} submit={() => {
            const draft = broadcastDraft;
            void requestRun(draft).then(success => { if (success) setBroadcastDraft(current => current === draft ? '' : current); });
          }} />}
        layout={terminalLayout}
        visibleIds={visibleIds}
        changeLayout={layout => {
          setTerminalPanes(visibleTerminalIds(sessions.map(session => session.id), activeId, layout, [activeId, ...visibleIds]));
          setTerminalLayout(layout);
        }}
        reorder={(draggedId, targetId, after) => setSessions(previous => reorderTerminalSessions(previous, draggedId, targetId, after))}
        remoteViews={sessions.map(session => {
          const runtime = terminalClients.current.get(session.id);
          const visible = visibleIds.includes(session.id);
          return <section key={session.id} className="terminal-session-pane" hidden={!visible}
            data-active={session.id === activeId} data-pane-index={visibleIds.indexOf(session.id)} style={{ order: visibleIds.indexOf(session.id) }}
            aria-label={session.title} onPointerDownCapture={() => { if (session.id !== activeId) selectTerminalTab(session.id); }}
            onFocusCapture={() => { if (session.id !== activeId) selectTerminalTab(session.id); }}>
            <div className="terminal-split-heading" hidden={terminalLayout === 'single'}>
              <div className="terminal-split-selector"><span>{session.id === activeId ? '当前终端' : '对比终端'}</span>
                <Select label={`选择窗格 ${visibleIds.indexOf(session.id) + 1} 的终端`} className="terminal-pane-select" value={session.id} onChange={id => {
                  selectTerminalTab(id, replaceTerminalPane(visibleIds, session.id, id));
                }} options={sessions.map((item, index) => ({ value: item.id, label: `${item.title} · ${item.kind === 'local' ? '本地' : item.host.address} · ${index + 1}` }))} />
              </div>
              <button type="button" title="只显示此终端" onClick={() => { selectTerminalTab(session.id); setTerminalLayout('single'); }}>单窗口</button>
            </div>
            <Suspense fallback={visible ? <p>正在加载终端…</p> : null}>
            <RemoteTerminalView key={runtime?.sessionId ?? `${session.id}:disconnected`} runtime={runtime} visible={visible && navigation === '命令'} focused={session.id === activeId}
              local={session.kind === 'local'}
              canAddToAgent={!chatBusy && !chatStopping && !historyLoadingId && !recoveredRunning}
              addToAgent={text => {
                const added = agentComposer.current?.addText(text, 'terminal') ?? false;
                setAgentCollapsed(false);
                return added;
              }}
              connected={session.connected && !!runtime && runtime.sessionId === session.terminalSessionId}
              transportAvailable={session.connectionStatus !== 'unreachable'}
              disconnectReason={session.disconnectReason}
              reconnectAllowed={session.reconnectAllowed}
              reconnectAttempts={session.reconnectAttempts}
              reconnecting={session.reconnecting}
              manuallyClosed={session.manuallyClosed}
              onDisconnected={event => handleTerminalDisconnected(session.id, event, runtime)}
              onTransportChange={available => handleTerminalTransport(session.id, available, runtime)}
              onReconnectExhausted={attempts => handleReconnectExhausted(session.id, attempts, runtime)}
              reconnect={options => reconnectTerminal(session.id, options, runtime)}
              cancelReconnect={() => cancelTerminalReconnect(session.id)}
              disconnect={() => closeSession(session.id)} />
            </Suspense>
          </section>;
        })}
        connections={() => navigate('连接')}
        sessions={sessions}
        activeId={activeId}
        host={host}
        select={selectTerminalTab}
        close={closeSession}
        add={openNewTerminal}
        copy={copy}
        filesAvailable agentAvailable
        filesOpen={active?.kind === 'ssh' && visibleFiles === active.connectionId}
        toggleFiles={() => { if (active?.kind === 'ssh') { if (visibleFiles === active.connectionId) setVisibleFiles(''); else openFiles(active.connectionId, active.title); } }}
        commandCollapsed={commandCollapsed}
        toggleCommands={() => setCommandCollapsed(value => !value)}
        agentCollapsed={agentCollapsed}
        toggleAgent={() => setAgentCollapsed(value => !value)}
      />
      <CommandShelf commands={commands} category={category} setCategory={setCategory} fill={fill} run={command => { void requestRun(command); }} copy={copy} add={() => setDialog('command')}
        disabled={broadcastBusy || (commandMode === 'single' ? !canRun : !commandPlan.targets.length)} collapsed={commandCollapsed} broadcast={commandMode !== 'single'}
        resize={<PanelDivider value={commandWidth} change={setCommandWidth} unit="pixels" min={220} max={450} defaultValue={260}
          reservePixels={280} containerSelector=".central-workspace" className="command-panel-divider" label="调整常用命令宽度"
          controls="command-shelf-content" collapseLabel="常用命令" collapsed={commandCollapsed} collapse={() => setCommandCollapsed(true)} />} />
    </main>
    <>
    <PanelDivider value={agentWidth} change={setAgentWidth} minPixels={300} reservePixels={360} reserveSelector=".central-workspace"
      controls="agent-panel-content" collapsed={agentCollapsed} collapse={() => setAgentCollapsed(true)} />
    <AgentPanel ref={agentComposer} chatDraft={chatDraft} draftScope={chatVersion.current} host={activeChatSessionId ? hosts.find(h => h.id === chatTarget.current?.connectionId) : host} connected={active?.kind === 'ssh' && isSessionConnected(active)} localTerminal={!activeChatSessionId && active?.kind === 'local'} messages={messages} busy={chatBusy} stopping={chatStopping} send={sendMessage} stop={stopChat} collapsed={agentCollapsed}
      clear={clearChat} disabled={Boolean(historyLoadingId) || chatStopping || recoveredRunning}
      models={rustBuiltin ? agentModels : undefined} selectedModel={selectedAgent?.agentId}
      selectModel={id => { if (!chatting.current && !stopPending.current) setSelectedAgent(agentModels.find(model => model.agentId === id) ?? null); }}
      openModelSettings={() => { setModelSettingsRequested(true); setBackendSettingsOpen(true); }}
      recoveredRunning={recoveredRunning} refreshCurrent={() => { if (activeChatSessionId) void selectChatSession(activeChatSessionId); }}
      stopRecovered={stopRecoveredChat}
      agentAvailability={{ ready: !!selectedAgent && !agentLoading && !agentLoadError, loading: agentLoading, error: agentLoadError, retry: () => setAgentLoadAttempt(attempt => attempt + 1) }}
      history={{
        sessions: chatSessions, activeSessionId: activeChatSessionId, open: historyOpen,
        loading: historyLoading, loadingSessionId: historyLoadingId, error: historyError,
        toggle: () => {
          if (!historyOpen && selectedAgent) void refreshChatSessions(selectedAgent.agentId);
          setHistoryOpen(value => !value);
        },
        refresh: () => { if (selectedAgent) void refreshChatSessions(selectedAgent.agentId); },
        select: sessionId => { void selectChatSession(sessionId); },
        more: historyMore ? () => { if (selectedAgent) void refreshChatSessions(selectedAgent.agentId, historyMore); } : undefined,
      }} />
    </>
    {fileWindows.map(item => <SessionFiles key={item.connectionId} connectionId={item.connectionId} title={item.title} visible={!backendSettingsOpen && visibleFiles === item.connectionId} minimize={() => setVisibleFiles('')} remove={() => { setFileWindows(previous => previous.filter(window => window.connectionId !== item.connectionId)); setVisibleFiles(current => current === item.connectionId ? '' : current); }} copy={copy} notify={notify} registerAppCloseCleanup={registerAppCloseCleanup} />)}
    {toast && <NotificationToast key={toast.id} notice={toast} close={dismissNotice} />}
    {uploadOpen && <FileUploadDialog queue={uploadQueue} close={() => setUploadOpen(false)} />}
    {dialog === 'command' && <AddCommandDialog close={closeDialog} categories={[...new Set(commands.map(command => command.category))]} save={async command => {
      const next = [...commands, command];
      await saveClientCommands(next);
      setCommands(next);
      setCategory(command.category);
      closeDialog();
      notify('命令已保存到客户端', 'success');
    }} />}
    {dialog === 'connection' && <SshConnectionDialog connections={connections} connectAfterSave={connectAfterSave} onClose={closeDialog} onSaved={saved => { if (connectAfterSave) void selectHost(saved.id, saved); else notify('SSH 连接已保存。', 'success'); }} />}
    {disconnectTarget && <DisconnectDialog key={disconnectTarget.tabId} host={hosts.find(item => item.id === disconnectTarget.host.id) ?? disconnectTarget.host} connected={sessions.find(session => session.id === disconnectTarget.tabId)?.connected === true} busy={false} error={terminalError} close={() => setDisconnectTarget(null)} confirm={confirmDisconnect} />}
  </div>;
}

export default function App() {
  const desktop = isTauriRuntime();
  const { theme, setTheme } = useTheme();
  useApplyClientAppearance();
  useApplyClientTextColors();
  useApplyClientTypography();
  const [backendUrl, setBackendUrl] = useState(readBackendUrl);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [updateSettingsRequested, setUpdateSettingsRequested] = useState(false);
  const [backendReady, setBackendReady] = useState(() => !desktop);
  const [startupBypassed, setStartupBypassed] = useState(false);
  const [startupPhase, setStartupPhase] = useState<StartupPhase>(desktop ? 'checking' : 'ready');
  const [startupMessage, setStartupMessage] = useState('正在读取工作区状态…');
  const [startupLogDirectory, setStartupLogDirectory] = useState<string | null>(null);
  const [startupRetrying, setStartupRetrying] = useState(false);
  /** 初始查询、事件和重启命令可能交错返回，只处理本次运行中的较新状态。 */
  const startupStatusRevision = useRef(-1);
  /**
   * stopped 状态时（用户关掉了自动启动），这个标志让“启动”按钮显示“正在启动”并禁用。
   * 只用于本地启动流程，restart 调用发起后置 true，状态切到 starting/running 时置 false。
   */
  const [startupStarting, setStartupStarting] = useState(false);
  const [startupHealth, setStartupHealth] = useState<StartupHealth>({
    state: 'idle',
    backendUrl: readBackendUrl(),
    latencyMs: null,
    message: null,
    checkedAt: null,
  });
  const startupHealthAbort = useRef<AbortController | null>(null);
  const readyTimer = useRef<number | null>(null);
  const changeBackend = (url: string) => {
    setBackendUrl(saveBackendUrl(url));
    // 重新初始化工作区时重建界面并取消旧实例请求。
    setConnectionRevision(previous => previous + 1);
  };
  /** 主界面和所有 API 模块绑定同一个应用内工作区实例。 */
  const syncBundledBackendUrl = useCallback((actual: string | null | undefined) => {
    const selected = adoptBundledBackendUrl(actual);
    setBackendUrl(selected);
    return selected;
  }, []);

  useLayoutEffect(() => {
    if (!desktop) return;
    /*
     * 主窗口由 Tauri 以 hidden 状态创建。React 完成首次提交后再显示，
     * 避免用户看到 WebView 初始化期间的空内容或“没有数据”中间态。
     */
    void getCurrentWindow().show().catch(error => {
      console.error('显示主窗口失败', error);
    });
  }, [desktop]);

  const revealMain = useCallback((message: string) => {
    setStartupPhase('ready');
    setStartupMessage(message || '本地工作区已就绪');
    if (readyTimer.current !== null) window.clearTimeout(readyTimer.current);
    readyTimer.current = window.setTimeout(() => setBackendReady(true), 320);
  }, []);

  /**
   * 用 /api/health 探测一次，结果只用于启动页状态展示。
   * - 不影响 phase 流转：phase 仍由内置进程状态快照/事件决定。
   * - 不阻塞用户点击“继续进入”：health down 也允许继续（业务后端已能响应）。
   */
  const runStartupHealthProbe = useCallback(async (targetUrl: string) => {
    startupHealthAbort.current?.abort();
    const controller = new AbortController();
    startupHealthAbort.current = controller;
    setStartupHealth(previous => ({ ...previous, state: 'probing', backendUrl: targetUrl, message: null }));
    try {
      const snapshot = await probeBackendHealth({ backendUrl: targetUrl, signal: controller.signal, timeoutMs: 3000 });
      if (controller.signal.aborted) return;
      setStartupHealth({
        state: snapshot.ok ? 'up' : 'down',
        backendUrl: snapshot.backendUrl,
        latencyMs: snapshot.latencyMs,
        message: snapshot.message,
        checkedAt: snapshot.checkedAt,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setStartupHealth(previous => ({
        ...previous,
        state: 'error',
        backendUrl: targetUrl,
        message: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      if (startupHealthAbort.current === controller) startupHealthAbort.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (readyTimer.current !== null) window.clearTimeout(readyTimer.current);
    startupHealthAbort.current?.abort();
  }, []);

  /** 所有启动状态入口共用处理函数，重复事件/命令返回不重复健康探测或重置进入计时。 */
  const applyStartupStatus = useCallback((status: BundledBackendStatus | null) => {
    if (status) {
      if (status.revision <= startupStatusRevision.current) return;
      startupStatusRevision.current = status.revision;
    }
    if (!status || status.status === 'running') {
      setStartupStarting(false);
      // 工作区状态与业务就绪状态分别检查；本地健康检查通过 IPC。
      void runStartupHealthProbe(syncBundledBackendUrl(status?.backendUrl));
      revealMain(status?.message ?? '客户端界面已就绪');
      return;
    }
    // running 后的短暂进入动画期间若进程退出，取消进入计时，不能带失败状态进入工作区。
    if (readyTimer.current !== null) {
      window.clearTimeout(readyTimer.current);
      readyTimer.current = null;
    }
    setStartupLogDirectory(status.status === 'failed' ? parentDirectory(status.logPath) : null);
    if (status.status === 'failed' || status.status === 'stopped') {
      setStartupStarting(false);
      setStartupPhase(status.status);
      setStartupMessage(status.message || (status.status === 'failed' ? '本地工作区初始化失败' : '本地工作区尚未初始化'));
      return;
    }
    setStartupPhase('starting');
    setStartupMessage(status.message || '正在等待本地工作区初始化…');
  }, [revealMain, runStartupHealthProbe, syncBundledBackendUrl]);

  useEffect(() => {
    if (!desktop) return;
    // 注册监听后只查一次快照；持续的 starting/running/failed/stopped 由 Rust 推送。
    return watchBundledBackendStatus(status => {
      if (backendReady || startupBypassed) {
        if (status?.status === 'running') syncBundledBackendUrl(status.backendUrl);
        return;
      }
      applyStartupStatus(status);
    }, error => {
      if (backendReady || startupBypassed) return;
      setStartupPhase('failed');
      setStartupMessage(`无法读取本地工作区状态：${errorMessage(error)}`);
      setStartupLogDirectory(null);
    });
  }, [backendReady, desktop, startupBypassed, applyStartupStatus, syncBundledBackendUrl]);

  const retryStartup = useCallback(async () => {
    setStartupRetrying(true);
    setStartupPhase('starting');
    setStartupMessage('正在重新初始化本地工作区…');
    setStartupLogDirectory(null);
    try {
      const status = await restartBundledBackend();
      applyStartupStatus(status);
    } catch (error) {
      setStartupStarting(false);
      setStartupPhase('failed');
      setStartupMessage(`重新启动失败：${errorMessage(error)}`);
    } finally {
      setStartupRetrying(false);
    }
  }, [applyStartupStatus]);

  /**
   * stopped 状态下点“启动”按钮。逻辑与重试一致，但需要重置 starting 标志位，
   * 让 UI 切换到“正在启动”文案，并提示用户不要重复点击。
   */
  const startManually = useCallback(async () => {
    setStartupStarting(true);
    setStartupPhase('starting');
    setStartupMessage('正在初始化本地工作区…');
    setStartupLogDirectory(null);
    // 把健康检查状态也复位，避免“启动中”时还显示旧的 down 徽章。
    const targetUrl = readBackendUrl();
    setStartupHealth({ state: 'idle', backendUrl: targetUrl, latencyMs: null, message: null, checkedAt: null });
    try {
      const status = await restartBundledBackend();
      applyStartupStatus(status);
    } catch (error) {
      setStartupStarting(false);
      setStartupPhase('failed');
      setStartupMessage(`启动失败：${errorMessage(error)}`);
    }
  }, [applyStartupStatus]);

  const recheckStartupHealth = useCallback(() => {
    const target = startupHealth.backendUrl || readBackendUrl();
    if (target) void runStartupHealthProbe(target);
  }, [runStartupHealthProbe, startupHealth.backendUrl]);

  const waitingForBackend = desktop && !backendReady && !startupBypassed;
  const page = waitingForBackend && !updateSettingsRequested ? <StartupScreen
      phase={startupPhase}
      message={startupMessage}
      logDirectory={startupLogDirectory}
      retrying={startupRetrying}
      onRetry={() => { void retryStartup(); }}
      onContinue={() => setStartupBypassed(true)}
      onStart={() => { void startManually(); }}
      starting={startupStarting}
      health={startupHealth}
      onRecheckHealth={recheckStartupHealth}
    /> : !backendUrl || waitingForBackend ? <BackendSettingsDialog currentUrl={backendUrl}
      required={!backendUrl} showUpdates={updateSettingsRequested}
      onClose={() => setUpdateSettingsRequested(false)} onSave={changeBackend} />
    : <AppContent key={`${backendUrl}:${connectionRevision}`} backendUrl={backendUrl} onBackendChange={changeBackend}
      theme={theme} setTheme={setTheme} updateSettingsRequested={updateSettingsRequested}
      clearUpdateSettingsRequest={() => setUpdateSettingsRequested(false)} />;
  return <>{page}<StartupUpdatePrompt onViewUpdate={() => setUpdateSettingsRequested(true)} /></>;
}

function parentDirectory(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/[\\/]+$/, '');
  const separator = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return separator > 0 ? normalized.slice(0, separator) : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
