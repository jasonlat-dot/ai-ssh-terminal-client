import { useLayoutEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const STARTUP_MINIMUM_MS = 2000;

/** Count visible time, not time spent initializing a hidden WebView. */
export function useStartupMinimum(desktop: boolean) {
  const [elapsed, setElapsed] = useState(!desktop);
  useLayoutEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void getCurrentWindow().show().then(() => {
      if (disposed) return;
      timer = setTimeout(() => {
        if (!disposed) setElapsed(true);
      }, STARTUP_MINIMUM_MS);
    }).catch(error => console.error('显示主窗口失败', error));
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [desktop]);
  return elapsed;
}
