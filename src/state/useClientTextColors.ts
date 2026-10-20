import { useLayoutEffect, useSyncExternalStore } from 'react';
import { applyClientTextColors, readClientTextColors, reloadClientTextColors, resolveTextColorTheme, subscribeClientTextColors, TEXT_COLORS_KEY } from './clientTextColors';
import type { TextColorTheme } from './clientTextColors';

const readResolvedTheme = (): TextColorTheme => resolveTextColorTheme(document.documentElement);
function subscribeResolvedTheme(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-preference'] });
  return () => observer.disconnect();
}
export function useClientTextColors() {
  const colors = useSyncExternalStore(subscribeClientTextColors, readClientTextColors);
  // Read the active named preset without creating a second theme controller.
  const theme = useSyncExternalStore(subscribeResolvedTheme, readResolvedTheme);
  return { ...colors, theme };
}

/** 根节点安装一次：改颜色不重渲染整个工作区，不重连 SSH，也不轮询。 */
export function useApplyClientTextColors() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const apply = () => applyClientTextColors(root);
    const release = subscribeClientTextColors(apply);
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-theme-preference'] });
    const reload = (event: StorageEvent) => { if (event.key === TEXT_COLORS_KEY || event.key === null) reloadClientTextColors(); };
    window.addEventListener('storage', reload);
    apply();
    return () => {
      release(); observer.disconnect(); window.removeEventListener('storage', reload);
      delete root.dataset.clientTextPrimary; delete root.dataset.clientTextSecondary;
      root.style.removeProperty('--client-text-primary'); root.style.removeProperty('--client-text-secondary');
    };
  }, []);
}
