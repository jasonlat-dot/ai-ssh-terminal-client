import { useToastError, useErrorToast } from '../state/useToastError';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { chooseClientWallpaper, prepareClientWallpaper, prepareSavedClientWallpaper, readClientAppearance } from '../state/clientAppearance';
import type { PreparedWallpaper, WallpaperFit } from '../state/clientAppearance';
import { exportWallpaperCrop, INITIAL_CROP_VIEW, MAX_CROP_ZOOM, normalizeCropView, panCropView, wallpaperCropRect } from '../state/wallpaperCrop';
import type { CropView } from '../state/wallpaperCrop';
import { AccentIcon, Badge, Icon } from './Ui';
import { WallpaperFitControl } from './WallpaperFitControl';
import { WallpaperWorkspacePreview } from './WallpaperWorkspacePreview';
import { WallpaperVideo } from './WallpaperVideo';
import { notify } from '../state/notifications';
import './WallpaperCropEditor.css';

const FIXED_RATIOS = [
  { key: '16:9', label: '16 : 9', value: 16 / 9 },
  { key: '16:10', label: '16 : 10', value: 16 / 10 },
  { key: '4:3', label: '4 : 3', value: 4 / 3 },
  { key: '1:1', label: '1 : 1', value: 1 },
];

function currentWindowRatio() {
  return Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight);
}

type CropSettings = { ratio: number; view: CropView; fit: WallpaperFit };
type WallpaperCropEditorProps = {
  /** 上传草稿；为空时常驻编辑已保存原图。 */
  file?: File;
  /** 仅新上传草稿需要关闭；已保存图片的控件在保存后继续显示。 */
  onClose?: () => void;
  externalBusy?: boolean;
  /** 把导出阶段也通知外观页，防止尚未写库时更换图片/恢复默认与保存互相覆盖。 */
  onSavingChange?: (saving: boolean) => void;
  transparency?: number;
  protection?: boolean;
  /** 由外观页提供自动保存项和文件操作；编辑器只管理需要确认保存的画面草稿。 */
  fileAction?: ReactNode;
  surfaceControls?: ReactNode;
  resetAction?: ReactNode;
  /** 恢复默认等外部操作失败也显示在同一编辑区，避免页面出现两份错误提示。 */
  externalError?: string | null;
  /** 用外观存储的快照区分真正空状态与已有图片尚未解码，空状态不读取原图。 */
  hasWallpaper?: boolean;
  /** 首次恢复偏好时只显示加载状态，不把默认背景误报为已保存图片。 */
  initializing?: boolean;
  /** 外观页提供标题与自动保存开关，保持原有设置导航和主题不变。 */
  heading?: ReactNode;
  readabilityControl?: ReactNode;
  /** 空预览的选择入口复用外观页文件输入，不另建上传或保存流程。 */
  onSelectWallpaper?: () => void;
};

