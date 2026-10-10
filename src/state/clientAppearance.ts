/** 客户端外观独立于后端地址；图片保存为本地 Blob，不上传到 Java 或远程服务器。 */
export const DEFAULT_PANEL_TRANSPARENCY = 25;
export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
const TRANSPARENCY_KEY = 'agent-ssh-panel-transparency-v1';
const READABILITY_KEY = 'agent-ssh-wallpaper-readability-v1';
const DATABASE_NAME = 'agent-ssh-appearance';
const STORE_NAME = 'wallpapers';
const WALLPAPER_KEY = 'current';

export type WallpaperFit = 'cover' | 'contain';
/** 选区相对于原图保存；不用窗口像素坐标，重开客户端或调整窗口后仍能恢复。 */
export type WallpaperCropSelection = {
  ratio: number;
  view: { zoom: number; centerX: number; centerY: number };
};
type WallpaperSource = { blob: Blob; name: string; width: number; height: number; limited?: boolean };
type SavedWallpaper = WallpaperSource & {
  fit?: WallpaperFit;
  /** 原图与显示用的裁剪图同一事务保存，避免二次裁剪不断损失画面和清晰度。 */
  original?: WallpaperSource;
  crop?: WallpaperCropSelection;
};
/** 裁剪草稿只存在内存；使用方必须在取消、替换或卸载时释放 url。 */
export type PreparedWallpaper = { blob: Blob; url: string; name: string; width: number; height: number };
export type PreparedWallpaperEdit = PreparedWallpaper & {
  crop: WallpaperCropSelection;
  fit: WallpaperFit;
  /** 老版本没有原图，只能以已裁剪图片继续编辑；不能恢复先前删除的区域。 */
  limitedSource: boolean;
};
export type WallpaperCropSave = {
  source: PreparedWallpaper;
  crop: WallpaperCropSelection;
  limitedSource?: boolean;
};
export type ClientAppearance = {
  ready: boolean;
  busy: boolean;
  error: string | null;
  wallpaperUrl: string | null;
  wallpaperName: string;
  width: number;
  height: number;
  /** 用户选择的透明度；可读性保护开启时另保留最低背景遮罩。 */
  transparency: number;
  readabilityProtection: boolean;
  /** cover 铺满窗口会裁边；contain 完整显示保留选区比例，剩余部分使用主题底色。 */
  wallpaperFit: WallpaperFit;
};

/** 旧版本未保存此偏好时默认保护文字可读性，不改变用户已经选择的透明度值。 */
function initialReadabilityProtection(): boolean {
  try { return localStorage.getItem(READABILITY_KEY) !== 'false'; } catch { return true; }
}

/** 低透明度保持原图；40% 之后逐渐柔化纹理，上限 4px，禁止模糊前景文字。 */
export function wallpaperReadability(transparency: number, enabled: boolean) {
  const value = Number.isFinite(transparency) ? Math.min(100, Math.max(0, transparency)) : DEFAULT_PANEL_TRANSPARENCY;
  return { strengthenText: enabled && value >= 50, blur: enabled ? Math.max(0, (value - 40) / 60) * 4 : 0 };
}

function initialTransparency(): number {
  try {
    const raw = localStorage.getItem(TRANSPARENCY_KEY);
    if (raw === null || raw.trim() === '') return DEFAULT_PANEL_TRANSPARENCY;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : DEFAULT_PANEL_TRANSPARENCY;
  } catch { return DEFAULT_PANEL_TRANSPARENCY; }
}

type AppearanceStore = {
  snapshot: ClientAppearance;
  initialization?: Promise<void>;
  subscribers: Set<() => void>;
};

/**
 * 每个 WebView 只保留一份运行时状态，而不是每次模块求值都创建一份。
 * Vite 热更新可能保留旧根背景订阅，同时重新加载设置页使用的模块；若状态是
 * 模块局部变量，就会出现“背景有壁纸，设置页却认为没有图片”的分裂。
 *
 * 这里同时保留初始化 Promise、订阅集合和 Blob URL，使新旧消费者始终同步。
 * 这只是当前页面的内存，不是新的持久化目录：真正重启后仍从 IndexedDB 恢复，
 * 不影响后端配置，也不与其他 WebView/远程连接共享图片。
 */
