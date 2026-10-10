import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { initializeClientAppearance, readClientAppearance, subscribeClientAppearance, wallpaperReadability } from './clientAppearance';

/** 外观页订阅共享偏好，不因关闭设置、切换后端或重建工作区而丢失选中的壁纸。 */
export function useClientAppearance() {
  const appearance = useSyncExternalStore(subscribeClientAppearance, readClientAppearance);
  useEffect(() => { void initializeClientAppearance(); }, []);
  return appearance;
}

/**
 * 根节点只更新背景变量，不让滑块每次拖动都重渲染整个 SSH/Agent 工作区。
 * 图片 URL 只能来自本模块创建的 Blob URL，不能直接插入用户提供的路径或远程 URL。
 */
export function useApplyClientAppearance() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const appearance = readClientAppearance();
      const enabled = appearance.wallpaperUrl ? 'true' : 'false';
      // xterm 监听此属性切换透明底色；拖动滑块不能反复触发终端主题重绘。
      if (root.dataset.wallpaper !== enabled) root.dataset.wallpaper = enabled;
      if (root.dataset.wallpaperFit !== appearance.wallpaperFit) root.dataset.wallpaperFit = appearance.wallpaperFit;
      const image = appearance.wallpaperUrl ? `url(${JSON.stringify(appearance.wallpaperUrl)})` : 'none';
      const opacity = `${100 - appearance.transparency}%`;
      const protection = !!appearance.wallpaperUrl && appearance.readabilityProtection;
      const readability = wallpaperReadability(appearance.transparency, protection);
      // 这些属性只驱动 CSS，xterm 不监听它们，保护模式/滑块变化不重建终端。
      const protectedValue = protection ? 'true' : 'false';
      const readableValue = readability.strengthenText ? 'true' : 'false';
      if (root.dataset.wallpaperProtection !== protectedValue) root.dataset.wallpaperProtection = protectedValue;
      if (root.dataset.wallpaperReadability !== readableValue) root.dataset.wallpaperReadability = readableValue;
      const blur = `${readability.blur.toFixed(2)}px`;
      if (root.style.getPropertyValue('--client-wallpaper-image') !== image) root.style.setProperty('--client-wallpaper-image', image);
      if (root.style.getPropertyValue('--client-panel-opacity') !== opacity) root.style.setProperty('--client-panel-opacity', opacity);
      if (root.style.getPropertyValue('--client-wallpaper-blur') !== blur) root.style.setProperty('--client-wallpaper-blur', blur);
      if (root.style.getPropertyValue('--client-wallpaper-size') !== appearance.wallpaperFit) root.style.setProperty('--client-wallpaper-size', appearance.wallpaperFit);
    };
    const release = subscribeClientAppearance(apply);
    apply();
    void initializeClientAppearance();
    return () => {
      release();
      delete root.dataset.wallpaper;
      delete root.dataset.wallpaperProtection;
      delete root.dataset.wallpaperReadability;
      delete root.dataset.wallpaperFit;
      root.style.removeProperty('--client-wallpaper-image');
      root.style.removeProperty('--client-panel-opacity');
      root.style.removeProperty('--client-wallpaper-blur');
      root.style.removeProperty('--client-wallpaper-size');
    };
  }, []);
}
