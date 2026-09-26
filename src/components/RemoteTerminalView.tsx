import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalDisconnectMessage } from '../state/remoteTerminal';
import type { RemoteTerminal, TerminalDisconnectEvent } from '../state/remoteTerminal';
import type { TerminalDisconnectReason } from '../types';
import { copyText, readClipboardText } from '../state/clipboard';
import { isTauriRuntime } from '../state/runtime';
import { ClipboardFeedback, useClipboardFeedback } from './ClipboardFeedback';
import { Icon, IconButton } from './Ui';
import '@xterm/xterm/css/xterm.css';

type Props = {
  runtime?: RemoteTerminal;
  visible: boolean;
  connected: boolean;
  disconnectReason: TerminalDisconnectReason | null;
  reconnectAllowed: boolean;
  reconnectAttempts: number;
  reconnecting: boolean;
  manuallyClosed: boolean;
  onDisconnected: (event: TerminalDisconnectEvent) => void;
  onReconnectExhausted: () => void;
  reconnect: (options?: { automatic?: boolean; attempt?: number }) => Promise<boolean>;
  disconnect: () => void;
};

const AUTO_RECONNECT_DELAYS = [1_000, 3_000, 5_000, 10_000] as const;

const terminalThemes = {
  light: { background: '#ffffff', foreground: '#243b60', cursor: '#246fe5', cursorAccent: '#ffffff', selectionBackground: '#cfe2ff', scrollbarSliderBackground: '#aebdd180', scrollbarSliderHoverBackground: '#91a6c1a6', scrollbarSliderActiveBackground: '#7890b3bf', black: '#243b60', red: '#be3434', green: '#00885e', yellow: '#946500', blue: '#276ac0', magenta: '#8750bb', cyan: '#008c9e', white: '#d2dceb' },
  dark: { background: '#0d1624', foreground: '#d8e5f4', cursor: '#72adff', cursorAccent: '#0d1624', selectionBackground: '#31547a', scrollbarSliderBackground: '#52698380', scrollbarSliderHoverBackground: '#69839fa6', scrollbarSliderActiveBackground: '#7894b5bf', black: '#162235', red: '#ff7b72', green: '#45d3a6', yellow: '#e7bd65', blue: '#70a9ff', magenta: '#c099ff', cyan: '#56d4df', white: '#e5eef8' },
};