const appearanceGlobal = globalThis as typeof globalThis & { __agentSshClientAppearanceV1?: AppearanceStore };
const store = appearanceGlobal.__agentSshClientAppearanceV1 ??= {
  snapshot: {
    ready: false, busy: false, error: null, wallpaperUrl: null, wallpaperName: '', width: 0, height: 0,
    transparency: initialTransparency(),
    readabilityProtection: initialReadabilityProtection(),
    wallpaperFit: 'cover',
  },
  subscribers: new Set<() => void>(),
};
// 热更新保留的旧快照可能还没有新增字段；只补默认值，不清空图片或重建订阅。
if (!store.snapshot.wallpaperFit) store.snapshot = { ...store.snapshot, wallpaperFit: 'cover' };
export const readClientAppearance = () => store.snapshot;
export function subscribeClientAppearance(listener: () => void) {
  store.subscribers.add(listener);
  return () => { store.subscribers.delete(listener); };
}
function publish(patch: Partial<ClientAppearance>) {
  // 发布新快照以满足 useSyncExternalStore 的引用比较，同时通知旧模块留下的订阅。
  store.snapshot = { ...store.snapshot, ...patch };
  store.subscribers.forEach(listener => listener());
}
function failure(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === 'QuotaExceededError') return '客户端存储空间不足，请选择更小的图片。';
  return cause instanceof Error ? cause.message : '无法保存客户端外观，请重试。';
}

/** 每次事务结束即关闭数据库，不长时间占用连接；图片不能塞进容量较小的 localStorage。 */
function openWallpaperDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    let abandoned = false;
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE_NAME); };
    request.onerror = () => reject(request.error ?? new Error('无法打开客户端壁纸存储。'));
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('壁纸存储被其他页面占用，请关闭其他客户端页面后重试。'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

/** 必须等事务提交后才更新界面，request.onsuccess 不等于数据已持久化成功。 */
async function wallpaperTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openWallpaperDatabase();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => { database.close(); resolve(request.result); };
      transaction.onabort = () => { database.close(); reject(transaction.error ?? request.error ?? new Error('保存壁纸失败。')); };
      transaction.onerror = () => { /* 默认错误行为会中止事务，由 onabort 统一返回错误。 */ };
    } catch (cause) { database.close(); reject(cause); }
  });
}

/** 使用浏览器解码验证实际图片；临时 URL 在成功和失败时都会释放。 */
async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { throw new Error('图片无法解码，请选择有效的 PNG、JPG 或 WebP 图片。'); }
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000) {
      throw new Error('图片尺寸过大：单边不能超过 8192 像素，总像素不能超过 3200 万。');
    }
    return { width, height };
  } finally { URL.revokeObjectURL(url); }
}

/** 读取文件签名而不是只相信扩展名，拒绝 SVG/HTML 等非静态位图内容。 */
async function rasterBlob(file: Blob): Promise<Blob> {
  if (!file.size || file.size > MAX_WALLPAPER_BYTES) throw new Error('请选择非空图片，文件大小不能超过 10 MB。');
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = (text: string, offset: number) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = signature('RIFF', 0) && signature('WEBP', 8);
  const type = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : null;
  if (!type) throw new Error('仅支持 PNG、JPG 和 WebP 图片，不支持 SVG、GIF 或其他文件。');
  return file.slice(0, file.size, type);
}

/** 先校验、解码再进入裁剪；此阶段不保存图片，也不改变当前壁纸。 */
export async function prepareClientWallpaper(file: File): Promise<PreparedWallpaper> {
  const blob = await rasterBlob(file);
  const dimensions = await imageDimensions(blob);
  return { blob, url: URL.createObjectURL(blob), name: file.name, ...dimensions };
}

/** 不信任持久化中的选区字段；损坏的旧选区可退回完整原图，不影响已显示的壁纸。 */
function validCropSelection(value: WallpaperCropSelection | undefined): value is WallpaperCropSelection {
  const view = value?.view;
  return !!view && Number.isFinite(value.ratio) && value.ratio > 0
    && Number.isFinite(view.zoom) && view.zoom >= 1 && view.zoom <= 4
    && Number.isFinite(view.centerX) && view.centerX >= 0 && view.centerX <= 1
    && Number.isFinite(view.centerY) && view.centerY >= 0 && view.centerY <= 1;
}

