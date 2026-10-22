import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalDisconnectMessage } from '../state/remoteTerminal';
import type { TerminalDisconnectEvent } from '../state/remoteTerminal';
import type { TerminalRuntime } from '../state/terminalRuntime';
import type { TerminalDisconnectReason } from '../types';
import { copyText, readClipboardText } from '../state/clipboard';
import { isTauriRuntime } from '../state/runtime';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { handleTerminalFileDrop } from '../state/terminalFileDrop';
import { ClipboardFeedback, useClipboardFeedback } from './ClipboardFeedback';
import { Icon, IconButton, Modal } from './Ui';
import { notify } from '../state/notifications';
import { attachTerminalCompletion } from '../state/terminalCompletionView';
import { readCompletionPreferences, COMPLETION_SETTINGS_EVENT } from '../state/terminalCompletionPreferences';
import './TerminalCompletion.css';
import { TerminalResources } from './TerminalResources';
import { useTerminalTarget } from './TerminalActionsContext';
import { terminalSelectionBounds, terminalSelectionActionPosition } from '../state/terminalSelectionPosition';
import '@xterm/xterm/css/xterm.css';
import './TerminalSelection.css';
import './TerminalPalette.css';

type Props = {
  title?: string;
  runtime?: TerminalRuntime;
  local?: boolean;
  visible: boolean;
  focused?: boolean;
  connected: boolean;
  transportAvailable: boolean;
  disconnectReason: TerminalDisconnectReason | null;
  reconnectAllowed: boolean;
  reconnectAttempts: number;
  reconnecting: boolean;
  manuallyClosed: boolean;
  onDisconnected: (event: TerminalDisconnectEvent) => void;
  onTransportChange: (available: boolean) => void;
  onReconnectExhausted: (attempts: number) => void;
  reconnect: (options?: { automatic?: boolean; attempt?: number; totalAttempts?: number }) => Promise<boolean>;
  cancelReconnect: () => void;
  disconnect: () => void;
  addToAgent: (text: string) => boolean;
  canAddToAgent: boolean;
  uploadFiles?: (paths: string[]) => void;
};

const AUTO_RECONNECT_DELAYS = [1_000, 3_000, 5_000, 10_000] as const;
const TERMINAL_FONT_SIZE_KEY = 'ai-ssh-terminal:terminal-font-size';
const TERMINAL_FONT_SIZE_EVENT = 'ai-ssh-terminal:terminal-font-size-change';
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const MIN_TERMINAL_FONT_SIZE = 9;
const MAX_TERMINAL_FONT_SIZE = 48;

/** 读取并约束本机保存的终端字号，损坏的存储值会自动回退。 */
function readTerminalFontSize() {
  const saved = Number.parseInt(localStorage.getItem(TERMINAL_FONT_SIZE_KEY) ?? '', 10);
  return Number.isFinite(saved)
    ? Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, saved))
    : DEFAULT_TERMINAL_FONT_SIZE;
}

const terminalThemes = {
  // xterm 的概览标尺用 canvas 绘制边线，未指定时为白色；隐藏原生滚动条并不能移除它。
  // Complete the bright ANSI palette too: otherwise bold/bright prompts fall
  // back to xterm's neon green/yellow even with a softened light background.
  light: { background: '#f8f9fb', foreground: '#303942', cursor: '#4f75a7', cursorAccent: '#f8f9fb', selectionBackground: '#dce7f3', selectionForeground: '#344054', overviewRulerBorder: '#00000000', scrollbarSliderBackground: '#8b98a780', scrollbarSliderHoverBackground: '#788798a6', scrollbarSliderActiveBackground: '#667383bf', black: '#344054', red: '#a35454', green: '#447c6a', yellow: '#916a36', blue: '#4c759f', magenta: '#79688f', cyan: '#417986', white: '#526174', brightBlack: '#667383', brightRed: '#a35454', brightGreen: '#447c6a', brightYellow: '#916a36', brightBlue: '#4c759f', brightMagenta: '#79688f', brightCyan: '#417986', brightWhite: '#303942' },
  dark: { background: '#2c343b', foreground: '#c8cdd0', cursor: '#9aafbf', cursorAccent: '#2c343b', selectionBackground: '#58718b', selectionForeground: '#ffffff', overviewRulerBorder: '#00000000', scrollbarSliderBackground: '#71808c80', scrollbarSliderHoverBackground: '#8696a3a6', scrollbarSliderActiveBackground: '#9aafbfbc', black: '#66737d', red: '#e69b96', green: '#79c99e', yellow: '#e5c07b', blue: '#82b7f2', magenta: '#c8a2df', cyan: '#78cbd5', white: '#c8cdd0', brightBlack: '#929da5', brightRed: '#ffb4aa', brightGreen: '#9ce5b5', brightYellow: '#f3d79b', brightBlue: '#a5ceff', brightMagenta: '#dfbaf4', brightCyan: '#9fe3eb', brightWhite: '#f0f3f6' },
};

