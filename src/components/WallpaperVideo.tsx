import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { bindWallpaperPlayback } from '../state/wallpaperPlayback';

/** 装饰性视频不提供音频或焦点；更换/卸载时释放播放器，不延续旧文件播放。 */
export function WallpaperVideo({ src, style, className, playing = true }: {
  src: string; style?: CSSProperties; className?: string; playing?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.src = src; // StrictMode 的卸载/重挂载也须恢复已释放的 src。
    const release = bindWallpaperPlayback(video, playing);
    return () => { release(); video.removeAttribute('src'); video.load(); };
  }, [src, playing]);
  return <video key={src} ref={ref} src={src} className={className} style={style} muted loop playsInline
    preload="auto" aria-hidden="true" tabIndex={-1} disablePictureInPicture />;
}