/**
 * 从已保存的原图重新编辑，不读取最初文件路径，也不改变当前壁纸。
 * 旧记录只有裁剪图时明确标记受限来源；即使再次保存也不假装找回了原图。
 * 调用方取消编辑时只需释放返回的 URL，无需回滚数据库。
 */
export async function prepareSavedClientWallpaper(): Promise<PreparedWallpaperEdit> {
  await initializeClientAppearance();
  if (store.snapshot.busy) throw new Error('外观正在保存，请稍后重新裁剪。');
  const saved = await wallpaperTransaction<SavedWallpaper | undefined>('readonly', db => db.get(WALLPAPER_KEY));
  if (!saved) throw new Error('未找到已保存的壁纸，请重新选择图片。');
  const original = saved.original ?? saved;
  if (!(original.blob instanceof Blob) || typeof original.name !== 'string') {
    throw new Error('已保存的原图无效，请重新选择原图；当前壁纸未被修改。');
  }
  const blob = await rasterBlob(original.blob);
  const dimensions = await imageDimensions(blob);
  const crop = saved.original && validCropSelection(saved.crop)
    ? { ratio: saved.crop.ratio, view: { ...saved.crop.view } }
    : { ratio: dimensions.width / dimensions.height, view: { zoom: 1, centerX: .5, centerY: .5 } };
  return {
    blob, url: URL.createObjectURL(blob), name: original.name, ...dimensions, crop,
    fit: saved.fit === 'contain' ? 'contain' : 'cover',
    limitedSource: !saved.original || original.limited === true,
  };
}

/** App 与设置页共享一次初始化，不能由晚到的读取覆盖用户刚选的新图片。 */
export function initializeClientAppearance(): Promise<void> {
  if (!store.initialization) store.initialization = (async () => {
    try {
      const saved = await wallpaperTransaction<SavedWallpaper | undefined>('readonly', store => store.get(WALLPAPER_KEY));
      if (!saved) { publish({ ready: true }); return; }
      if (!(saved.blob instanceof Blob) || saved.blob.size > MAX_WALLPAPER_BYTES
          || !['image/png', 'image/jpeg', 'image/webp'].includes(saved.blob.type) || typeof saved.name !== 'string') {
        throw new Error('已保存的壁纸无效，请重新选择图片或恢复默认背景。');
      }
      const dimensions = await imageDimensions(saved.blob);
      publish({ ready: true, wallpaperUrl: URL.createObjectURL(saved.blob), wallpaperName: saved.name,
        wallpaperFit: saved.fit === 'contain' ? 'contain' : 'cover', ...dimensions });
    } catch (cause) { publish({ ready: true, error: failure(cause) }); }
  })();
  return store.initialization;
}

/**
 * 图片在替换成功前保持原样；失败不清空旧壁纸，界面展示真实存储/解码错误。
 * 仅事务提交并发布新壁纸后返回 true，裁剪页不能在保存失败时关闭草稿。
 */
export async function chooseClientWallpaper(file: File, fit: WallpaperFit = 'cover', edit?: WallpaperCropSave): Promise<boolean> {
  await initializeClientAppearance();
  if (store.snapshot.busy) return false;
  publish({ busy: true, error: null });
  let nextUrl: string | null = null;
  try {
    const blob = await rasterBlob(file);
    const dimensions = await imageDimensions(blob);
    if (fit !== 'cover' && fit !== 'contain') throw new Error('请选择有效的壁纸显示方式。');
    if (edit && (!validCropSelection(edit.crop) || typeof edit.source.name !== 'string'
        || !(edit.source.blob instanceof Blob))) throw new Error('裁剪草稿无效，请重新选择图片。');
    // 从编辑用原图导出显示图，但始终保留原始像素；不把本次裁剪结果当成下一次的原图。
    const originalBlob = edit ? await rasterBlob(edit.source.blob) : blob;
    const originalDimensions = edit ? await imageDimensions(originalBlob) : dimensions;
    const original: WallpaperSource = {
      blob: originalBlob, name: edit ? edit.source.name : file.name, ...originalDimensions,
      limited: edit?.limitedSource === true,
    };
    const crop = edit ? { ratio: edit.crop.ratio, view: { ...edit.crop.view } } : undefined;
    nextUrl = URL.createObjectURL(blob);
    // 一份记录原子替换：存储不足或提交失败时，原图、选区、显示图都维持旧版本。
    await wallpaperTransaction('readwrite', store => store.put({ blob, name: file.name, fit, ...dimensions, original, crop } satisfies SavedWallpaper, WALLPAPER_KEY));
    const previousUrl = store.snapshot.wallpaperUrl;
    publish({ wallpaperUrl: nextUrl, wallpaperName: file.name, wallpaperFit: fit, ...dimensions });
    nextUrl = null;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    return true;
  } catch (cause) { publish({ error: failure(cause) }); return false; }
  finally {
    if (nextUrl) URL.revokeObjectURL(nextUrl);
    publish({ busy: false });
  }
}

