import type { CSSProperties, Ref } from 'react';
import type { PreparedWallpaper, WallpaperFit } from '../state/clientAppearance';
import { wallpaperReadability } from '../state/clientAppearance';
import type { CropRect } from '../state/wallpaperCrop';
import { WallpaperVideo } from './WallpaperVideo';

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
};

/**
 * 只展示壁纸与透明度效果，不叠加模拟工具栏、侧栏、图标或文字。
 * 原图只解码一次；选区通过百分比定位实时绘制，拖动/缩放不导出 Canvas、不写库。
 */
export function WallpaperWorkspacePreview({ source, rect, fit, transparency, protection, caption, windowRatio = 16 / 9, imagePlaneRef }: WallpaperWorkspacePreviewProps) {
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
    {/* 仅向读屏软件提供预览状态，不在图片上叠加文字或占用底部高度。 */}
    <figcaption className="visually-hidden">{caption}</figcaption>
  </figure>;
}
