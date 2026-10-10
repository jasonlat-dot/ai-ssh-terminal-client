import { terminalApi } from '../api/terminal';

/** 每次建连独立标识，取消旧请求不会影响立即发起的新连接。 */
export class SshConnectAttempt {
  readonly requestId = crypto.randomUUID();
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  constructor(readonly connectionId: string, readonly backendUrl: string) {}

  open() {
    return terminalApi.connect(this.connectionId, this.requestId, this.signal, this.backendUrl);
  }

  cancel() {
    if (this.signal.aborted) return;
    this.controller.abort(new DOMException('SSH 连接已取消', 'AbortError'));
    // 清理请求使用建连时的后端地址，切换后端或关闭页面也不会取消错服务。
    void terminalApi.cancelConnect(this.connectionId, this.requestId, this.backendUrl)
      .catch(error => console.info('发送 SSH 连接取消请求失败', error));
  }
}
