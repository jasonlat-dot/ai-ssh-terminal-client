import { terminalApi } from '../api/terminal';
import type { TerminalConnectionState, TerminalOpen, TerminalReadResult } from '../api/terminal';
import { SshRequestError } from '../api/ssh';
import type { TerminalDisconnectReason } from '../types';
import type { TerminalRuntime } from './terminalRuntime';
import { requireBackendUrl } from '../config/backend';

const READ_RETRY_DELAYS = [1_000, 3_000, 5_000, 10_000] as const;

export type TerminalDisconnectEvent = {
  reason: TerminalDisconnectReason | null;
  reconnectAllowed: boolean;
  message: string;
};

export function terminalDisconnectMessage(reason: TerminalDisconnectReason | null, reconnectAllowed: boolean) {
  switch (reason) {
    case 'IDLE_TIMEOUT': return '终端因长时间未操作已断开。';
    case 'CLIENT_CLOSED': return '终端连接已关闭。';
    case 'SESSION_NOT_FOUND': return '终端会话已失效。';
    case 'READER_ERROR': return reconnectAllowed ? '终端读取异常，正在尝试自动重连。' : '终端读取异常。';
    case 'CHANNEL_DISCONNECTED': return reconnectAllowed ? 'SSH Channel 已断开，正在尝试自动重连。' : 'SSH Channel 已断开。';
    default: return reconnectAllowed ? '终端连接已断开，正在尝试自动重连。' : '终端连接已断开。';
  }
}

// IPC output retries only resubscribe to the existing SSH shell.
export class RemoteTerminal implements TerminalRuntime {
  readonly sessionId: string;
  readonly connectionId: string;
  /** 终端绑定创建时的工作区实例，重新初始化后旧 sessionId 不能操作新实例。 */
  private readonly backendUrl: string;
  closed = false;
  disconnected = false;
  manuallyClosed = false;
  disconnectReason: TerminalDisconnectReason | null = null;
  reconnectAllowed = false;
  transportAvailable = true;
  private closing = false;
  private paused: boolean;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private output?: (data: string) => void | Promise<void>;
  private report?: (error: string) => void;
  private reportDisconnect?: (event: TerminalDisconnectEvent) => void;
  private reportTransport?: (available: boolean) => void;
  private backlog: string;
  private generation = 0;
  private lifecycleVersion = 0;
  private lastSize = '';
  private readFailureCount = 0;
  private nativeStop?: () => void;

  constructor(opened: TerminalOpen, startPaused = false, backendUrl = requireBackendUrl()) {
    this.sessionId = opened.sessionId;
    this.connectionId = opened.connectionId;
    this.backendUrl = backendUrl;
    this.backlog = opened.initialOutput || '';
    this.paused = startPaused;
    if (this.isDisconnectOutput(this.backlog)) {
      this.disconnected = true;
      this.disconnectReason = 'CHANNEL_DISCONNECTED';
    }
  }

  get readLoopGeneration() { return this.generation; }

  setForeground(_foreground: boolean) {
    // 保留 TerminalRuntime 的统一接口；各终端独立读取，不再按前后台排队。
  }

  private isDisconnectOutput(data: string) {
    return data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes('[连接已断开]');
  }

  private isActive(generation: number) {
    return generation === this.generation && !!this.output && !this.closed && !this.closing
      && !this.paused && !this.disconnected && !this.manuallyClosed;
  }

  private stopReadLoop() {
    this.generation += 1;
    this.lifecycleVersion += 1;
    clearTimeout(this.timer);
    this.nativeStop?.();
    this.nativeStop = undefined;
  }

  private markDisconnected(reason: TerminalDisconnectReason | null, reconnectAllowed: boolean, message = terminalDisconnectMessage(reason, reconnectAllowed)) {
    if (this.manuallyClosed) return;
    const changed = !this.disconnected || this.disconnectReason !== reason || this.reconnectAllowed !== reconnectAllowed;
    this.disconnected = true;
    this.paused = true;
    this.disconnectReason = reason;
    this.reconnectAllowed = reconnectAllowed === true;
    this.stopReadLoop();
    if (changed) this.reportDisconnect?.({ reason, reconnectAllowed: this.reconnectAllowed, message });
  }

