import { useLayoutEffect, useSyncExternalStore } from 'react';
import { applyClientTypography, readClientTypography, reloadClientTypography, subscribeClientTypography, TYPOGRAPHY_KEY } from './clientTypography';
export const useClientTypography = () => useSyncExternalStore(subscribeClientTypography, readClientTypography);
/** 独立订阅只更新 CSS 变量，选择字体不会重建终端或整张工作区。 */
export function useApplyClientTypography() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const apply = () => applyClientTypography(root);
    const release = subscribeClientTypography(apply);
    const reload = (event: StorageEvent) => { if (event.key === TYPOGRAPHY_KEY || event.key === null) reloadClientTypography(); };
    window.addEventListener('storage', reload); apply();
    return () => {
      release(); window.removeEventListener('storage', reload);
      delete root.dataset.clientFont; delete root.dataset.clientWeightNormal; delete root.dataset.clientWeightBold;
      for (const name of ['--client-ui-font', '--client-ui-weight-normal', '--client-ui-weight-bold']) root.style.removeProperty(name);
    };
  }, []);
}