/** 原图画面控件常驻外观页；比例、缩放即时预览，确认保存才替换全局壁纸。 */
export function WallpaperCropEditor({ file, onClose, externalBusy = false, onSavingChange,
  transparency = 25, protection = true, fileAction, surfaceControls, resetAction, externalError,
  hasWallpaper = true, initializing = false, heading, readabilityControl, onSelectWallpaper }: WallpaperCropEditorProps) {
  const [source, setSource] = useState<PreparedWallpaper | null>(null);
  const [limitedSource, setLimitedSource] = useState(false);
  const [savedRatio, setSavedRatio] = useState<number | null>(null);
  const [error, setError] = useToastError();
  useErrorToast(externalError);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<CropView>(INITIAL_CROP_VIEW);
  // 初始选区固定；窗口变化只更新“当前窗口”选项，不能悄悄改写已选画面或重新加载原图。
  const [initialWindowRatio] = useState(currentWindowRatio);
  const [windowRatio, setWindowRatio] = useState(initialWindowRatio);
  const [ratio, setRatio] = useState(initialWindowRatio);
  const [ratioKey, setRatioKey] = useState('window');
  const [fit, setFit] = useState<WallpaperFit>('cover');
  const [baseline, setBaseline] = useState<CropSettings | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const imagePlane = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const savingRef = useRef(false);
  const drag = useRef<{ id: number; x: number; y: number; width: number; height: number; view: CropView } | null>(null);
  const ratios = [
    { key: 'window', label: '当前窗口', value: windowRatio },
    ...FIXED_RATIOS,
    // 若窗口尺寸已变化，保留上次真实比例，不能把旧选区强行改成新的窗口比例。
    ...(savedRatio === null ? [] : [{ key: 'saved', label: file ? '保留比例' : '上次比例', value: savedRatio }]),
  ];
  const rect = source ? wallpaperCropRect(source, ratio, view) : null;
  const disabled = !source || saving || externalBusy;
  const empty = !file && !hasWallpaper;
  const normalizedView = source ? normalizeCropView(source, ratio, view) : view;
  // 归一化中心可能有浮点舍入，不能把同一选区误报为未保存，也不能无变化重复写库。
  const hasChanges = !!source && (!!file || !baseline || Math.abs(baseline.ratio - ratio) > 1e-9
    || baseline.fit !== fit || (['zoom', 'centerX', 'centerY'] as const)
      .some(key => Math.abs(baseline.view[key] - normalizedView[key]) > 1e-9));

  useEffect(() => {
    const updateWindowRatio = () => setWindowRatio(currentWindowRatio());
    window.addEventListener('resize', updateWindowRatio);
    return () => window.removeEventListener('resize', updateWindowRatio);
  }, []);

  useEffect(() => {
    if (ratioKey === 'window' && Math.abs(ratio - windowRatio) > 1e-9) {
      setSavedRatio(ratio);
      setRatioKey('saved');
    }
  }, [ratio, ratioKey, windowRatio]);

  useEffect(() => {
    // 空状态保持同样布局，但不能去读取一份不存在的原图或持续显示“正在读取”。
    if (empty) return;
    alive.current = true;
    let disposed = false;
    let draft: PreparedWallpaper | null = null;
    const preparation = file
      ? prepareClientWallpaper(file).then(prepared => ({ prepared, previous: undefined }))
      : prepareSavedClientWallpaper().then(previous => ({ prepared: previous, previous }));
    void preparation.then(({ prepared, previous }) => {
      if (disposed) { URL.revokeObjectURL(prepared.url); return; }
      draft = prepared;
      const initialRatio = previous?.crop.ratio ?? initialWindowRatio;
      const initialView = normalizeCropView(prepared, initialRatio, previous?.crop.view ?? INITIAL_CROP_VIEW);
      const initialFit = previous?.fit ?? 'cover';
      setBaseline({ ratio: initialRatio, view: initialView, fit: initialFit });
      setRatio(initialRatio);
      setView(initialView);
      setFit(initialFit);
      if (previous) {
        const matchingRatio = FIXED_RATIOS.find(option => option.value === previous.crop.ratio);
        const key = matchingRatio?.key ?? (previous.crop.ratio === initialWindowRatio ? 'window' : 'saved');
        setSavedRatio(key === 'saved' ? previous.crop.ratio : null);
        setRatioKey(key);
        setLimitedSource(previous.limitedSource);
      }
      setSource(prepared);
    }).catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : '无法读取图片，请重新选择。');
    });
    return () => {
      alive.current = false;
      disposed = true;
      drag.current = null;
      if (draft) URL.revokeObjectURL(draft.url);
    };
  }, [file, initialWindowRatio, empty]);

  // 常驻控件加载时不抢焦点或让设置页滚动；只有新上传时将焦点交给画面。
  useEffect(() => { if (source && file) frame.current?.focus(); }, [source, file]);

  /** 指针捕获保证拖出框外后仍可顺畅调整；坐标按框尺寸归一化，不受缩放/DPI 影响。 */
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (disabled || savingRef.current || !event.isPrimary || event.button !== 0) return;
    const bounds = (imagePlane.current ?? event.currentTarget).getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height, view };
    event.preventDefault();
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const previous = drag.current;
    if (!previous || previous.id !== event.pointerId || !source || savingRef.current || externalBusy) return;
    const next = panCropView(source, ratio, previous.view,
      (event.clientX - previous.x) / previous.width, (event.clientY - previous.y) / previous.height);
    // 每次移动从已限制的边缘位置继续，反向拖动不需要“偿还”越界距离。
    drag.current = { ...previous, x: event.clientX, y: event.clientY, view: next };
    setView(next);
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function changeZoom(zoom: number) {
    if (!source || savingRef.current || externalBusy) return;
    drag.current = null;
    setView(previous => normalizeCropView(source, ratio, { ...previous, zoom }));
  }

  /** 同样支持键盘操作：方向键移动图片，Shift 加速，+/- 缩放，Home 居中复位。 */
  function adjustWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!source || disabled || savingRef.current) return;
    const step = event.shiftKey ? .1 : .02;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (deltas[event.key]) {
      const [x, y] = deltas[event.key];
      setView(previous => panCropView(source, ratio, previous, x, y));
    } else if (event.key === '+' || event.key === '=') changeZoom(view.zoom + .1);
    else if (event.key === '-') changeZoom(view.zoom - .1);
    else if (event.key === 'Home') setView(INITIAL_CROP_VIEW);
    else return;
    event.preventDefault();
  }

  async function applyCrop() {
    if (!source || !rect || disabled || !hasChanges || savingRef.current) return;
    savingRef.current = true;
    onSavingChange?.(true);
    drag.current = null;
    setSaving(true);
    setError('');
    try {
      const croppedFile = await exportWallpaperCrop(source, rect);
      const current: CropSettings = { ratio, view: normalizedView, fit };
      const saved = await chooseClientWallpaper(croppedFile, fit, { source, crop: current, limitedSource });
      if (!alive.current) return;
      if (saved) {
        // 已保存的图片不退出编辑器：更新基线后可立即继续调整，或还原到本次保存的画面。
        setBaseline(current);
        setSavedRatio(ratioKey === 'saved' ? ratio : null);
        notify('壁纸画面已保存并应用。', 'success');
        if (file) onClose?.();
      }
      else setError(readClientAppearance().error ?? '壁纸暂时无法保存，请稍后重试。');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '裁剪失败，请重试。');
    } finally {
      savingRef.current = false;
      onSavingChange?.(false);
      if (alive.current) setSaving(false);
    }
  }

  /** 丢弃本地草稿只还原控件，不写数据库、不触碰全局壁纸或重新解码原图。 */
  function restoreSavedSettings() {
    if (!baseline || disabled || savingRef.current) return;
    drag.current = null;
    const matchingRatio = ratios.find(option => option.value === baseline.ratio);
    setSavedRatio(matchingRatio && matchingRatio.key !== 'saved' ? null : baseline.ratio);
    setRatioKey(matchingRatio?.key ?? 'saved');
    setRatio(baseline.ratio);
    setView({ ...baseline.view });
    setFit(baseline.fit);
    setError('');
    notify('已还原到上次保存的壁纸画面。');
  }

  const loading = initializing || (!empty && !source && !error);
  const previewCaption = empty && !initializing ? '默认背景'
    : !source ? error ? '图片无法载入' : '正在准备图片…' : hasChanges ? '未保存效果' : '已应用画面';
  // 正式保存与还原始终放在标题栏，不能因侧栏变长而落到页面底部。
  const cropActions = !empty && <div className="wallpaper-crop-actions"><button type="button" className="outlined-button"
    disabled={saving || externalBusy || (!file && (disabled || !hasChanges))} onClick={file ? onClose : restoreSavedSettings}>
    {file ? '取消更换' : '还原已保存画面'}</button>
    <button type="button" className="primary-button" disabled={disabled || !hasChanges} onClick={() => void applyCrop()}>
      <Icon name={saving ? 'refresh' : 'check'} size={15} />{saving ? '正在保存…' : file ? '应用此区域' : '保存画面'}</button></div>;

  return <div className="wallpaper-crop-editor" aria-label="工作区壁纸编辑器">
    <header className="wallpaper-crop-heading">
      {heading ?? <h2>工作区外观</h2>}
      <div className="wallpaper-crop-heading-actions">
        {cropActions}
      </div>
    </header>
    <div className="wallpaper-crop-main">
      <h3 className="wallpaper-preview-heading"><AccentIcon icon="monitor" tone="blue" size={15} />效果预览</h3>
      <div ref={frame} className="wallpaper-crop-frame" style={{
        '--crop-ratio': ratio,
        // 交互框与模拟窗口共用比例，避免外层被网格拉高后产生可聚焦/可拖动的空白区域。
        '--appearance-preview-window-ratio': windowRatio,
      } as CSSProperties} aria-busy={loading}
          tabIndex={disabled ? -1 : 0} role="group" aria-label={empty ? '工作区壁纸预览，选择壁纸后可调整画面' : '工作区壁纸预览，可拖动调整图片位置'} aria-disabled={empty ? undefined : disabled} aria-describedby={empty ? undefined : 'wallpaper-crop-keyboard'}
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}
          onLostPointerCapture={() => { drag.current = null; }} onKeyDown={adjustWithKeyboard}>
        <WallpaperWorkspacePreview source={source} rect={rect} fit={fit} transparency={transparency} protection={protection}
          imagePlaneRef={imagePlane} windowRatio={windowRatio} caption={previewCaption}
          emptyState={empty && !initializing ? { onSelect: onSelectWallpaper, disabled: externalBusy || saving } : undefined} />
      </div>
      {/* 删除可见的底部提示，但保留预览的读屏操作说明与键盘支持。 */}
      <p id="wallpaper-crop-keyboard" className="visually-hidden">可拖动预览调整位置；方向键移动，Shift 加速，+ / − 缩放，Home 重置。</p>
    </div>
    <aside className="wallpaper-crop-controls" aria-label="壁纸调整">
      <div className="wallpaper-source-control">
        <h3><AccentIcon icon="palette" tone="blue" size={15} />背景设置<Badge tone="cyan" icon="monitor">本地壁纸</Badge></h3>
        {/* 直接读取原图作铺满式缩略背景；入口自身的适配不改变左侧选区或保存数据。 */}
        <div className="wallpaper-source-thumbnail" data-empty={!source} aria-busy={loading}>
          {source ? source.kind === 'video'
            ? <WallpaperVideo className="wallpaper-source-image" src={source.url} playing={false} />
            : <img className="wallpaper-source-image" src={source.url} alt="当前壁纸原图缩略图" draggable={false} />
            : <span className="wallpaper-source-placeholder"><Icon name="file" size={24} />{loading ? '正在读取壁纸…' : error ? '请选择其他壁纸' : '图片 / GIF / WebP · 10 MB；MP4 · 100 MB'}</span>}
          <div className="wallpaper-source-actions">{fileAction}</div>
          {resetAction && <div className="wallpaper-source-remove">{resetAction}</div>}
        </div>
      </div>
      <p className="wallpaper-crop-help" role="note" title={source?.kind === 'video'
        ? '视频静音循环，窗口最小化或不可见时暂停，失焦仍播放。推荐 H.264 编码 MP4。比例、缩放和位置仅调整显示区域。'
        : '图片和动态图最大 10 MB；MP4 最大 100 MB，推荐 H.264 编码。GIF / 动态 WebP 保留动画。'}>
        支持 PNG / JPG / GIF / WebP / MP4
      </p>
      {!empty && <>
      <fieldset className="wallpaper-crop-ratios" disabled={disabled}><legend><span className="appearance-control-label"><Icon name="aspectRatio" size={16} />画面比例</span></legend>
        <div>{ratios.map(option => <button key={option.key} type="button" aria-pressed={ratioKey === option.key}
          className={ratioKey === option.key ? 'selected' : ''} onClick={() => {
            if (disabled || savingRef.current) return;
            drag.current = null;
            setRatioKey(option.key);
            setRatio(option.value);
            // 固定比例（例如 1:1）默认完整显示，避免刚裁好的选区又被 cover 裁成窗口比例。
            setFit(option.key === 'window' ? 'cover' : 'contain');
            if (source) setView(previous => normalizeCropView(source, option.value, previous));
          }}>{option.label}{ratioKey === option.key && <Icon name="check" size={12} className="appearance-choice-check" />}</button>)}</div></fieldset>
      <div className="wallpaper-crop-zoom-control">
      <div className="wallpaper-crop-zoom-heading"><label htmlFor="wallpaper-crop-zoom" className="appearance-control-label"><Icon name="search" size={14} />图片缩放</label>
        <output htmlFor="wallpaper-crop-zoom">{Math.round(view.zoom * 100)}%</output>
        <button type="button" className="wallpaper-crop-reset" disabled={disabled} onClick={() => {
          if (disabled || savingRef.current) return;
          drag.current = null;
          setView(INITIAL_CROP_VIEW);
        }} title="恢复居中位置和 100% 缩放"><Icon name="refresh" size={13} />重置</button></div>
      <div className="wallpaper-crop-zoom"><button type="button" aria-label="缩小图片" disabled={disabled || view.zoom <= 1}
        onClick={() => changeZoom(view.zoom - .1)}><Icon name="minimize" size={15} /></button>
        <input id="wallpaper-crop-zoom" className="appearance-slider" type="range" min={1} max={MAX_CROP_ZOOM} step={.01}
          value={view.zoom} disabled={disabled} onChange={event => changeZoom(Number(event.target.value))} />
        <button type="button" aria-label="放大图片" disabled={disabled || view.zoom >= MAX_CROP_ZOOM}
          onClick={() => changeZoom(view.zoom + .1)}><Icon name="plus" size={15} /></button></div>
      </div>
      </>}
      {surfaceControls}
      {!empty && <WallpaperFitControl id="crop-fit" compact value={fit} disabled={disabled} onChange={nextFit => {
        if (!disabled && !savingRef.current) setFit(nextFit);
      }} />}
      {readabilityControl}
      {limitedSource && <p className="wallpaper-crop-help" role="note">旧版图片已裁掉的部分无法恢复；更换原图后可保留全部区域。</p>}
    </aside>
  </div>;
}
