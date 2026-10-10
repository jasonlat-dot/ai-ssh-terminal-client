import type { MouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from './runtime';

/** Use the existing page header as the native drag area, excluding interactive controls. */
export function dragAppWindow(event: MouseEvent<HTMLElement>) {
  if (!isTauriRuntime() || event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest('button, input, textarea, select, a, [role="button"], [data-no-window-drag]')) return;
  event.preventDefault();
  const appWindow = getCurrentWindow();
  const action = event.detail === 2 ? appWindow.toggleMaximize() : appWindow.startDragging();
  void action.catch(error => console.error('操作应用窗口失败', error));
}
