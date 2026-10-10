import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../state/runtime';
import { IconButton } from './Ui';
import './WindowControls.css';

/** Frameless desktop controls live in the page header; the browser retains its own frame. */
export function WindowControls() {
  const desktop = isTauriRuntime();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      void appWindow.isMaximized().then(value => { if (!disposed) setMaximized(value); })
        .catch(error => console.error('读取窗口状态失败', error));
    };
    refresh();
    void appWindow.onResized(refresh).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.error('监听窗口状态失败', error));
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);

  if (!desktop) return null;
  const perform = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void getCurrentWindow()[action]().catch(error => console.error('操作应用窗口失败', error));
  };
  return <div className="app-window-controls" role="group" aria-label="窗口操作" data-no-window-drag>
    <IconButton icon="minimize" label="最小化窗口" onClick={() => perform('minimize')} />
    <IconButton icon={maximized ? 'restore' : 'maximize'} label={maximized ? '还原窗口' : '最大化窗口'} onClick={() => perform('toggleMaximize')} />
    <IconButton icon="close" label="关闭应用" className="app-window-close" onClick={() => perform('close')} />
  </div>;
}
