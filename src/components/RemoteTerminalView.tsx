import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { RemoteTerminal } from '../state/remoteTerminal';
import '@xterm/xterm/css/xterm.css';

type Props = {
  runtime: RemoteTerminal;
  visible: boolean;
  confirm: boolean;
  online: boolean;
  onDisconnected: (message: string) => void;
  reconnect: (options?: { automatic?: boolean; attempt?: number }) => Promise<boolean>;
  disconnect: () => void;
};

export function RemoteTerminalView({ runtime, visible, confirm, online, onDisconnected, reconnect, disconnect }: Props) {
  const autoReconnectDelays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;
  const element = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [error, setError] = useState('');
  const [disconnected, setDisconnected] = useState(runtime.disconnected);
  const [reconnecting, setReconnecting] = useState(false);
  const [autoAttempt, setAutoAttempt] = useState(0);
  const unavailable = disconnected || !online || runtime.closed;
  const allowInput = useRef(!unavailable);
  const disconnectHandler = useRef(onDisconnected);
  const reconnectHandler = useRef(reconnect);
  const activeRuntime = useRef(runtime);
  const reconnectingRef = useRef(false);
  activeRuntime.current = runtime;
  allowInput.current = !unavailable;
  disconnectHandler.current = onDisconnected;
  reconnectHandler.current = reconnect;
  useEffect(() => {
    let cleanup = () => {};
    setError('');
    setDisconnected(runtime.disconnected);
    setReconnecting(false);
    setAutoAttempt(0);
    reconnectingRef.current = false;
    // Defer allocation so React StrictMode's probe cannot drain initial output.
    const init = setTimeout(() => {
      if (!element.current) return;
      const terminal = new Terminal({ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13, cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2,
        scrollback: 5000, scrollOnUserInput: true, allowProposedApi: false, overviewRuler: { width: 6 }, theme: { background: '#ffffff', foreground: '#243b60', cursor: '#246fe5', cursorAccent: '#ffffff', selectionBackground: '#cfe2ff', scrollbarSliderBackground: '#aebdd180', scrollbarSliderHoverBackground: '#91a6c1a6', scrollbarSliderActiveBackground: '#7890b3bf', black: '#243b60', red: '#be3434', green: '#00885e', yellow: '#946500', blue: '#276ac0', magenta: '#8750bb', cyan: '#008c9e', white: '#d2dceb' } });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current); term.current = terminal;
      // xterm.write() 会异步解析 ANSI 输出。解析完成后再滚到底部，确保 Agent
      // 命令经 Long Poll 回显时，视口始终跟随最新命令、结果和 Shell 提示符。
      const unsubscribe = runtime.subscribe(data => terminal.write(data, () => terminal.scrollToBottom()), setError, message => {
        setError('');
        setDisconnected(true);
        disconnectHandler.current(message);
      });
      const input = terminal.onData(data => {
        if (!allowInput.current) return;
        void runtime.write(data).catch(error => setError(`${error.message}；输入未自动重试。`));
      });
      let resizeTimer: ReturnType<typeof setTimeout>;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!element.current?.clientWidth || !element.current?.clientHeight) return;
          fit.fit();
          void runtime.resize(terminal.cols, terminal.rows).catch(error => setError(error.message));
        }, 120);
      });
      observer.observe(element.current);
      cleanup = () => { clearTimeout(resizeTimer); observer.disconnect(); input.dispose(); unsubscribe(); terminal.dispose(); term.current = null; };
    }, 0);
    return () => { clearTimeout(init); cleanup(); };
  }, [runtime]);
  useEffect(() => { if (visible && !unavailable) term.current?.focus(); }, [visible, unavailable]);

  useEffect(() => {
    if (!disconnected || runtime.closed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const wait = (delay: number) => new Promise<void>(resolve => { timer = setTimeout(resolve, delay); });
    const reconnectAutomatically = async () => {
      for (let index = 0; index < autoReconnectDelays.length && !cancelled; index += 1) {
        const attempt = index + 1;
        const delay = autoReconnectDelays[index];
        setAutoAttempt(attempt);
        console.info(`SSH 自动重连等待 sessionId=${runtime.sessionId} attempt=${attempt} retryDelayMs=${delay}`);
        await wait(delay);
        // 重连成功后 App 会创建新的 RemoteTerminal。旧实例的延迟任务即使已经苏醒，
        // 也绝不能再通过更新后的回调去重连新实例，否则会形成“连接成功后立即断开”的循环。
        if (cancelled || activeRuntime.current !== runtime) return;

        if (reconnectingRef.current) continue;
        reconnectingRef.current = true;
        setReconnecting(true);
        console.info(`SSH 自动重连开始 sessionId=${runtime.sessionId} attempt=${attempt}`);
        try {
          const connected = await reconnectHandler.current({ automatic: true, attempt });
          if (cancelled || activeRuntime.current !== runtime) return;
          if (connected) {
            console.info(`SSH 自动重连成功 oldSessionId=${runtime.sessionId} attempt=${attempt}`);
            setDisconnected(false);
            setAutoAttempt(0);
            return;
          }
          console.info(`SSH 自动重连失败 sessionId=${runtime.sessionId} attempt=${attempt}`);
        } finally {
          reconnectingRef.current = false;
          if (!cancelled) setReconnecting(false);
        }
      }
      if (!cancelled) {
        setError('自动重连已达到 6 次，请检查网络后点击“重新连接”。');
        console.info(`SSH 自动重连停止 sessionId=${runtime.sessionId} attempts=${autoReconnectDelays.length}`);
      }
    };

    void reconnectAutomatically();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [disconnected, runtime]);

  const reconnectNow = async () => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    try {
      const connected = await reconnect({ automatic: false });
      if (!connected) setReconnecting(false);
    } catch { setReconnecting(false); }
    finally { reconnectingRef.current = false; }
  };
  return <div className="remote-terminal-view" hidden={!visible}>
    <div className="remote-terminal-tools"><span>{confirm ? '可直接在终端中输入；下方命令框提交时会显示确认。' : '交互模式：按键会直接发送到远程服务器。'}</span><div className="remote-terminal-tool-actions"><button className="remote-terminal-reconnect" disabled={reconnecting} onClick={() => { void reconnectNow(); }}>{reconnecting ? '正在重连…' : '重新连接'}</button><button className="remote-terminal-disconnect" onClick={disconnect}>断开连接</button></div></div>
    {unavailable && <div role="alert" className="remote-terminal-disconnected">
      <span className="remote-terminal-disconnected-icon" aria-hidden="true">↻</span>
      <span><strong>{reconnecting ? '正在重新建立连接' : '当前终端连接不可用'}</strong><small>{reconnecting ? `正在进行第 ${Math.max(autoAttempt, 1)} 次连接并创建新的终端会话…` : autoAttempt > 0 ? `自动重连第 ${autoAttempt} 次正在等待；也可以点击“重新连接”。` : '将自动尝试恢复，也可以点击“重新连接”。'}</small></span>
    </div>}
    {!unavailable && error && <div role="alert" className="remote-terminal-error">{error}<button disabled={!online || runtime.closed} onClick={() => { setError(''); runtime.resume(); }}>重试读取</button></div>}
    <div className="remote-terminal-screen" ref={element} aria-label="远程终端交互区" onClick={() => term.current?.focus()} />
  </div>;
}
