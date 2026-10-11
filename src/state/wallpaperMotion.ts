import type { ClientAppearance } from './clientAppearance';
import { wallpaperCropRect, INITIAL_CROP_VIEW } from './wallpaperCrop';
import { bindWallpaperPlayback } from './wallpaperPlayback';

/** 动态背景拥有独立 DOM 层，状态变化不重渲染 SSH/Agent，不把视频塞入 CSS URL。 */
export function createWallpaperMotionLayer(container: HTMLElement) {
  const layer = document.createElement('div');
  layer.className = 'client-wallpaper-motion'; layer.setAttribute('aria-hidden', 'true');
  const plane = document.createElement('div'); plane.className = 'client-wallpaper-motion-plane';
  layer.append(plane);
  let currentUrl: string | null = null;
  let currentKind = '';
  let media: HTMLImageElement | HTMLVideoElement | null = null;
  let releasePlayback: (() => void) | undefined;
  function clear() {
    releasePlayback?.(); releasePlayback = undefined;
    if (media?.tagName === 'VIDEO') {
      const video = media as HTMLVideoElement; video.removeAttribute('src'); video.load();
    }
    media?.remove(); media = null; currentUrl = null; currentKind = '';
    layer.remove();
  }
  function apply(appearance: ClientAppearance) {
    if (!appearance.wallpaperUrl || appearance.wallpaperKind === 'image') { clear(); return; }
    if (!layer.isConnected) container.prepend(layer);
    if (currentUrl !== appearance.wallpaperUrl || currentKind !== appearance.wallpaperKind) {
      clear(); container.prepend(layer);
      currentUrl = appearance.wallpaperUrl; currentKind = appearance.wallpaperKind;
      media = document.createElement(currentKind === 'video' ? 'video' : 'img');
      if (media.tagName === 'VIDEO') {
        const video = media as HTMLVideoElement;
        video.preload = 'auto'; video.disablePictureInPicture = true; video.tabIndex = -1;
        video.muted = true; video.loop = true; video.playsInline = true;
      } else { (media as HTMLImageElement).alt = ''; (media as HTMLImageElement).draggable = false; }
      media.src = currentUrl; plane.append(media);
      if (media.tagName === 'VIDEO') releasePlayback = bindWallpaperPlayback(media as HTMLVideoElement);
    }
    const crop = appearance.wallpaperCrop ?? { ratio: appearance.width / appearance.height, view: INITIAL_CROP_VIEW };
    const rect = wallpaperCropRect(appearance, crop.ratio, crop.view);
    layer.dataset.fit = appearance.wallpaperFit;
    layer.style.setProperty('--motion-ratio', String(rect.width / rect.height));
    if (media) {
      media.style.width = `${appearance.width / rect.width * 100}%`;
      media.style.height = `${appearance.height / rect.height * 100}%`;
      media.style.left = `${-rect.x / rect.width * 100}%`;
      media.style.top = `${-rect.y / rect.height * 100}%`;
    }
  }
  return { apply, dispose: clear };
}
