import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/state/wallpaperCrop.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(globals = {}) {
  const context = vm.createContext({ exports: {}, Error, File, Blob, ...globals });
  vm.runInContext(compiled, context);
  return context.exports;
}
const api = load();
const centered = { zoom: 1, centerX: .5, centerY: .5 };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .00001, `${actual} != ${expected}`);

test('GIF/WebP 动画与 MP4 调整选区只保留原文件，不解码 Canvas 或导出静态帧', async () => {
  for (const [kind, type] of [['animated', 'image/gif'], ['animated', 'image/webp'], ['video', 'video/mp4']]) {
    const blob = new Blob(['original animation bytes'], { type });
    const source = { width: 1920, height: 1080, url: 'blob:dynamic', name: 'moving', kind, blob };
    const rect = api.wallpaperCropRect(source, 1, { zoom: 2, centerX: .5, centerY: .5 });
    const file = await api.exportWallpaperCrop(source, rect);
    assert.equal(file.type, type); assert.equal(file.name, source.name);
    assert.deepEqual(await file.arrayBuffer(), await blob.arrayBuffer());
    await assert.rejects(() => api.exportWallpaperCrop({ ...source, blob: undefined }, rect), /原文件丢失/);
  }
});

test('横图铺满与竖图居中裁剪使用同一原图坐标；缩放只缩小选区', () => {
  const landscape = api.wallpaperCropRect({ width: 1920, height: 1080 }, 16 / 9, centered);
  close(landscape.x, 0); close(landscape.y, 0);
  close(landscape.width, 1920); close(landscape.height, 1080);
  const portrait = api.wallpaperCropRect({ width: 1080, height: 1920 }, 16 / 9, centered);
  close(portrait.x, 0); close(portrait.y, 656.25);
  close(portrait.width, 1080); close(portrait.height, 607.5);
  const zoomed = api.wallpaperCropRect({ width: 1920, height: 1080 }, 16 / 9, { ...centered, zoom: 2 });
  close(zoomed.x, 480); close(zoomed.y, 270);
  close(zoomed.width, 960); close(zoomed.height, 540);
});

test('各种比例、缩放与越界位置均限制在原图内；归位不改变已选区域', () => {
  for (const image of [{ width: 1920, height: 1080 }, { width: 800, height: 1800 }, { width: 8192, height: 3900 }]) {
    for (const ratio of [.5, 1, 4 / 3, 16 / 10, 16 / 9, 3]) {
      for (const zoom of [0, 1, 1.4, 4, 99, Number.NaN]) {
        for (const centerX of [-2, 0, .5, 1, 4]) {
          for (const centerY of [-2, .5, 4]) {
            const view = { zoom, centerX, centerY };
            const rect = api.wallpaperCropRect(image, ratio, view);
            assert.ok(rect.x >= 0 && rect.y >= 0);
            assert.ok(rect.x + rect.width <= image.width + .00001);
            assert.ok(rect.y + rect.height <= image.height + .00001);
            close(rect.width / rect.height, ratio);
            const normalized = api.normalizeCropView(image, ratio, view);
            assert.ok(normalized.zoom >= 1 && normalized.zoom <= 4);
            const after = api.wallpaperCropRect(image, ratio, normalized);
            for (const key of ['x', 'y', 'width', 'height']) close(rect[key], after[key]);
          }
        }
      }
    }
  }
});

test('按预览尺寸归一化拖动，方向正确；越界后反向移动立即生效', () => {
  const image = { width: 2000, height: 1000 }, ratio = 4 / 3, view = { ...centered, zoom: 2 };
  const before = api.wallpaperCropRect(image, ratio, view);
  const moved = api.wallpaperCropRect(image, ratio, api.panCropView(image, ratio, view, .1, -.2));
  close(moved.x, before.x - before.width * .1);
  close(moved.y, before.y + before.height * .2);
  const edge = api.panCropView(image, ratio, view, 20, 20);
  close(api.wallpaperCropRect(image, ratio, edge).x, 0);
  close(api.wallpaperCropRect(image, ratio, edge).y, 0);
  const reversed = api.wallpaperCropRect(image, ratio, api.panCropView(image, ratio, edge, -.1, -.1));
  assert.ok(reversed.x > 0 && reversed.y > 0);
});

