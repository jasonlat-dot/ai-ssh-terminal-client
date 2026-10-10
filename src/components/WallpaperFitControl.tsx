import type { WallpaperFit } from '../state/clientAppearance';

/** 裁剪比例决定保存内容；此控件决定保存后的图片如何适配窗口，两者不能混为一谈。 */
export function WallpaperFitControl({ value, disabled, onChange, id }: {
  value: WallpaperFit; disabled?: boolean; onChange: (fit: WallpaperFit) => void; id: string;
}) {
  return <fieldset className="wallpaper-fit-control" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend>壁纸显示方式</legend>
    <div><button type="button" aria-pressed={value === 'cover'} className={value === 'cover' ? 'selected' : ''} onClick={() => onChange('cover')}>铺满窗口</button>
      <button type="button" aria-pressed={value === 'contain'} className={value === 'contain' ? 'selected' : ''} onClick={() => onChange('contain')}>完整显示</button></div>
    <p id={`${id}-help`}>{value === 'contain'
      ? '保留图片比例，完整显示选区；多余区域留白，不拉伸、不裁边。'
      : '填满整个窗口，保留比例；窗口与图片比例不同时会裁掉部分边缘。'}</p>
  </fieldset>;
}
