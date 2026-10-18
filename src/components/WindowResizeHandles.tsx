import { useEffect, useState } from 'react';
import type { PointerEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../state/runtime';
import './WindowResizeHandles.css';

const directions = ['North', 'South', 'East', 'West', 'NorthWest', 'NorthEast', 'SouthWest', 'SouthEast'] as const;
type Direction = typeof directions[number];

/** Keep native resizing available across startup, settings and modal screens. */
export function WindowResizeHandles() {
  const desktop = isTauriRuntime();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let revision = 0;
    let unlisten: (() => void) | undefined;
    document.documentElement.dataset.desktopWindow = 'true';
    const refresh = () => {
      const current = ++revision;
      void Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()])
        .then(([maximized, fullscreen]) => {
          if (!disposed && current === revision) setEnabled(!maximized && !fullscreen);
        })
        .catch(error => {
          if (!disposed && current === revision) setEnabled(false);
          console.error('读取窗口缩放状态失败', error);
        });
    };
    refresh();
    void appWindow.onResized(refresh).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.error('监听窗口缩放状态失败', error));
    return () => {
      disposed = true;
      unlisten?.();
      delete document.documentElement.dataset.desktopWindow;
    };
  }, [desktop]);

  if (!desktop || !enabled) return null;
  const resize = (event: PointerEvent<HTMLDivElement>, direction: Direction) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startResizeDragging(direction)
      .catch(error => console.error('调整窗口大小失败', error));
  };
  return <div className="window-resize-handles" aria-hidden="true" data-no-window-drag>
    {directions.map(direction => <div key={direction} className={`window-resize-handle resize-${direction}`}
      onPointerDown={event => resize(event, direction)} />)}
  </div>;
}
