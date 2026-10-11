/** 视频无声音；页面不可见/最小化及离开可见区域时暂停，普通失焦（例如录屏）继续播放。 */
const owners = new WeakMap<HTMLVideoElement, object>();
export function bindWallpaperPlayback(video: HTMLVideoElement, playing = true): () => void {
  const owner = {};
  owners.set(video, owner);
  let disposed = false;
  let intersecting = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  const sync = () => {
    if (disposed || !playing || document.hidden || !intersecting) { video.pause(); return; }
    // 系统省电或自动播放策略拒绝时保留当前帧，不向控制台抛出未处理 Promise。
    try {
      if (video.paused) void video.play().then(() => {
        if (owners.get(video) === owner && (disposed || document.hidden || !intersecting)) video.pause();
      }).catch(() => {});
    } catch { /* 解码/自动播放不可用时保持暂停。 */ }
  };
  document.addEventListener('visibilitychange', sync);
  video.addEventListener('loadeddata', sync);
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    intersecting = entries.some(entry => entry.isIntersecting); sync();
  });
  observer?.observe(video);
  sync();
  return () => {
    disposed = true;
    observer?.disconnect();
    document.removeEventListener('visibilitychange', sync);
    video.removeEventListener('loadeddata', sync);
    if (owners.get(video) === owner) video.pause();
  };
}
