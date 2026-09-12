import { terminalApi } from '../api/terminal';
import type { TerminalOpen } from '../api/terminal';

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
    try {
      const result = await terminalApi.read(this.sessionId);
      if (!this.output || this.closed || this.closing || this.paused || this.disconnected) return;
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
          this.markDisconnected(`SSH 已断开${result.eof ? '（已收到 EOF）' : ''}，请点击“重新连接”。`);
          break;
        case 'READER_ERROR':
          console.error('SSH Reader 异常');
          this.markDisconnected('SSH Reader 发生异常，请点击“重新连接”重新建立会话。');
          break;
        default:
          throw new Error(`未知的终端读取状态：${String(result.status)}`);
      }
    }
    catch (error) {
      if (this.closed || this.closing || this.paused || this.disconnected) return;
      const message = error instanceof Error ? error.message : '读取终端失败';
      console.error('Terminal Long Poll 请求异常，已停止轮询', error);
      this.markDisconnected(`${message}，终端读取已停止，请点击“重新连接”。`);
    }
    finally { this.polling = false; this.schedule(); }
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
