import type { CSSProperties, Ref } from 'react';
import type { PreparedWallpaper, WallpaperFit } from '../state/clientAppearance';
import { wallpaperReadability } from '../state/clientAppearance';
import type { CropRect } from '../state/wallpaperCrop';
import { WallpaperVideo } from './WallpaperVideo';
import { Icon } from './Ui';

/** Lightweight corner illustration, decorative only; no external assets or animation. */
function EmptyPreviewOrbit({ opposite = false }: { opposite?: boolean }) {
  return <svg className={`wallpaper-empty-orbit${opposite ? ' is-opposite' : ''}`} viewBox="0 0 320 220" fill="none" aria-hidden="true" focusable="false">
    <path className="wallpaper-empty-orbit-line" d="M70 -20C58 52 158 115 335 148 M125 -20C117 78 190 116 335 180" />
    <path className="wallpaper-empty-orbit-line is-dashed" d="M-15 12C135 8 133 171 335 206" />
    <g className="wallpaper-empty-orbit-blue"><circle cx="101" cy="63" r="5" /><circle cx="225" cy="126" r="4" />
      <circle cx="46" cy="26" r="2" /><circle cx="169" cy="30" r="2" /><circle cx="278" cy="166" r="2" /></g>
    <g className="wallpaper-empty-orbit-violet"><circle cx="171" cy="112" r="6" /><circle cx="246" cy="188" r="2" /><circle cx="11" cy="66" r="2" /></g>
    <path className="wallpaper-empty-orbit-star" d="M252 30c0 22-5 27-27 27 22 0 27 5 27 27 0-22 5-27 27-27-22 0-27-5-27-27Z" />
  </svg>;
}

function WallpaperPreviewEmpty({ onSelect, disabled }: { onSelect?: () => void; disabled: boolean }) {
  return <div className="wallpaper-preview-empty">
    <EmptyPreviewOrbit /><EmptyPreviewOrbit opposite />
    <div className="wallpaper-empty-content">
      <span className="wallpaper-empty-illustration" aria-hidden="true"><Icon name="image" size={38} /></span>
      <strong>添加工作区壁纸</strong>
      <p>用喜欢的图片或视频，装点你的工作区。</p>
      <button type="button" className="primary-button wallpaper-empty-select" disabled={disabled || !onSelect}
        onClick={onSelect} aria-describedby="wallpaper-empty-formats"><Icon name="upload" size={15} />选择壁纸</button>
      <small id="wallpaper-empty-formats">支持 PNG / JPG / GIF / WebP / MP4</small>
    </div>
  </div>;
}

type WallpaperWorkspacePreviewProps = {
  source?: PreparedWallpaper | null;
  rect?: CropRect | null;
  fit: WallpaperFit;
  transparency: number;
  protection: boolean;
  caption: string;
  /** 效果窗口模拟客户端比例，切换 1:1 改变壁纸区域，而不是把整个工作区变成正方形。 */
  windowRatio?: number;
  /** 拖动按实际显示的选区尺寸计算；完整显示时不能把留白算进图片宽度。 */
  imagePlaneRef?: Ref<HTMLDivElement>;
  /** 仅明确无壁纸时显示；加载、错误和已有壁纸仍保留纯预览。 */
  emptyState?: { onSelect?: () => void; disabled: boolean };
};

/**
 * 有壁纸时只展示画面与透明度效果，不叠加模拟工具栏、侧栏、图标或文字。
 * 原图只解码一次；选区通过百分比定位实时绘制，拖动/缩放不导出 Canvas、不写库。
 */
export function WallpaperWorkspacePreview({ source, rect, fit, transparency, protection, caption, windowRatio = 16 / 9, imagePlaneRef, emptyState }: WallpaperWorkspacePreviewProps) {
  const readability = wallpaperReadability(transparency, protection);
  const hasImage = !!source && !!rect;
  const previewStyle = {
    '--appearance-preview-opacity': `${hasImage ? 100 - transparency : 100}%`,
    '--appearance-preview-blur': `${hasImage ? readability.blur.toFixed(2) : 0}px`,
    '--appearance-preview-ratio': rect ? rect.width / rect.height : 16 / 9,
    '--appearance-preview-window-ratio': windowRatio,
  } as CSSProperties;
  const imageStyle: CSSProperties | undefined = source && rect ? {
    width: `${source.width / rect.width * 100}%`, height: `${source.height / rect.height * 100}%`,
    left: `${-rect.x / rect.width * 100}%`, top: `${-rect.y / rect.height * 100}%`,
  } : undefined;

  return <figure className="appearance-preview" data-fit={fit} data-protection={protection} style={previewStyle}
    aria-label="壁纸与背景透明度的工作区预览">
    <div className="appearance-preview-background" aria-hidden="true">
      {hasImage && <div ref={imagePlaneRef} className="appearance-preview-image-plane">
        {source.kind === 'video' ? <WallpaperVideo src={source.url} style={imageStyle} />
          : <img src={source.url} style={imageStyle} alt="" draggable={false} />}
      </div>}
    </div>
    <div className="appearance-preview-tint" aria-hidden="true" />
    {!hasImage && emptyState && <WallpaperPreviewEmpty {...emptyState} />}
    {/* 仅向读屏软件提供预览状态，不在图片上叠加文字或占用底部高度。 */}
    <figcaption className="visually-hidden">{caption}</figcaption>
  </figure>;
}
