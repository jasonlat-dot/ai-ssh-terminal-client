import { terminalApi } from '../api/terminal';

/** 每次建连独立标识，取消旧请求不会影响立即发起的新连接。 */
export class SshConnectAttempt {
  readonly requestId = crypto.randomUUID();
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  constructor(readonly connectionId: string, readonly backendUrl: string) {}

  async open(timeoutSeconds = 10) {
    if (this.signal.aborted) throw this.signal.reason;
    // Same default/range as the native connection configuration, including IPC stalls.
    const seconds = Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 300 ? timeoutSeconds : 10;
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => {
      const error = new Error(`连接超时（${seconds} 秒），请检查服务器地址、网络或 SSH 服务后重试。`);
      error.name = 'TimeoutError';
      this.cancel(error);
    }, seconds * 1000);
    try {
      const connecting = terminalApi.connect(this.connectionId, this.requestId, this.signal, this.backendUrl)
        .then(opened => {
          // An IPC implementation may finish despite abort: never leave a late session open.
          if (this.signal.aborted) {
            if (opened?.sessionId) void terminalApi.close(opened.sessionId, undefined, this.backendUrl).catch(() => undefined);
            throw this.signal.reason;
          }
          return opened;
        });
      return await Promise.race([connecting, cancelled]);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  cancel(reason: Error = new DOMException('SSH 连接已取消', 'AbortError')) {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    // 清理请求使用建连时的后端地址，切换后端或关闭页面也不会取消错服务。
    void terminalApi.cancelConnect(this.connectionId, this.requestId, this.backendUrl)
      .catch(error => console.info('发送 SSH 连接取消请求失败', error));
  }
}
