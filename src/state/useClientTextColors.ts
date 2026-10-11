import { useLayoutEffect, useSyncExternalStore } from 'react';
import { applyClientTextColors, readClientTextColors, reloadClientTextColors, subscribeClientTextColors, TEXT_COLORS_KEY } from './clientTextColors';
import type { TextColorTheme } from './clientTextColors';

const readResolvedTheme = (): TextColorTheme => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
function subscribeResolvedTheme(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
export function useClientTextColors() {
  const colors = useSyncExternalStore(subscribeClientTextColors, readClientTextColors);
  // 读取实际主题，跟随系统模式变更；不能再调用 useTheme 创建第二份主题控制器。
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
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
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
