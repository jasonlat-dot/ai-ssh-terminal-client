import { terminalApi } from '../api/terminal';
import type { TerminalOpen } from '../api/terminal';
import { SshRequestError } from '../api/ssh';

const READ_RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

// Long-poll reads must never block keyboard writes. Only writes share a queue so
// keystrokes and submitted commands keep their original order.
export class RemoteTerminal {
  readonly sessionId: string;
  closed = false;
  disconnected = false;
  private closing = false;
  private paused = false;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private output?: (data: string) => void;
  private report?: (error: string) => void;
  private reportDisconnect?: (message: string) => void;
  private backlog: string;
  private polling = false;
  private lastSize = '';
  private readFailureCount = 0;

  constructor(opened: TerminalOpen) {
    this.sessionId = opened.sessionId;
    this.backlog = opened.initialOutput || '';
    if (this.isDisconnectOutput(this.backlog)) this.disconnected = true;
  }
  private isDisconnectOutput(data: string) {
    return data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes('[连接已断开]');
  }
  private markDisconnected(message = '与服务器的终端连接已断开。') {
    if (this.disconnected) return;
    this.disconnected = true;
    this.paused = true;
    clearTimeout(this.timer);
    this.reportDisconnect?.(message);
  }
  private emit(data: string) {
    if (!data) return;
    if (this.output) this.output(data); else this.backlog += data;
    if (this.isDisconnectOutput(data)) this.markDisconnected();
  }
  private enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(action);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
  subscribe(output: (data: string) => void, report: (error: string) => void, reportDisconnect?: (message: string) => void) {
    this.output = output; this.report = report; this.reportDisconnect = reportDisconnect;
    if (this.backlog) { output(this.backlog); this.backlog = ''; }
    if (this.disconnected) reportDisconnect?.('与服务器的终端连接已断开。'); else this.schedule();
    return () => { this.output = undefined; this.report = undefined; this.reportDisconnect = undefined; clearTimeout(this.timer); };
  }
  private schedule(delay = 0) {
    clearTimeout(this.timer);
    if (!this.output || this.closed || this.closing || this.paused || this.disconnected || this.polling) return;
    this.timer = setTimeout(() => { void this.poll(); }, delay);
  }
  private async poll() {
    if (this.closed || this.closing || this.paused || this.disconnected || this.polling) return;
    this.polling = true;
    let nextDelay = 0;
    try {
      const result = await terminalApi.read(this.sessionId);
      if (!this.output || this.closed || this.closing || this.paused || this.disconnected) return;
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
          // A Long Poll timeout is expected. Start the next request immediately.
          break;
        case 'REPLACED':
          console.warn('Terminal Long Poll 被新请求替换');
          break;
        case 'DISCONNECTED':
          console.info('SSH 已断开，eof=', result.eof);
          this.markDisconnected(`SSH 已断开${result.eof ? '（已收到 EOF）' : ''}，客户端将自动尝试重新连接。`);
          break;
        case 'READER_ERROR':
          console.error('SSH Reader 异常');
          this.markDisconnected('SSH Reader 发生异常，客户端将自动尝试重新连接。');
          break;
        default:
          throw new Error(`未知的终端读取状态：${String(result.status)}`);
      }
    }
    catch (error) {
      if (this.closed || this.closing || this.paused || this.disconnected) return;
      const message = error instanceof Error ? error.message : '读取终端失败';
      if (error instanceof SshRequestError && error.kind === 'application' && error.code === 'S0003') {
        console.info(`Terminal 后端会话已不存在 sessionId=${this.sessionId}`);
        this.markDisconnected('后端终端会话已不存在，将尝试重新连接。');
        return;
      }

      /*
       * HTTP Long Poll 失败不代表后端到 SSH 服务器的连接已经断开。
       * 保留当前 terminalSessionId，只按退避时间重试读取，避免一次客户端网络抖动
       * 反过来销毁仍然正常的 SSH Shell。
       */
      this.readFailureCount += 1;
      nextDelay = READ_RETRY_DELAYS[Math.min(this.readFailureCount - 1, READ_RETRY_DELAYS.length - 1)];
      console.info(`Terminal Long Poll 网络波动，准备重试 sessionId=${this.sessionId} failure=${this.readFailureCount} retryDelayMs=${nextDelay} reason=${message}`);
      this.report?.(`${message}；终端读取将在 ${Math.ceil(nextDelay / 1000)} 秒后自动重试。`);
    }
    finally { this.polling = false; this.schedule(nextDelay); }
  }
  resume() { if (this.disconnected) return; this.paused = false; this.report?.(''); this.schedule(); }
  prepareReconnect() {
    this.disconnected = true;
    this.paused = true;
    clearTimeout(this.timer);
  }
  private assertWritable() {
    if (this.closed || this.closing) throw new Error('终端会话已关闭，请点击“重新连接”恢复会话。');
    if (this.disconnected) throw new Error('终端连接已断开，请先重新连接。');
    if (this.paused) throw new Error('终端读取已暂停，请先重试读取。');
  }
  exec(command: string) {
    return this.enqueueWrite(async () => {
      this.assertWritable();
      // Output is collected by the active long-poll read. Using /write avoids a
      // second reader racing the long poll for the same backend output buffer.
      await terminalApi.write(this.sessionId, `${command}\r`);
    });
  }
  write(input: string) { return this.enqueueWrite(async () => { this.assertWritable(); await terminalApi.write(this.sessionId, input); }); }
  async resize(cols: number, rows: number) {
    if (this.closed || this.closing || this.paused || this.disconnected) return;
    const size = `${cols}:${rows}`;
    if (size === this.lastSize) return;
    await terminalApi.resize(this.sessionId, cols, rows);
    this.lastSize = size;
  }
  async close() {
    if (this.closed) return;
    this.closing = true; clearTimeout(this.timer);
    try {
      await terminalApi.close(this.sessionId);
      this.closed = true; this.report?.('终端会话已关闭，可点击“重新连接”重新建立会话。');
    } finally { this.closing = false; this.schedule(); }
  }
}