  private emit(data: string) {
    if (!data) return;
    const rendered = this.output ? this.output(data) : undefined;
    if (!this.output) this.backlog += data;
    // Compatibility guard for older backends; it never opts into automatic reconnect.
    if (this.isDisconnectOutput(data)) this.markDisconnected('CHANNEL_DISCONNECTED', false);
    return rendered;
  }

  private setTransportAvailable(available: boolean) {
    if (this.transportAvailable === available) return;
    this.transportAvailable = available;
    this.reportTransport?.(available);
  }

  private reportRequestFailure(error: unknown) {
    // A business error can still come from a reachable backend.
    if (error instanceof SshRequestError && error.kind !== 'application') this.setTransportAvailable(false);
  }

  private enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(action);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async request<T>(action: () => Promise<T>): Promise<T> {
    const version = this.lifecycleVersion;
    try {
      return await action();
    } catch (error) {
      if (version === this.lifecycleVersion && !this.closed && !this.manuallyClosed) this.reportRequestFailure(error);
      throw error;
    }
  }

  subscribe(output: (data: string) => void | Promise<void>, report: (error: string) => void, reportDisconnect?: (event: TerminalDisconnectEvent) => void, reportTransport?: (available: boolean) => void) {
    this.output = output;
    this.report = report;
    this.reportDisconnect = reportDisconnect;
    this.reportTransport = reportTransport;
    // Only an actual response can confirm recovery; subscription is not a health check.
    if (!this.transportAvailable) reportTransport?.(false);
    if (this.backlog) { output(this.backlog); this.backlog = ''; }
    const generation = ++this.generation;
    if (this.disconnected) {
      reportDisconnect?.({ reason: this.disconnectReason, reconnectAllowed: this.reconnectAllowed,
        message: terminalDisconnectMessage(this.disconnectReason, this.reconnectAllowed) });
    } else if (!this.paused) {
      this.schedule(0, generation);
    }
    return () => {
      // A newer subscriber owns its own read loop and callbacks.
      if (this.output !== output) return;
      this.stopReadLoop();
      this.output = undefined;
      this.report = undefined;
      this.reportDisconnect = undefined;
      this.reportTransport = undefined;
    };
  }

  private schedule(delay = 0, generation = this.generation) {
    clearTimeout(this.timer);
    if (!this.isActive(generation)) return;
    this.timer = setTimeout(() => {
      this.startNativeStream(generation);
    }, delay);
  }

  private receiveResult(result: TerminalReadResult) {
    const data = result.output || '';
    let rendered: void | Promise<void> = undefined;
    switch (result.status) {
      case 'DATA':
        if (result.hasData || data) rendered = this.emit(data);
        if (result.bufferOverflow) console.warn('Terminal 输出过快，部分旧数据已丢弃');
        break;
      case 'TIMEOUT':
        break;
      case 'REPLACED':
        console.info(`忽略被替换的 Terminal Long Poll sessionId=${this.sessionId} generation=${this.generation}`);
        break;
      case 'DISCONNECTED':
        this.markDisconnected(result.disconnectReason, result.reconnectAllowed === true);
        break;
      case 'READER_ERROR':
        this.markDisconnected(result.disconnectReason ?? 'READER_ERROR', result.reconnectAllowed === true);
        break;
      default:
        throw new Error(`未知的终端读取状态：${String(result.status)}`);
    }
    return rendered;
  }
  private startNativeStream(generation: number) {
    if (!this.isActive(generation) || this.nativeStop) return;
    this.nativeStop = terminalApi.subscribe(this.sessionId, this.backendUrl, result => {
      if (!this.isActive(generation)) return;
      this.readFailureCount = 0;
      const rendered = this.receiveResult(result);
      this.setTransportAvailable(true);
      return rendered;
    }, error => {
      if (!this.isActive(generation)) return;
      this.nativeStop?.(); this.nativeStop = undefined;
      this.setTransportAvailable(false);
      this.readFailureCount += 1;
      const delay = READ_RETRY_DELAYS[Math.min(this.readFailureCount - 1, READ_RETRY_DELAYS.length - 1)];
      this.report?.(`${error.message}；保留当前会话，稍后重试输出订阅。`);
      this.schedule(delay,generation);
    });
  }

