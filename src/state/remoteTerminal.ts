import { terminalApi } from '../api/terminal';
import type { TerminalConnectionState, TerminalOpen } from '../api/terminal';
import { SshRequestError } from '../api/ssh';
import type { TerminalDisconnectReason } from '../types';
import { terminalReadScheduler } from './terminalReadScheduler';

const READ_RETRY_DELAYS = [1_000, 3_000, 5_000, 10_000] as const;

export type TerminalDisconnectEvent = {
  reason: TerminalDisconnectReason | null;
  reconnectAllowed: boolean;
  message: string;
};

export function terminalDisconnectMessage(reason: TerminalDisconnectReason | null, reconnectAllowed: boolean) {
  switch (reason) {
    case 'IDLE_TIMEOUT': return '终端因长时间未操作已断开，请点击重新连接';
    case 'CLIENT_CLOSED': return '终端连接已关闭。';
    case 'SESSION_NOT_FOUND': return '终端会话已失效，请手动重新连接';
    case 'READER_ERROR': return reconnectAllowed ? '终端读取异常，正在尝试自动重连。' : '终端读取异常，请点击重新连接。';
    case 'CHANNEL_DISCONNECTED': return reconnectAllowed ? 'SSH Channel 已断开，正在尝试自动重连。' : 'SSH Channel 已断开，请点击重新连接。';
    default: return reconnectAllowed ? '终端连接已断开，正在尝试自动重连。' : '终端连接已断开，请点击重新连接。';
  }
}

// HTTP read failures only retry this backend session. They never open a new SSH shell.
export class RemoteTerminal {
  readonly sessionId: string;
  readonly connectionId: string;
  closed = false;
  disconnected = false;
  manuallyClosed = false;
  disconnectReason: TerminalDisconnectReason | null = null;
  reconnectAllowed = false;
  private closing = false;
  private paused: boolean;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private output?: (data: string) => void;
  private report?: (error: string) => void;
  private reportDisconnect?: (event: TerminalDisconnectEvent) => void;
  private backlog: string;
  private pollingGeneration = 0;
  private generation = 0;
  private lifecycleVersion = 0;
  private lastSize = '';
  private readFailureCount = 0;
  private readController?: AbortController;
  private foreground = false;

  constructor(opened: TerminalOpen, startPaused = false) {
    this.sessionId = opened.sessionId;
    this.connectionId = opened.connectionId;
    this.backlog = opened.initialOutput || '';
    this.paused = startPaused;
    if (this.isDisconnectOutput(this.backlog)) {
      this.disconnected = true;
      this.disconnectReason = 'CHANNEL_DISCONNECTED';
    }
  }

  get readLoopGeneration() { return this.generation; }

  setForeground(foreground: boolean) {
    this.foreground = foreground;
    terminalReadScheduler.prioritize();
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
    this.readController?.abort();
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
    if (this.output) this.output(data); else this.backlog += data;
    // Compatibility guard for older backends; it never opts into automatic reconnect.
    if (this.isDisconnectOutput(data)) this.markDisconnected('CHANNEL_DISCONNECTED', false);
  }