export function currentTerminalTheme() {
  const root = document.documentElement;
  const theme = root.dataset.themePreference === 'night' ? nightTerminalTheme : terminalThemes[root.dataset.theme === 'dark' ? 'dark' : 'light'];
  // 壁纸模式只移除 xterm 的独立底色，由 terminal-pane 绘制一次可调背景。
  // 字体、光标及 ANSI 配色仍跟随主题；不能对整个终端设置 opacity。
  return root.dataset.wallpaper === 'true' ? { ...theme, background: '#00000000' } : theme;
}

const nightTerminalTheme = {
  background: '#161a20', foreground: '#cbd3dc', cursor: '#a8bce2', cursorAccent: '#161a20',
  selectionBackground: '#3b5477', selectionForeground: '#ffffff', overviewRulerBorder: '#00000000',
  scrollbarSliderBackground: '#56627680', scrollbarSliderHoverBackground: '#73839ba6', scrollbarSliderActiveBackground: '#a8bce2bc',
  black: '#637081', red: '#ea9b98', green: '#7cd5a5', yellow: '#e8c17e', blue: '#85b7ff', magenta: '#c9a1ea', cyan: '#79cddb', white: '#dce1e8',
  brightBlack: '#8694a5', brightRed: '#ffb7ae', brightGreen: '#a0ecc0', brightYellow: '#f5daa0', brightBlue: '#accfff', brightMagenta: '#e2bffa', brightCyan: '#a0e8f0', brightWhite: '#edf1f7',
};

function currentTerminalTypography() {
  const dark = document.documentElement.dataset.theme === 'dark';
  // Cascadia Mono supports intermediate weights; Consolas often renders 500 as regular.
  return {
    fontFamily: dark ? 'Consolas, "Courier New", monospace' : '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
    fontWeight: dark ? 400 : 500,
    fontWeightBold: 700,
    lineHeight: dark ? 1 : 1.2,
  };
}