  resume() {
    if (this.disconnected || this.manuallyClosed) return;
    this.paused = false;
    this.report?.('');
    this.schedule();
  }

  async verifyConnected(): Promise<TerminalConnectionState> {
    if (this.closed || this.closing || this.manuallyClosed) {
      return { sessionId: this.sessionId, connectionId: this.connectionId, connected: false,
        disconnectReason: 'CLIENT_CLOSED', reconnectAllowed: false };
    }
    const version = this.lifecycleVersion;
    let state: TerminalConnectionState;
    try {
      state = await terminalApi.connected(this.sessionId, this.backendUrl);
    } catch (error) {
      if (version === this.lifecycleVersion && !this.manuallyClosed) this.reportRequestFailure(error);
      throw error;
    }
    if (version !== this.lifecycleVersion || this.manuallyClosed) {
      throw new DOMException('终端状态查询已取消', 'AbortError');
    }
    const connected = state.connected === true && state.sessionId === this.sessionId && state.connectionId === this.connectionId;
    this.setTransportAvailable(true);
    if (!connected) {
      const reason = state.disconnectReason ?? 'SESSION_NOT_FOUND';
      this.markDisconnected(reason, state.reconnectAllowed === true);
      return { ...state, connected: false, disconnectReason: reason };
    }
    this.disconnected = false;
    this.disconnectReason = null;
    this.reconnectAllowed = false;
    this.paused = false;
    this.report?.('');
    this.schedule();
    return state;
  }

  prepareReconnect(manual = false) {
    if (manual) { this.manuallyClosed = false; this.closed = false; }
    this.disconnected = true;
    this.paused = true;
    this.stopReadLoop();
  }

  markManuallyClosed() {
    this.manuallyClosed = true;
    this.reconnectAllowed = false;
    this.disconnectReason = 'CLIENT_CLOSED';
    this.disconnected = true;
    this.paused = true;
    this.stopReadLoop();
  }

  private assertWritable() {
    if (this.closed || this.closing || this.manuallyClosed) throw new Error('终端会话已关闭，请重新连接。');
    if (this.disconnected) throw new Error('终端连接已断开，请先重新连接。');
    if (!this.transportAvailable) throw new Error('本地工作区暂不可用，请重试读取或重新初始化。');
    if (this.paused) throw new Error('终端读取已暂停，请先重试读取。');
  }

  exec(command: string) {
    return this.enqueueWrite(async () => { this.assertWritable(); await this.request(() => terminalApi.write(this.sessionId, `${command}\r`, this.backendUrl)); });
  }

  write(input: string) {
    return this.enqueueWrite(async () => { this.assertWritable(); await this.request(() => terminalApi.write(this.sessionId, input, this.backendUrl)); });
  }

  resources(signal: AbortSignal) {
    // Monitoring failures must not alter the interactive terminal's connection state.
    return terminalApi.resources(this.sessionId, signal, this.backendUrl);
  }
  async resize(cols: number, rows: number) {
    if (this.closed || this.closing || this.paused || this.disconnected || this.manuallyClosed || !this.transportAvailable) return;
    const size = `${cols}:${rows}`;
    if (size === this.lastSize) return;
    await this.request(() => terminalApi.resize(this.sessionId, cols, rows, this.backendUrl));
    this.lastSize = size;
  }

  async close() {
    if (this.closed) return;
    this.markManuallyClosed();
    this.closing = true;
    try {
      await terminalApi.close(this.sessionId, undefined, this.backendUrl);
      this.report?.('终端会话已关闭。');
    } finally {
      this.closed = true;
      this.closing = false;
    }
  }
}
