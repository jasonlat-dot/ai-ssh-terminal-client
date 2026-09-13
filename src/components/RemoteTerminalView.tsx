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
  reconnect: () => Promise<boolean>;
  disconnect: () => void;
};

export function RemoteTerminalView({ runtime, visible, confirm, online, onDisconnected, reconnect, disconnect }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [error, setError] = useState('');
  const [disconnected, setDisconnected] = useState(runtime.disconnected);
  const [reconnecting, setReconnecting] = useState(false);
  const unavailable = disconnected || !online || runtime.closed;
  const allowInput = useRef(!unavailable);
  const disconnectHandler = useRef(onDisconnected);
  allowInput.current = !unavailable;
  disconnectHandler.current = onDisconnected;
  useEffect(() => {
    let cleanup = () => {};
    setError('');
    setDisconnected(runtime.disconnected);
    setReconnecting(false);
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
  const reconnectNow = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      const connected = await reconnect();
      if (!connected) setReconnecting(false);
    } catch { setReconnecting(false); }
  };
  return <div className="remote-terminal-view" hidden={!visible}>
    <div className="remote-terminal-tools"><span>{confirm ? '可直接在终端中输入；下方命令框提交时会显示确认。' : '交互模式：按键会直接发送到远程服务器。'}</span><div className="remote-terminal-tool-actions"><button className="remote-terminal-reconnect" disabled={reconnecting} onClick={() => { void reconnectNow(); }}>{reconnecting ? '正在重连…' : '重新连接'}</button><button className="remote-terminal-disconnect" onClick={disconnect}>断开连接</button></div></div>
    {unavailable && <div role="alert" className="remote-terminal-disconnected">
      <span className="remote-terminal-disconnected-icon" aria-hidden="true">↻</span>
      <span><strong>{reconnecting ? '正在重新建立连接' : '当前终端连接不可用'}</strong><small>{reconnecting ? '正在连接服务器并创建新的终端会话…' : '点击终端上方的“重新连接”即可恢复会话。'}</small></span>
    </div>}
    {!unavailable && error && <div role="alert" className="remote-terminal-error">{error}<button disabled={!online || runtime.closed} onClick={() => { setError(''); runtime.resume(); }}>重试读取</button></div>}
    <div className="remote-terminal-screen" ref={element} aria-label="远程终端交互区" onClick={() => term.current?.focus()} />
  </div>;
}