  private enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(action);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  subscribe(output: (data: string) => void, report: (error: string) => void, reportDisconnect?: (event: TerminalDisconnectEvent) => void) {
    this.output = output;
    this.report = report;
    this.reportDisconnect = reportDisconnect;
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
    };
  }

  private schedule(delay = 0, generation = this.generation) {
    clearTimeout(this.timer);
    if (!this.isActive(generation) || this.pollingGeneration === generation) return;
    this.timer = setTimeout(() => { void this.poll(generation); }, delay);
  }

  private async poll(generation: number) {
    if (!this.isActive(generation) || this.pollingGeneration === generation) return;
    this.pollingGeneration = generation;
    const controller = new AbortController();
    this.readController = controller;
    let nextDelay = 0;
    try {
      const result = await terminalReadScheduler.run(
        () => terminalApi.read(this.sessionId, controller.signal),
        controller.signal,
        () => this.foreground,
      );
      if (!this.isActive(generation)) return;
      if (this.readFailureCount > 0) {
        console.info(`Terminal Long Poll 网络已恢复 sessionId=${this.sessionId} failures=${this.readFailureCount}`);
        this.readFailureCount = 0;
        this.report?.('');
      }
      const data = result.output || '';
      switch (result.status) {
        case 'DATA':
          if (result.hasData || data) this.emit(data);
          if (result.bufferOverflow) console.warn('Terminal 输出过快，部分旧数据已丢弃');
          break;
        case 'TIMEOUT':
          break;
        case 'REPLACED':
          console.info(`忽略被替换的 Terminal Long Poll sessionId=${this.sessionId} generation=${generation}`);
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
    } catch (error) {
      if (!this.isActive(generation)) return;
      const message = error instanceof Error ? error.message : '读取终端失败';
      if (error instanceof SshRequestError && error.code === 'S0003') {
        console.info(`Terminal read 返回 S0003，先校验原会话 sessionId=${this.sessionId}`);
        try {
          await this.verifyConnected();
          if (!this.isActive(generation)) return;
        } catch (verificationError) {
          if (!this.isActive(generation)) return;
          console.info(`Terminal 会话校验请求失败，继续保留原会话 sessionId=${this.sessionId} reason=${verificationError instanceof Error ? verificationError.message : '未知错误'}`);
        }
      }
      if (this.isActive(generation)) {
        this.readFailureCount += 1;
        nextDelay = READ_RETRY_DELAYS[Math.min(this.readFailureCount - 1, READ_RETRY_DELAYS.length - 1)];
        console.info(`Terminal Long Poll 请求失败，重试原会话 sessionId=${this.sessionId} failure=${this.readFailureCount} retryDelayMs=${nextDelay} reason=${message}`);
        this.report?.(`${message}；将保留当前会话并在 ${Math.ceil(nextDelay / 1000)} 秒后重试读取。`);
      }
    } finally {
      if (this.readController === controller) this.readController = undefined;
      if (this.pollingGeneration === generation) this.pollingGeneration = 0;
      if (this.isActive(generation)) this.schedule(nextDelay, generation);
    }
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
    const state = await terminalApi.connected(this.sessionId);
    if (version !== this.lifecycleVersion || this.manuallyClosed) {
      throw new DOMException('终端状态查询已取消', 'AbortError');
    }
    const connected = state.connected === true && state.sessionId === this.sessionId && state.connectionId === this.connectionId;
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
    if (this.closed || this.closing || this.manuallyClosed) throw new Error('终端会话已关闭，请点击“重新连接”恢复会话。');
    if (this.disconnected) throw new Error('终端连接已断开，请先重新连接。');
    if (this.paused) throw new Error('终端读取已暂停，请先重试读取。');
  }

  exec(command: string) {
    return this.enqueueWrite(async () => { this.assertWritable(); await terminalApi.write(this.sessionId, `${command}\r`); });
  }

  write(input: string) {
    return this.enqueueWrite(async () => { this.assertWritable(); await terminalApi.write(this.sessionId, input); });
  }

  async resize(cols: number, rows: number) {
    if (this.closed || this.closing || this.paused || this.disconnected || this.manuallyClosed) return;
    const size = `${cols}:${rows}`;
    if (size === this.lastSize) return;
    await terminalApi.resize(this.sessionId, cols, rows);
    this.lastSize = size;
  }

  async close() {
    if (this.closed) return;
    this.markManuallyClosed();
    this.closing = true;
    try {
      await terminalApi.close(this.sessionId);
      this.report?.('终端会话已关闭，可点击“重新连接”重新建立会话。');
    } finally {
      this.closed = true;
      this.closing = false;
    }
  }
}