function currentTerminalTheme() {
  return terminalThemes[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
}

export function RemoteTerminalView({
  runtime, visible, connected, disconnectReason, reconnectAllowed, reconnectAttempts,
  reconnecting, manuallyClosed, onDisconnected, onReconnectExhausted, reconnect, disconnect,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [error, setError] = useState('');
  const [localReconnecting, setLocalReconnecting] = useState(false);
  const [pendingAttempt, setPendingAttempt] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [pasteFallback, setPasteFallback] = useState(false);
  const [pasteDraft, setPasteDraft] = useState('');
  const pasteField = useRef<HTMLTextAreaElement>(null);
  const { feedback, showFeedback, clearFeedback } = useClipboardFeedback();
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const copyShortcut = isMac ? '⌘C' : 'Ctrl+Shift+C';
  const pasteShortcut = isMac ? '⌘V' : 'Ctrl+Shift+V';
  const systemPasteShortcut = isMac ? '⌘V' : 'Ctrl+V';
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const unavailable = !connected || !runtime || runtime.closed || runtime.disconnected;
  const isReconnecting = reconnecting || localReconnecting;
  const allowInput = useRef(!unavailable);
  const disconnectHandler = useRef(onDisconnected);
  const reconnectHandler = useRef(reconnect);
  const exhaustedHandler = useRef(onReconnectExhausted);
  const activeRuntime = useRef(runtime);
  const reconnectingRef = useRef(false);
  activeRuntime.current = runtime;
  allowInput.current = !unavailable;
  disconnectHandler.current = onDisconnected;
  reconnectHandler.current = reconnect;
  exhaustedHandler.current = onReconnectExhausted;

  const copySelection = async () => {
    const terminal = term.current;
    const selected = terminal?.getSelection();
    if (!selected) { showFeedback('请先选中要复制的终端文本', 'info'); return; }
    try {
      await copyText(selected);
      if (term.current === terminal && visibleRef.current) showFeedback('已复制选中文本');
    } catch {
      if (term.current === terminal && visibleRef.current) showFeedback('复制失败，请重试', 'error');
    }
  };
  const pasteText = (text: string) => {
    const terminal = term.current;
    if (!terminal || !allowInput.current) return;
    if (!text) { showFeedback('剪贴板中没有文本', 'info'); return; }
    // Preserve xterm's bracketed-paste mode and newline normalization.
    terminal.paste(text);
    terminal.focus();
    setPasteFallback(false);
    setPasteDraft('');
    showFeedback('已粘贴到终端');
  };
  const pasteClipboard = async () => {
    const terminal = term.current;
    const target = activeRuntime.current;
    if (!terminal || !target || !allowInput.current) return;
    try {
      const text = await readClipboardText();
      if (term.current !== terminal || activeRuntime.current !== target || !allowInput.current || !visibleRef.current) return;
      pasteText(text);
    } catch {
      if (term.current !== terminal || activeRuntime.current !== target || !allowInput.current || !visibleRef.current) return;
      clearFeedback();
      setPasteFallback(true);
    }
  };

  useEffect(() => {
    if (pasteFallback) pasteField.current?.focus();
  }, [pasteFallback]);
  useEffect(() => {
    setPasteFallback(false);
    setPasteDraft('');
    clearFeedback();
  }, [runtime, visible, unavailable, clearFeedback]);

  useEffect(() => {
    runtime?.setForeground(visible);
    return () => runtime?.setForeground(false);
  }, [runtime, visible]);

  useEffect(() => {
    let cleanup = () => {};
    setError('');
    setLocalReconnecting(false);
    setPendingAttempt(0);
    setHasSelection(false);
    reconnectingRef.current = false;
    const init = setTimeout(() => {
      if (!element.current) return;
      const terminal = new Terminal({ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13, cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2,
        scrollback: 5000, scrollOnUserInput: true, allowProposedApi: false, overviewRuler: { width: 6 }, theme: currentTerminalTheme() });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element.current);
      term.current = terminal;
      terminal.attachCustomKeyEventHandler(event => {
        const key = event.key.toLowerCase();
        const clipboardShortcut = !event.altKey && ((event.ctrlKey && event.shiftKey && !event.metaKey)
          || (event.metaKey && !event.ctrlKey));
        if (clipboardShortcut && key === 'c') {
          event.preventDefault();
          if (event.type === 'keydown' && !event.repeat) void copySelection();
          return false;
        }
        const pasteShortcutPressed = (key === 'v' && (clipboardShortcut || (event.ctrlKey && !event.altKey && !event.metaKey)))
          || (key === 'insert' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey);
        if (pasteShortcutPressed) {
          if (isTauriRuntime()) {
            event.preventDefault();
            if (event.type === 'keydown' && !event.repeat) void pasteClipboard();
          }
          // In a browser, allow the OS paste event even when readText is denied.
          // Returning false only skips xterm's key translation (e.g. Ctrl+V -> ^V).
          return false;
        }
        // Plain Ctrl+C always reaches the shell as SIGINT, even with a selection.
        return true;
      });
      const selection = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()));
      const unsubscribe = runtime?.subscribe(
        data => terminal.write(data, () => {
          if (visibleRef.current && !terminal.hasSelection()) terminal.scrollToBottom();
        }),
        setError,
        event => { setError(''); disconnectHandler.current(event); },
      ) ?? (() => {});
      const input = terminal.onData(data => {
        if (!allowInput.current || !runtime) return;
        void runtime.write(data).catch(error => setError(`${error.message}；输入未自动重试。`));
      });
      let resizeTimer: ReturnType<typeof setTimeout>;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!element.current?.clientWidth || !element.current?.clientHeight) return;
          fit.fit();
          if (runtime) void runtime.resize(terminal.cols, terminal.rows).catch(error => setError(error.message));
        }, 120);
      });
      observer.observe(element.current);
      const themeObserver = new MutationObserver(() => { terminal.options.theme = currentTerminalTheme(); });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      cleanup = () => {
        clearTimeout(resizeTimer);
        observer.disconnect();
        themeObserver.disconnect();
        input.dispose();
        selection.dispose();
        unsubscribe();
        terminal.dispose();
        term.current = null;
      };
    }, 0);
    return () => { clearTimeout(init); cleanup(); };
  }, [runtime]);

  useEffect(() => { if (visible && !unavailable) term.current?.focus(); }, [visible, unavailable]);
  useEffect(() => {
    if (connected) {
      setLocalReconnecting(false);
      setPendingAttempt(0);
      reconnectingRef.current = false;
    }
  }, [connected]);

  useEffect(() => {
    if (connected || !reconnectAllowed || manuallyClosed || !runtime || runtime.manuallyClosed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (delay: number) => new Promise<void>(resolve => { timer = setTimeout(resolve, delay); });

    const reconnectAutomatically = async () => {
      for (let index = 0; index < AUTO_RECONNECT_DELAYS.length && !cancelled; index += 1) {
        const attempt = index + 1;
        const delay = AUTO_RECONNECT_DELAYS[index];
        setPendingAttempt(attempt);
        console.info(`SSH 自动重连等待 sessionId=${runtime.sessionId} attempt=${attempt} retryDelayMs=${delay}`);
        await wait(delay);
        if (cancelled || activeRuntime.current !== runtime || runtime.manuallyClosed) return;
        if (reconnectingRef.current) continue;
        reconnectingRef.current = true;
        setLocalReconnecting(true);
        try {
          const recovered = await reconnectHandler.current({ automatic: true, attempt });
          if (cancelled || activeRuntime.current !== runtime) return;
          if (recovered) return;
        } finally {
          reconnectingRef.current = false;
          if (!cancelled) setLocalReconnecting(false);
        }
      }
      if (!cancelled) {
        setError(`自动重连已达到 ${AUTO_RECONNECT_DELAYS.length} 次，请点击“重新连接”。`);
        exhaustedHandler.current();
      }
    };

    void reconnectAutomatically();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [connected, manuallyClosed, reconnectAllowed, runtime]);

  const reconnectNow = async () => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setLocalReconnecting(true);
    try {
      const recovered = await reconnect({ automatic: false });
      if (!recovered) setLocalReconnecting(false);
    } catch {
      setLocalReconnecting(false);
    } finally {
      reconnectingRef.current = false;
    }
  };

  const attempt = Math.max(pendingAttempt, reconnectAttempts, 1);
  const unavailableMessage = isReconnecting
    ? `正在进行第 ${attempt} 次连接并创建新的终端会话…`
    : error || terminalDisconnectMessage(disconnectReason, reconnectAllowed);

  return <div className="remote-terminal-view" hidden={!visible}>
    <div className="remote-terminal-tools">
      <div className="remote-terminal-clipboard" aria-label="终端剪贴板">
        <IconButton icon="copy" label={`复制选中文本 · ${copyShortcut}`} disabled={!hasSelection} onClick={() => { void copySelection(); }} />
        <IconButton icon="paste" label={`粘贴 · ${pasteShortcut}`} disabled={unavailable} onClick={() => { void pasteClipboard(); }} />
        <span className="terminal-shortcut-hint"><span>复制 <kbd>{copyShortcut}</kbd></span><span>粘贴 <kbd>{pasteShortcut}</kbd></span><span>中断 <kbd>Ctrl+C</kbd></span></span>
        {!pasteFallback && <ClipboardFeedback feedback={feedback} />}
        {pasteFallback && <div className="terminal-paste-popover" role="dialog" aria-label="粘贴到终端" onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); setPasteFallback(false); setPasteDraft(''); term.current?.focus(); }
        }}>
          <div className="terminal-paste-heading"><strong>粘贴到终端</strong><IconButton icon="close" label="取消粘贴" onClick={() => { setPasteFallback(false); setPasteDraft(''); term.current?.focus(); }} /></div>
          <p>在下方按 <kbd>{systemPasteShortcut}</kbd> 或使用右键菜单粘贴。</p>
          <textarea ref={pasteField} rows={3} aria-label="待粘贴文本" placeholder="粘贴你的命令或文本" value={pasteDraft} onChange={event => setPasteDraft(event.target.value)} />
          <button type="button" disabled={!pasteDraft || unavailable} onClick={() => pasteText(pasteDraft)}>粘贴到终端</button>
        </div>}
      </div>
      <div className="remote-terminal-tool-actions">
      <button className="remote-terminal-reconnect" disabled={isReconnecting} onClick={() => { void reconnectNow(); }}>{isReconnecting ? '正在重连…' : '重新连接'}</button>
      <button className="remote-terminal-disconnect" onClick={disconnect}>{unavailable ? '关闭页签' : '断开连接'}</button>
    </div></div>
    {unavailable && <div role="alert" className="remote-terminal-disconnected">
      <Icon name={isReconnecting ? 'refresh' : 'power'} size={15} />
      <span>{unavailableMessage}</span>
    </div>}
    {!unavailable && error && <div role="alert" className="remote-terminal-error">{error}<button disabled={!connected || !runtime || runtime.closed} onClick={() => { setError(''); runtime?.resume(); }}>重试读取</button></div>}
    <div className="remote-terminal-screen" ref={element} aria-label="远程终端交互区" onClick={() => term.current?.focus()}
      onPasteCapture={event => {
        event.preventDefault();
        event.stopPropagation();
        pasteText(event.clipboardData.getData('text/plain'));
      }} />
  </div>;
}
