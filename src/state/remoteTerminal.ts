import { terminalApi } from '../api/terminal';
import type { TerminalOpen } from '../api/terminal';

// One queue per shell: exec drains the same buffer as read, so they must not race.
export class RemoteTerminal {
  readonly sessionId: string;
  closed = false;
  disconnected = false;
  private closing = false;
  private paused = false;
  private queue: Promise<unknown> = Promise.resolve();
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
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }
  subscribe(output: (data: string) => void, report: (error: string) => void, reportDisconnect?: (message: string) => void) {
    this.output = output; this.report = report; this.reportDisconnect = reportDisconnect;
    if (this.backlog) { output(this.backlog); this.backlog = ''; }
    if (this.disconnected) reportDisconnect?.('与服务器的终端连接已断开。'); else this.schedule();
    return () => { this.output = undefined; this.report = undefined; this.reportDisconnect = undefined; clearTimeout(this.timer); };
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.output || this.closed || this.closing || this.paused || this.disconnected || this.polling) return;
    this.timer = setTimeout(() => { void this.poll(); }, 250);
  }
  private async poll() {
    if (this.closed || this.closing || this.paused || this.polling) return;
    this.polling = true;
    try { await this.enqueue(async () => { if (!this.closed && !this.closing) this.emit((await terminalApi.read(this.sessionId)).output); }); }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取终端失败';
      if (/连接已断开|终端会话不存在|终端会话.*关闭|SSH.*未连接/i.test(message)) this.markDisconnected(message);
      else { this.paused = true; this.report?.(message); }
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
    return this.enqueue(async () => {
      this.assertWritable();
      // The backend forwards bytes verbatim; Enter is required to submit the line.
      this.emit((await terminalApi.exec(this.sessionId, `${command}\r`)).output);
    });
  }
  write(input: string) { return this.enqueue(async () => { this.assertWritable(); await terminalApi.write(this.sessionId, input); }); }
  resize(cols: number, rows: number) {
    return this.enqueue(async () => {
      if (this.closed || this.closing || this.paused || this.disconnected) return;
      const size = `${cols}:${rows}`;
      if (size === this.lastSize) return;
      await terminalApi.resize(this.sessionId, cols, rows); this.lastSize = size;
    });
  }
  async close() {
    if (this.closed) return;
    this.closing = true; clearTimeout(this.timer);
    try {
      await this.enqueue(() => terminalApi.close(this.sessionId));
      this.closed = true; this.report?.('终端会话已关闭，可点击“重新连接”重新建立会话。');
    } finally { this.closing = false; this.schedule(); }
  }
}
