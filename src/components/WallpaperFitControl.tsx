import type { WallpaperFit } from '../state/clientAppearance';
import { Icon } from './Ui';

/** 裁剪比例决定保存内容；此控件决定保存后的图片如何适配窗口，两者不能混为一谈。 */
export function WallpaperFitControl({ value, disabled, onChange, id, compact = false }: {
  value: WallpaperFit; disabled?: boolean; onChange: (fit: WallpaperFit) => void; id: string; compact?: boolean;
}) {
  const help = value === 'contain'
    ? '保留图片比例，完整显示选区；多余区域留白，不拉伸、不裁边。'
    : '填满整个窗口，保留比例；窗口与图片比例不同时会裁掉部分边缘。';
  const shortHelp = value === 'contain' ? '保留完整选区，多余区域留白。' : '填满窗口，超出边缘会裁切。';
  return <fieldset className="wallpaper-fit-control" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend><span className="appearance-control-label"><Icon name="monitor" size={14} />壁纸显示方式</span></legend>
    <div><button type="button" aria-pressed={value === 'cover'} className={value === 'cover' ? 'selected' : ''} onClick={() => onChange('cover')}><Icon name="maximize" size={14} />铺满窗口{value === 'cover' && <Icon name="check" size={12} className="appearance-choice-check" />}</button>
      <button type="button" aria-pressed={value === 'contain'} className={value === 'contain' ? 'selected' : ''} onClick={() => onChange('contain')}><Icon name="monitor" size={14} />完整显示{value === 'contain' && <Icon name="check" size={12} className="appearance-choice-check" />}</button></div>
    <p id={compact ? undefined : `${id}-help`} title={compact ? help : undefined}>{compact ? shortHelp : help}</p>
    {compact && <span id={`${id}-help`} className="visually-hidden">{help}</span>}
  </fieldset>;
}
