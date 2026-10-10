import { useEffect, useRef, useState } from 'react';
import { resetClientAppearance, setClientPanelTransparency, setClientReadabilityProtection } from '../state/clientAppearance';
import { useClientAppearance } from '../state/useClientAppearance';
import { Icon, Toggle } from './Ui';
import { WallpaperCropEditor } from './WallpaperCropEditor';
import './AppearanceSettings.css';

/** 外观独立于后端；透明度即时保存，画面选区预览后确认，不需要重启 Java。 */
export function AppearanceSettings() {
  const appearance = useClientAppearance();
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const uploadSequence = useRef(0);
  const [editorSaving, setEditorSaving] = useState(false);
  // 原图编辑器常驻。只有更换图片才进入新文件草稿，独立 key 确保旧草稿及时释放。
  const [pendingWallpaper, setPendingWallpaper] = useState<{ file: File; id: number } | null>(null);
  useEffect(() => {
    if (!pendingWallpaper && restoreFocus.current) {
      restoreFocus.current = false;
      picker.current?.focus();
    }
  }, [pendingWallpaper]);
  // Canvas 导出先于存储事务，此时也禁止更换/删除图片，避免两次操作交叉覆盖。
  const disabled = !appearance.ready || appearance.busy || editorSaving;
  const fileAction = <button ref={picker} type="button" className="appearance-picker" disabled={disabled}
    onClick={() => input.current?.click()} title="PNG / JPG / WebP，最大 10 MB。图片只保存在此客户端。">
    <Icon name="upload" size={15} />{appearance.wallpaperUrl || pendingWallpaper ? '更换图片' : '选择一张喜欢的图片'}
  </button>;
  const resetAction = <button type="button" className="appearance-remove-image" aria-label="恢复默认背景"
    title="移除壁纸并恢复默认透明度；主题与连接保持不变"
    disabled={disabled || (!appearance.wallpaperUrl && !appearance.error && !pendingWallpaper)}
    onClick={() => { setPendingWallpaper(null); void resetClientAppearance(); }}><Icon name="trash" size={16} /></button>;
  // 自动保存项放在同一侧栏，不与需要确认保存的画面选区混用状态提示。
  const surfaceControls = <div className="appearance-surface-controls">
    <div className="appearance-slider-heading"><label htmlFor="appearance-transparency">背景透明度</label>
      <output htmlFor="appearance-transparency">{appearance.transparency}<small>%</small></output></div>
    <input id="appearance-transparency" className="appearance-slider" type="range" min={0} max={100} step={1}
      value={appearance.transparency} disabled={disabled || !appearance.wallpaperUrl}
      aria-describedby="appearance-transparency-help" aria-valuetext={`${appearance.transparency}%，数值越大壁纸越明显`}
      onChange={event => setClientPanelTransparency(Number(event.target.value))} />
    <div id="appearance-transparency-help" className="appearance-slider-labels"><span>不透明</span><span>壁纸更明显 · 自动保存</span></div>
  </div>;
  const readabilityControl = <div className="appearance-readability">
      <div><strong id="appearance-readability-label">文字可读性保护</strong>
        <p id="appearance-readability-help">保留遮罩，柔化壁纸，增强文字对比。</p></div>
      <Toggle label="文字可读性保护" value={appearance.readabilityProtection} disabled={disabled}
        aria-describedby="appearance-readability-help" onChange={setClientReadabilityProtection} />
  </div>;
  const heading = <div className="appearance-title-group">
    <span className="appearance-title-icon"><Icon name="palette" size={20} /></span>
    <div><h2 id="appearance-title">工作区外观</h2><p>在工作区预览中调整画面，保存后应用。透明度与文字保护自动保存。</p></div>
  </div>;

  return <section className="appearance-settings" aria-labelledby="appearance-title">
    <input ref={input} id="appearance-wallpaper-file" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          hidden disabled={disabled} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) setPendingWallpaper({ file, id: ++uploadSequence.current });
          }} />
    <WallpaperCropEditor key={pendingWallpaper?.id ?? (appearance.wallpaperUrl ? 'saved' : 'empty')} file={pendingWallpaper?.file}
          hasWallpaper={!!appearance.wallpaperUrl} initializing={!appearance.ready}
          externalBusy={appearance.busy || !appearance.ready} onSavingChange={setEditorSaving}
          transparency={appearance.transparency} protection={appearance.readabilityProtection}
          fileAction={fileAction} surfaceControls={surfaceControls} resetAction={resetAction}
          readabilityControl={readabilityControl} heading={heading}
          externalError={pendingWallpaper ? undefined : appearance.error}
          onClose={pendingWallpaper ? () => {
            restoreFocus.current = true;
            setPendingWallpaper(null);
          } : undefined} />
  </section>;
}