export function RemoteTerminalView({
  title, runtime, local = false, visible, focused = true, connected, transportAvailable, disconnectReason, reconnectAllowed, reconnectAttempts,
  reconnecting, manuallyClosed, onDisconnected, onTransportChange, onReconnectExhausted, reconnect, cancelReconnect, disconnect, addToAgent, canAddToAgent, uploadFiles,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const uploadFilesRef = useRef(uploadFiles);
  uploadFilesRef.current = uploadFiles;
  useEffect(() => {
    if (!isTauriRuntime() || local || !visible || !connected || !transportAvailable || !runtime || !uploadFilesRef.current) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed || !element.current) return;
      handleTerminalFileDrop(event.payload, element.current, {
        hit: (x, y) => document.elementFromPoint(x, y), scale: window.devicePixelRatio,
        hover: setFileDragActive, drop: paths => uploadFilesRef.current?.(paths),
      });
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => { if (!disposed) setFileDragActive(false); });
    return () => { disposed = true; unlisten?.(); setFileDragActive(false); };
  }, [runtime, local, visible, connected, transportAvailable]);
  const term = useRef<Terminal | null>(null);
  const [error, setError] = useState('');
  const [localReconnecting, setLocalReconnecting] = useState(false);
  const [pendingAttempt, setPendingAttempt] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionAction, setSelectionAction] = useState<{ text:string;anchor:{left:number;right:number;top:number;bottom:number} }|null>(null);
  const [selectionActionPosition,setSelectionActionPosition]=useState<{left:number;top:number;fontFamily:string}|null>(null);
  const selectionActionRef = useRef<HTMLDivElement>(null);
  const [pasteFallback, setPasteFallback] = useState(false);
  const [pasteDraft, setPasteDraft] = useState('');
  const [completionPrefs,setCompletionPrefs]=useState(readCompletionPreferences);
  const [completionSetup,setCompletionSetup]=useState(false);
  const [completionStatus,setCompletionStatus]=useState('未初始化');
  const completion=useRef<ReturnType<typeof attachTerminalCompletion>|null>(null);
  const [fontSize, setFontSize] = useState(readTerminalFontSize);
  const fontSizeRef = useRef(fontSize);
  const pasteField = useRef<HTMLTextAreaElement>(null);
  const { feedback, showFeedback, clearFeedback } = useClipboardFeedback();
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const copyShortcut = isMac ? '⌘C' : 'Ctrl+C';
  const pasteShortcut = isMac ? '⌘V' : 'Ctrl+V';
  const systemPasteShortcut = isMac ? '⌘V' : 'Ctrl+V';
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const sessionUnavailable = !connected || !runtime || runtime.closed || runtime.disconnected;
  const transportUnavailable = !manuallyClosed && !runtime?.disconnected && !runtime?.closed
    && (!transportAvailable || runtime?.transportAvailable === false);
  const unavailable = sessionUnavailable || transportUnavailable;
  const isReconnecting = reconnecting || localReconnecting;
  const allowInput = useRef(!unavailable);
  const disconnectHandler = useRef(onDisconnected);
  const transportHandler = useRef(onTransportChange);
  const reconnectHandler = useRef(reconnect);
  const exhaustedHandler = useRef(onReconnectExhausted);
  const activeRuntime = useRef(runtime);
  const reconnectingRef = useRef(false);
  const reconnectGeneration = useRef(0);
  activeRuntime.current = runtime;
  fontSizeRef.current = fontSize;
  allowInput.current = !unavailable;
  disconnectHandler.current = onDisconnected;
  transportHandler.current = onTransportChange;
  reconnectHandler.current = reconnect;
  exhaustedHandler.current = onReconnectExhausted;

  useEffect(()=>{
    const update=()=>setCompletionPrefs(readCompletionPreferences());
    window.addEventListener(COMPLETION_SETTINGS_EVENT,update);
    return()=>window.removeEventListener(COMPLETION_SETTINGS_EVENT,update);
  },[]);
  useEffect(()=>{completion.current?.suspend();if(!visible||unavailable)setCompletionSetup(false);},[visible,focused,unavailable]);

  const addSelectionToAgent = (text = term.current?.getSelection() ?? '') => {
    if (!canAddToAgent || !text.trim()) return;
    if (addToAgent(text)) { setSelectionAction(null); showFeedback('已添加到对话草稿，尚未发送'); }
    else showFeedback('未能添加，请查看对话框提示', 'error');
  };
  useEffect(() => { setSelectionAction(null); }, [visible, runtime]);
  useLayoutEffect(()=>{
    if(!selectionAction||!selectionActionRef.current)return;
    const box=selectionActionRef.current.getBoundingClientRect();
    const position=terminalSelectionActionPosition(selectionAction.anchor,box,{width:window.innerWidth,height:window.innerHeight});
    const view=element.current?.closest('.remote-terminal-view');
    setSelectionActionPosition({...position,fontFamily:view?window.getComputedStyle(view).fontFamily:'var(--font-ui)'});
  },[selectionAction]);
  useEffect(() => {
    if (!selectionAction) return;
    const dismiss = (event: PointerEvent) => { if (!selectionActionRef.current?.contains(event.target as Node)) setSelectionAction(null); };
    const resize = () => setSelectionAction(null);
    window.addEventListener('pointerdown', dismiss); window.addEventListener('resize', resize); window.addEventListener('scroll',resize,true);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', resize); window.removeEventListener('scroll',resize,true); };
  }, [selectionAction]);

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
      if (term.current !== terminal || activeRuntime.current !== target || !allowInput.current || !visibleRef.current || !focusedRef.current) return;
      pasteText(text);
    } catch {
      if (term.current !== terminal || activeRuntime.current !== target || !allowInput.current || !visibleRef.current || !focusedRef.current) return;
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
    setCompletionStatus('未初始化');
    setError('');
    setLocalReconnecting(false);
    setPendingAttempt(0);
    setHasSelection(false);
    reconnectingRef.current = false;
    const init = setTimeout(() => {
      const terminalElement = element.current;
      if (!terminalElement) return;
      const terminal = new Terminal({ ...currentTerminalTypography(), fontSize: fontSizeRef.current, cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2,
        scrollback: 5000, scrollOnUserInput: true, allowTransparency: true, allowProposedApi: false, overviewRuler: { width: 6 }, theme: currentTerminalTheme() });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(terminalElement);
      term.current = terminal;
      if (visibleRef.current && focusedRef.current && (allowInput.current || !local)) terminal.focus();

      /** 修改字号后立即重新适配行列数，并把新的终端尺寸同步给 CMD 或 SSH 会话。 */
      const applyFontSize = (nextFontSize: number) => {
        fontSizeRef.current = nextFontSize;
        terminal.options.fontSize = nextFontSize;
        setFontSize(nextFontSize);
        fit.fit();
        if (runtime) void runtime.resize(terminal.cols, terminal.rows).catch(error => setError(error.message));
      };
      const receiveFontSize = (event: Event) => {
        const requested = (event as CustomEvent<number>).detail;
        if (Number.isFinite(requested)) applyFontSize(requested);
      };
      const zoomWithWheel = (event: WheelEvent) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = event.deltaY < 0 ? 1 : -1;
        const nextFontSize = Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, fontSizeRef.current + direction));
        if (nextFontSize === fontSizeRef.current) return;

        // 字号是整个客户端的终端偏好，广播后所有已打开页签会保持一致。
        localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(nextFontSize));
        window.dispatchEvent(new CustomEvent<number>(TERMINAL_FONT_SIZE_EVENT, { detail: nextFontSize }));
      };
      window.addEventListener(TERMINAL_FONT_SIZE_EVENT, receiveFontSize);
      // 在捕获阶段截断 Ctrl + 滚轮，避免 xterm 同时滚动终端历史内容。
      terminalElement.addEventListener('wheel', zoomWithWheel, { capture: true, passive: false });
      if(!local&&runtime){
        completion.current=attachTerminalCompletion(terminal,input=>runtime.write(input),
          ()=>activeRuntime.current===runtime&&allowInput.current&&visibleRef.current&&focusedRef.current,(text,announce)=>{
            setCompletionStatus(text);
            if(announce===false)return;
            if(text.startsWith('已连接 Bash'))notify('Bash 智能补全已初始化','success');
            else if(/^(初始化失败|未收到 Bash|初始化已取消)/.test(text))notify(text,'error');
          },runtime.completionRequest?((model,context,signal)=>runtime.completionRequest!(model,context,signal)):undefined,{nonce:runtime.completionNonce,nonceChanged:nonce=>runtime.adoptDirectoryNonce?.(nonce),entries:runtime.completionEntries?((path,signal)=>runtime.completionEntries!(path,signal)):undefined});
      }
      terminal.attachCustomKeyEventHandler(event => {
        if(completion.current?.controller.key(event)){event.preventDefault();return false;}

        const key = event.key.toLowerCase();
        const clipboardShortcut = !event.altKey && ((event.ctrlKey && event.shiftKey && !event.metaKey)
          || (event.metaKey && !event.ctrlKey));
        const selectedCopy = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && terminal.hasSelection();
        if (key === 'c' && (clipboardShortcut || selectedCopy)) {
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
        // With no selection, plain Ctrl+C keeps its normal terminal interrupt.
        return true;
      });
      const selection = terminal.onSelectionChange(() => {
        setHasSelection(terminal.hasSelection());
        setSelectionAction(null);
      });
      const scroll=terminal.onScroll(()=>setSelectionAction(null));
      const unsubscribe = runtime?.subscribe(
        data => new Promise<void>(resolve => terminal.write(data, () => {
          if (visibleRef.current && !terminal.hasSelection()) terminal.scrollToBottom();
          resolve();
        })),
        setError,
        event => { setError(''); disconnectHandler.current(event); },
        available => {
          if (!available) allowInput.current = false;
          else setError('');
          transportHandler.current(available);
        },
      ) ?? (() => {});
      const input = terminal.onData(data => {
        if (!allowInput.current || !runtime) return;
        if(completion.current?.controller.input(data))return;
        void runtime.write(data).catch(error => setError(`${error.message}；输入未自动重试。`));
      });
      let resizeTimer: ReturnType<typeof setTimeout>;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!terminalElement.clientWidth || !terminalElement.clientHeight) return;
          fit.fit();
          if (runtime) void runtime.resize(terminal.cols, terminal.rows).catch(error => setError(error.message));
        }, 120);
      });
      observer.observe(terminalElement);
      const themeObserver = new MutationObserver(() => {
        terminal.options.theme = currentTerminalTheme();
        const typography = currentTerminalTypography();
        if (terminal.options.fontFamily !== typography.fontFamily || terminal.options.fontWeight !== typography.fontWeight || terminal.options.lineHeight !== typography.lineHeight) {
          terminal.options = typography;
          if (terminalElement.clientWidth && terminalElement.clientHeight) {
            fit.fit();
            if (runtime) void runtime.resize(terminal.cols, terminal.rows).catch(error => setError(error.message));
          }
        }
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-preference', 'data-wallpaper'] });
      cleanup = () => {
        completion.current?.dispose();completion.current=null;
        clearTimeout(resizeTimer);
        observer.disconnect();
        themeObserver.disconnect();
        window.removeEventListener(TERMINAL_FONT_SIZE_EVENT, receiveFontSize);
        terminalElement.removeEventListener('wheel', zoomWithWheel, { capture: true });
        input.dispose();
        selection.dispose();
        scroll.dispose();
        unsubscribe();
        terminal.dispose();
        term.current = null;
      };
    }, 0);
    return () => { clearTimeout(init); cleanup(); };
  }, [runtime]);

  useEffect(() => {
    if (!visible || !focused) return;
    const control = document.activeElement;
    // A disconnected terminal still needs focus for the reconnect key, without taking it from chat or another pane.
    if (unavailable && control && control !== document.body && !element.current?.closest('.terminal-session-pane')?.contains(control)) return;
    // Clicking a pane's select/toolbar/paste field must not steal its keyboard focus.
    if (control?.matches('select, button, textarea, input') && element.current?.closest('.terminal-session-pane')?.contains(control)) return;
    term.current?.focus();
  }, [visible, focused, unavailable]);
  useEffect(() => {
    if (connected || manuallyClosed) {
      reconnectGeneration.current += 1;
      setLocalReconnecting(false);
      setPendingAttempt(0);
      reconnectingRef.current = false;
      if (manuallyClosed) setError('');
    }
  }, [connected, manuallyClosed]);

  useEffect(() => {
    if (connected || !reconnectAllowed || manuallyClosed || !runtime || runtime.manuallyClosed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishWait: (() => void) | undefined;
    const wait = (delay: number) => new Promise<void>(resolve => {
      finishWait = resolve;
      timer = setTimeout(() => { finishWait = undefined; resolve(); }, delay);
    });

    const reconnectAutomatically = async () => {
      for (let index = 0; index < AUTO_RECONNECT_DELAYS.length && !cancelled; index += 1) {
        const attempt = index + 1;
        const delay = AUTO_RECONNECT_DELAYS[index];
        setPendingAttempt(attempt);
        console.info(`SSH 自动重连等待 sessionId=${runtime.sessionId} attempt=${attempt} retryDelayMs=${delay}`);
        await wait(delay);
        if (cancelled || activeRuntime.current !== runtime || runtime.manuallyClosed) return;
        if (reconnectingRef.current) continue;
        const generation = ++reconnectGeneration.current;
        reconnectingRef.current = true;
        setLocalReconnecting(true);
        try {
          const recovered = await reconnectHandler.current({
            automatic: true,
            attempt,
            totalAttempts: AUTO_RECONNECT_DELAYS.length,
          });
          if (cancelled || activeRuntime.current !== runtime) return;
          if (recovered) return;
        } finally {
          if (reconnectGeneration.current === generation) {
            reconnectingRef.current = false;
            if (!cancelled) setLocalReconnecting(false);
          }
        }
      }
      if (!cancelled) {
        setError(`自动重连已达到 ${AUTO_RECONNECT_DELAYS.length} 次。`);
        exhaustedHandler.current(AUTO_RECONNECT_DELAYS.length);
      }
    };

    void reconnectAutomatically();
    return () => { cancelled = true; if (timer) clearTimeout(timer); finishWait?.(); };
  }, [connected, manuallyClosed, reconnectAllowed, runtime]);

  const reconnectNow = async () => {
    if (reconnectingRef.current) return;
    const generation = ++reconnectGeneration.current;
    reconnectingRef.current = true;
    setLocalReconnecting(true);
    try {
      const recovered = await reconnect({ automatic: false });
      if (!recovered && reconnectGeneration.current === generation) setLocalReconnecting(false);
    } catch {
      if (reconnectGeneration.current === generation) setLocalReconnecting(false);
    } finally {
      if (reconnectGeneration.current === generation) reconnectingRef.current = false;
    }
  };

  const handleTerminalKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selectionAction && event.key === 'Escape') {
      setSelectionAction(null); event.preventDefault(); event.stopPropagation(); return;
    }
    if (local || !sessionUnavailable || !visible || !focused) return;
    // Scope this to xterm, preserving clipboard/app shortcuts and normal focus navigation.
    if (!(event.target instanceof Element) || !event.target.closest('.remote-terminal-screen')) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isDefaultPrevented() || event.nativeEvent.isComposing
      || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Tab', 'Escape', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return;
    // Consume the initiating key before xterm translates it; never queue it for the new shell.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || isReconnecting || reconnectingRef.current) return;
    void reconnectNow();
  };

  const attempt = Math.max(pendingAttempt, reconnectAttempts, 1);
  const unavailableMessage = isReconnecting
    ? `正在进行第 ${attempt} 次连接并创建新的终端会话…`
    : `${error || terminalDisconnectMessage(disconnectReason, reconnectAllowed)}${local ? '' : ' 在终端内按任意键重新连接。'}`;
  const canCancelConnection = !local && !manuallyClosed && (isReconnecting || (!connected && pendingAttempt > 0 && reconnectAllowed));

  useTerminalTarget(visible && focused, {
    title: title || (local ? '本地终端' : 'SSH 终端'), fontSize,
    commands: [
      { id: 'copy', label: '复制选中文本', group: 'clipboard', shortcut: copyShortcut, disabled: !hasSelection,
        reason: '请先选中终端里的文字', run: () => { term.current?.focus(); return copySelection(); } },
      { id: 'paste', label: '粘贴', group: 'clipboard', shortcut: pasteShortcut, disabled: unavailable,
        reason: '终端连接后可粘贴', run: () => { term.current?.focus(); return pasteClipboard(); } },
      { id: 'add', label: '添加到对话', group: 'clipboard', disabled: !hasSelection || !canAddToAgent,
        reason: !canAddToAgent ? '当前对话暂时无法添加内容' : '请先选中终端里的文字',
        run: () => { addSelectionToAgent(); term.current?.focus(); } },
      ...(!local ? [{id:'completion',label:'重新接入 Bash 补全',group:'completion' as const,disabled:unavailable||!completionPrefs.enabled,
        shortcut:completionStatus==='未初始化'?'未初始化':completionStatus==='正在初始化…'?'连接中':/失败|不可用|未收到|失去同步|已取消|不支持/.test(completionStatus)?'需检查':'已连接',
        reason:unavailable?'终端连接后可初始化':'请先在其他设置中开启终端补全；已有会话可重连接入',run:()=>setCompletionSetup(true)}] : []),
      ...(!local ? [{ id: canCancelConnection ? 'cancel' : 'reconnect', label: canCancelConnection ? '取消连接' : isReconnecting ? '正在重连…' : '重新连接',
        group: 'connection' as const, disabled: !canCancelConnection && isReconnecting, run: canCancelConnection ? cancelReconnect : reconnectNow }] : []),
      { id: 'disconnect', label: local ? '关闭终端' : sessionUnavailable ? '关闭页签' : '断开连接', group: 'connection', danger: true, run: disconnect },
    ],
  });

  return <div className="remote-terminal-view" hidden={!visible} onKeyDownCapture={handleTerminalKeyDown}>
    {fileDragActive && <div className="terminal-upload-drop-hint" aria-hidden="true"><Icon name="upload" size={26}/><strong>释放文件，上传到此终端目录</strong><span>上传前会确认服务器和目标目录</span></div>}
    {completionSetup&&createPortal(<Modal title="初始化 Bash 智能补全" icon="bot" onClose={()=>setCompletionSetup(false)}>
      <div className="terminal-completion-setup"><p>请先确认当前终端位于 Bash 4.4+ 的空命令提示符，并使用 emacs 行编辑模式。此操作通过一条短命令静默加载集成脚本，等待最多 10 秒，仅在当前 Shell 会话生效，不修改远端启动配置或写入脚本文件。</p>
        <p>开启后，新建或重连 SSH 会话会自动接入；此入口用于已有会话或手动重试。路径和本次手动命令历史只在应用内匹配；仅在开启 AI 续写时发送当前输入，目录按独立设置决定。按 → 填入，Esc 隐藏，Tab 保留远端补全，仍需手动回车。状态：{completionStatus}</p>
        <footer><button type="button" className="outlined-button" onClick={()=>setCompletionSetup(false)}>取消</button><button type="button" className="primary-button" disabled={unavailable} onClick={()=>{
          const owner=activeRuntime.current;setCompletionSetup(false);
          setTimeout(()=>{if(activeRuntime.current!==owner||!allowInput.current||!visibleRef.current||!focusedRef.current)return;term.current?.focus();void completion.current?.controller.initialize();},0);
        }}>在空提示符处初始化</button></footer></div>
    </Modal>,document.body)}
    <div className="terminal-feedback-anchor">
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
    {transportUnavailable && !isReconnecting ? <div role="status" className="remote-terminal-error is-unreachable">
      <Icon name="alert" size={15} /><span>{error || '后端服务暂不可达，正在重试读取原会话；连接恢复后将自动继续。'}</span>
      <button disabled={!runtime || runtime.closed || runtime.disconnected} onClick={() => { setError(''); runtime?.resume(); }}>重试读取</button>
    </div> : sessionUnavailable && <div role="alert" className="remote-terminal-disconnected">
      <Icon name={isReconnecting ? 'refresh' : 'power'} size={15} />
      <span>{unavailableMessage}</span>
    </div>}
    {!unavailable && error && <div role="alert" className="remote-terminal-error">{error}<button disabled={!connected || !runtime || runtime.closed} onClick={() => { setError(''); runtime?.resume(); }}>重试读取</button></div>}
    {selectionAction && createPortal(<div ref={selectionActionRef} className="terminal-selection-action" role="toolbar" aria-label="终端选中文本操作"
      style={selectionActionPosition??{visibility:'hidden'}} onMouseDown={event => event.preventDefault()}>
      <button type="button" disabled={!canAddToAgent} onClick={() => addSelectionToAgent(selectionAction.text)}><Icon name="bot" size={14} />添加到对话</button>
      <button type="button" aria-label="关闭选区操作" onClick={() => setSelectionAction(null)}><Icon name="close" size={12} /></button>
    </div>,document.body)}
    <div className="remote-terminal-screen" ref={element} aria-label={local ? '本地 CMD 交互区' : '远程终端交互区'} onClick={() => term.current?.focus()}
      onWheelCapture={() => setSelectionAction(null)}
      onPointerUp={event => {
        if (event.button !== 0) return;
        const node = event.currentTarget, terminal = term.current;
        requestAnimationFrame(() => {
          if (!visibleRef.current || term.current !== terminal || !node.isConnected) return;
          const text = terminal?.getSelection();
          const screen=terminal?.element?.querySelector<HTMLElement>('.xterm-screen');
          if (!terminal||!text?.trim()||!screen) { setSelectionAction(null); return; }
          const anchor=terminalSelectionBounds(terminal.getSelectionPosition(),terminal.buffer.active.viewportY,terminal.rows,terminal.cols,screen.getBoundingClientRect());
          setSelectionActionPosition(null);
          setSelectionAction(anchor?{text,anchor}:null);
        });
      }}
      onPasteCapture={event => {
        event.preventDefault();
        event.stopPropagation();
        pasteText(event.clipboardData.getData('text/plain'));
      }} />
    {!local && runtime?.resources && <TerminalResources key={runtime.sessionId} runtime={runtime} visible={visible} connected={!unavailable} title={title || 'SSH 服务器'} />}
  </div>;
}