test('导出尺寸不放大小图，最大边 3840；非法尺寸或比例不能产生选区', () => {
  const small = api.cropOutputSize({ x: 0, y: 0, width: 17, height: 9 });
  assert.equal(small.width, 17); assert.equal(small.height, 9);
  const large = api.cropOutputSize({ x: 0, y: 0, width: 8000, height: 3000 });
  assert.equal(large.width, 3840); assert.equal(large.height, 1440);
  for (const ratio of [0, -1, Number.NaN, Infinity]) {
    assert.throws(() => api.wallpaperCropRect({ width: 20, height: 10 }, ratio, centered), /无效/);
  }
  assert.throws(() => api.wallpaperCropRect({ width: 0, height: 10 }, 1, centered), /无效/);
});

/** 捕获 Canvas 原图坐标和编码结果，不打开窗口，不修改用户壁纸存储。 */
function exporter({ type = 'image/webp', decodeFails = false, missingContext = false, missingBlob = false } = {}) {
  const state = { draw: null, canvas: null, context: {}, allocated: 0 };
  const api = load({
    Image: class { async decode() { if (decodeFails) throw new Error('decode'); } },
    document: {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        state.allocated++;
        state.context.drawImage = (...args) => { state.draw = args; };
        state.canvas = {
          getContext: () => missingContext ? null : state.context,
          toBlob(callback, format, quality) {
            assert.equal(format, 'image/webp');
            assert.equal(quality, .94);
            callback(missingBlob ? null : new Blob(['raster'], { type }));
          },
        };
        return state.canvas;
      },
    },
  });
  return { api, state };
}
const image = { width: 8192, height: 4000, url: 'blob:trusted-draft', name: 'cat.photo.jpg' };
const rect = { x: 80, y: 300, width: 8000, height: 3000 };

test('Canvas 按原图选区导出，预览与保存坐标一致，释放像素缓冲且使用实际 MIME', async () => {
  for (const [type, extension] of [['image/webp', 'webp'], ['image/png', 'png']]) {
    const env = exporter({ type });
    const file = await env.api.exportWallpaperCrop(image, rect);
    assert.equal(env.state.draw[0].src, image.url);
    assert.deepEqual(env.state.draw.slice(1), [80, 300, 8000, 3000, 0, 0, 3840, 1440]);
    assert.equal(env.state.context.imageSmoothingEnabled, true);
    assert.equal(env.state.context.imageSmoothingQuality, 'high');
    assert.equal(file.name, `cat.photo-wallpaper.${extension}`);
    assert.equal(file.type, type);
    assert.equal(env.state.canvas.width, 0);
    assert.equal(env.state.canvas.height, 0);
  }
});

test('非法选区、解码、绘图或编码失败明确报错；失败也清理 Canvas', async () => {
  const invalid = exporter();
  for (const patch of [{ x: -1 }, { y: -1 }, { width: 0 }, { height: Infinity }, { x: 300 }]) {
    await assert.rejects(() => invalid.api.exportWallpaperCrop(image, { ...rect, ...patch }), /超出原图/);
  }
  assert.equal(invalid.state.allocated, 0);
  await assert.rejects(() => exporter({ decodeFails: true }).api.exportWallpaperCrop(image, rect), /无法读取/);
  for (const options of [{ missingContext: true }, { missingBlob: true }]) {
    const env = exporter(options);
    await assert.rejects(() => env.api.exportWallpaperCrop(image, rect), /无法处理|导出失败/);
    assert.equal(env.state.canvas.width, 0);
    assert.equal(env.state.canvas.height, 0);
  }
});
