import { localTerminalApi } from '../api/localTerminal';
import type { LocalTerminalEvent, LocalTerminalOpen } from '../api/localTerminal';
import type { TerminalConnectionState } from '../api/terminal';
import type { TerminalDisconnectEvent } from './remoteTerminal';
import type { TerminalRuntime } from './terminalRuntime';

/**
 * Tauri 本地 CMD 会话。
 *
 * 输出由 Rust 侧的 ConPTY 主动推送，不需要像远程终端一样轮询后端。
 * 字节流通过同一个 TextDecoder 连续解码，避免中文恰好跨事件分片时出现乱码。
 */
export class LocalTerminal implements TerminalRuntime {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly shell: string;
  readonly cwd: string;
  closed = false;
  disconnected = false;
  manuallyClosed = false;
  reconnectAllowed = false;
  private output?: (data: string) => void;
  private report?: (error: string) => void;
  private reportDisconnect?: (event: TerminalDisconnectEvent) => void;
  private backlog = '';
  private lastSize = '';
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly decoder = new TextDecoder();

  private constructor(opened: LocalTerminalOpen) {
    this.sessionId = opened.sessionId;
    this.connectionId = `local:${opened.sessionId}`;
    this.shell = opened.shell;
    this.cwd = opened.cwd;
  }

  static async open(cols = 120, rows = 24) {
    const queued: LocalTerminalEvent[] = [];
    let runtime: LocalTerminal | undefined;
    const opened = await localTerminalApi.open(cols, rows, event => {
      if (runtime) runtime.receive(event);
      else queued.push(event);
    });
    runtime = new LocalTerminal(opened);
    queued.forEach(event => runtime?.receive(event));
    return runtime;
  }

  get readLoopGeneration() {
    return 0;
  }

  setForeground(_foreground: boolean) {
    // ConPTY 持续推送输出，不需要根据前后台调整轮询优先级。
  }

  private receive(event: LocalTerminalEvent) {
    if (event.type === 'data') {
      const data = this.decoder.decode(new Uint8Array(event.data), { stream: true });
      if (this.output) this.output(data);
      else this.backlog += data;
      return;
    }

    if (event.type === 'error') this.report?.(event.message);
    if (this.manuallyClosed) return;
    this.closed = true;
    this.disconnected = true;
    this.reportDisconnect?.({
      reason: 'CLIENT_CLOSED',
      reconnectAllowed: false,
      message: event.type === 'error' ? event.message : '本地 CMD 进程已退出。',
    });
  }

  private enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(action);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private assertWritable() {
    if (this.closed || this.disconnected || this.manuallyClosed) {
      throw new Error('本地 CMD 已关闭，请新建终端。');
    }
  }

  subscribe(
    output: (data: string) => void,
    report: (error: string) => void,
    reportDisconnect?: (event: TerminalDisconnectEvent) => void,
  ) {
    this.output = output;
    this.report = report;
    this.reportDisconnect = reportDisconnect;
    if (this.backlog) {
      output(this.backlog);
      this.backlog = '';
    }
    return () => {
      if (this.output !== output) return;
      this.output = undefined;
      this.report = undefined;
      this.reportDisconnect = undefined;
    };
  }

  resume() {
    this.report?.('');
  }

  async verifyConnected(): Promise<TerminalConnectionState> {
    return {
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      connected: !this.closed && !this.disconnected && !this.manuallyClosed,
      disconnectReason: this.closed || this.disconnected ? 'CLIENT_CLOSED' : null,
      reconnectAllowed: false,
    };
  }

  prepareReconnect() {
    // 本地进程退出后直接新建 CMD，不复用已退出的 ConPTY。
  }

  markManuallyClosed() {
    this.manuallyClosed = true;
    this.reconnectAllowed = false;
  }

  exec(command: string) {
    return this.enqueueWrite(async () => {
      this.assertWritable();
      await localTerminalApi.write(this.sessionId, `${command}\r`);
    });
  }

  write(input: string) {
    return this.enqueueWrite(async () => {
      this.assertWritable();
      await localTerminalApi.write(this.sessionId, input);
    });
  }

  async resize(cols: number, rows: number) {
    if (this.closed || this.disconnected || this.manuallyClosed) return;
    const size = `${cols}:${rows}`;
    if (size === this.lastSize) return;
    await localTerminalApi.resize(this.sessionId, cols, rows);
    this.lastSize = size;
  }

  async close() {
    // 进程自行退出后 closed 已为 true，但仍要调用 close 释放 Rust 会话表中的资源。
    if (this.manuallyClosed) return;
    this.markManuallyClosed();
    try {
      await localTerminalApi.close(this.sessionId);
    } finally {
      this.closed = true;
      this.disconnected = true;
    }
  }
}
