/** 裁剪坐标始终使用原图像素；预览大小变化不会改变最终选区。 */
export type ImageSize = { width: number; height: number };
export type CropView = { zoom: number; centerX: number; centerY: number };
export type CropRect = { x: number; y: number; width: number; height: number };
export const INITIAL_CROP_VIEW: CropView = { zoom: 1, centerX: .5, centerY: .5 };
export const MAX_CROP_ZOOM = 4;

/**
 * 根据比例与缩放计算原图选区。zoom=1 时取最大可铺满矩形；放大后选区缩小。
 * 中心点为 0–1 的原图相对位置，边缘强制限制在图内，避免拖动后露出空白。
 */
export function wallpaperCropRect(image: ImageSize, ratio: number, view: CropView): CropRect {
  if (![image.width, image.height, ratio].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('图片尺寸或裁剪比例无效。');
  }
  const zoom = Number.isFinite(view.zoom) ? Math.min(MAX_CROP_ZOOM, Math.max(1, view.zoom)) : 1;
  const width = Math.min(image.width, image.height * ratio) / zoom;
  const height = width / ratio;
  const centerX = Number.isFinite(view.centerX) ? view.centerX : .5;
  const centerY = Number.isFinite(view.centerY) ? view.centerY : .5;
  return {
    x: Math.min(image.width - width, Math.max(0, centerX * image.width - width / 2)),
    y: Math.min(image.height - height, Math.max(0, centerY * image.height - height / 2)),
    width, height,
  };
}

/** 将越界中心归位；到达边缘后反向拖动能立即生效，不积累不可见的偏移。 */
export function normalizeCropView(image: ImageSize, ratio: number, view: CropView): CropView {
  const rect = wallpaperCropRect(image, ratio, view);
  return {
    zoom: Number.isFinite(view.zoom) ? Math.min(MAX_CROP_ZOOM, Math.max(1, view.zoom)) : 1,
    centerX: (rect.x + rect.width / 2) / image.width,
    centerY: (rect.y + rect.height / 2) / image.height,
  };
}

/**
 * deltaX/deltaY 是拖动距离占预览宽/高的比例，正值表示向右/下拖动图片。
 * 原图选区因此向相反方向移动；无论预览分辨率如何，保存结果都保持一致。
 */
export function panCropView(image: ImageSize, ratio: number, view: CropView, deltaX: number, deltaY: number): CropView {
  const rect = wallpaperCropRect(image, ratio, view);
  return normalizeCropView(image, ratio, {
    ...view,
    centerX: view.centerX - deltaX * rect.width / image.width,
    centerY: view.centerY - deltaY * rect.height / image.height,
  });
}

/** 最长边限制为 3840px，不放大小图；只保留选区，控制本地存储与解码开销。 */
export function cropOutputSize(rect: CropRect): ImageSize {
  const scale = Math.min(1, 3840 / Math.max(rect.width, rect.height));
  return { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
}

/**
 * 只在用户确认后导出选区。使用已验证的本地 Blob URL，不加载任意网络图片。
 * 不改原文件；新 File 仍须通过现有壁纸校验与 IndexedDB 事务才能正式应用。
 */
export async function exportWallpaperCrop(source: ImageSize & { url: string; name: string }, rect: CropRect): Promise<File> {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
      || rect.x + rect.width > source.width + .001 || rect.y + rect.height > source.height + .001) {
    throw new Error('裁剪区域超出原图，请重置位置后重试。');
  }
  const image = new Image();
  image.src = source.url;
  try { await image.decode(); } catch { throw new Error('无法读取裁剪图片，请重新选择。'); }
  const canvas = document.createElement('canvas');
  const size = cropOutputSize(rect);
  canvas.width = size.width;
  canvas.height = size.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前客户端无法处理图片裁剪。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('裁剪图片导出失败，请重试。')), 'image/webp', .94);
    });
    // 不支持 WebP 的浏览器可能回退到 PNG；扩展名以实际编码结果为准。
    const extension = blob.type === 'image/webp' ? 'webp' : 'png';
    return new File([blob], `${source.name.replace(/\.[^.]+$/, '')}-wallpaper.${extension}`, { type: blob.type });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