/**
 * 显示方式随当前壁纸一起持久化；不重新裁剪、不重新解码、不替换 Blob URL。
 * 保存失败仍使用原方式，避免界面提示已保存但重启后退回旧显示效果。
 */
export async function setClientWallpaperFit(fit: WallpaperFit): Promise<void> {
  if (fit !== 'cover' && fit !== 'contain') return;
  await initializeClientAppearance();
  if (store.snapshot.busy || !store.snapshot.wallpaperUrl || store.snapshot.wallpaperFit === fit) return;
  publish({ busy: true, error: null });
  try {
    const saved = await wallpaperTransaction<SavedWallpaper | undefined>('readonly', db => db.get(WALLPAPER_KEY));
    if (!saved) throw new Error('未找到已保存的壁纸，请重新选择图片。');
    await wallpaperTransaction('readwrite', db => db.put({ ...saved, fit }, WALLPAPER_KEY));
    publish({ wallpaperFit: fit });
  } catch (cause) { publish({ error: failure(cause) }); }
  finally { publish({ busy: false }); }
}

/** 只改变背景色的 alpha；不设置整个窗口/容器 opacity，也不改终端连接或字体。 */
export function setClientPanelTransparency(value: number): void {
  if (!Number.isFinite(value) || store.snapshot.busy) return;
  const transparency = Math.min(100, Math.max(0, Math.round(value)));
  try {
    localStorage.setItem(TRANSPARENCY_KEY, String(transparency));
    publish({ transparency, error: null });
  } catch (cause) { publish({ error: failure(cause) }); }
}

/** 与透明度同样即时保存；关闭后尊重用户的完全透明选择，不增加背景保护层。 */
export function setClientReadabilityProtection(enabled: boolean): void {
  if (store.snapshot.busy) return;
  try {
    localStorage.setItem(READABILITY_KEY, String(enabled));
    publish({ readabilityProtection: enabled, error: null });
  } catch (cause) { publish({ error: failure(cause) }); }
}

/** 恢复的是壁纸与背景透明度，不重置主题、远程连接或后端 YAML。 */
export async function resetClientAppearance(): Promise<void> {
  await initializeClientAppearance();
  if (store.snapshot.busy) return;
  publish({ busy: true, error: null });
  const previousTransparency = store.snapshot.transparency;
  let preferenceWritten = false;
  try {
    localStorage.setItem(TRANSPARENCY_KEY, String(DEFAULT_PANEL_TRANSPARENCY));
    preferenceWritten = true;
    await wallpaperTransaction('readwrite', store => store.delete(WALLPAPER_KEY));
    const previousUrl = store.snapshot.wallpaperUrl;
    publish({ wallpaperUrl: null, wallpaperName: '', width: 0, height: 0, transparency: DEFAULT_PANEL_TRANSPARENCY, wallpaperFit: 'cover' });
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  } catch (cause) {
    // 删除事务失败时尽量恢复原偏好，避免下一次启动与当前预览不一致。
    if (preferenceWritten) {
      try { localStorage.setItem(TRANSPARENCY_KEY, String(previousTransparency)); } catch { /* 保留原始失败原因供用户重试。 */ }
    }
    publish({ error: failure(cause) });
  } finally { publish({ busy: false }); }
}
