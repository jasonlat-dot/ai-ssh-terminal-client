import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

function load(path, requireModule = () => { throw new Error('Unexpected import'); }, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, ...globals });
  vm.runInContext(compiled, context); return context.exports;
}
function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    listeners, addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name), dispatch(name) { listeners.get(name)?.(); },
  });
}

test('视频静音循环；仅不可见或离开视口时暂停，普通失焦继续；卸载删除全部监听', async () => {
  const document = events({ hidden: false, hasFocus: () => true }), window = events();
  let observer;
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(video) { this.target = video; }
    disconnect() { this.disconnected = true; }
  }
  const video = events({ paused: true, plays: 0, pauses: 0,
    play() { this.plays++; this.paused = false; return Promise.resolve(); },
    pause() { this.pauses++; this.paused = true; },
  });
  const api = load('state/wallpaperPlayback.ts', undefined, { document, window, IntersectionObserver });
  const release = api.bindWallpaperPlayback(video);
  await Promise.resolve();
  assert.equal(video.muted, true); assert.equal(video.loop, true); assert.equal(video.playsInline, true);
  assert.equal(video.plays, 1);
  document.hidden = true; document.dispatch('visibilitychange'); assert.equal(video.paused, true);
  document.hidden = false; document.dispatch('visibilitychange'); await Promise.resolve(); assert.equal(video.plays, 2);
  document.hasFocus = () => false;
  window.dispatch('blur'); assert.equal(video.paused, false, '录屏工具获得焦点不暂停视频');
  document.dispatch('visibilitychange'); assert.equal(video.plays, 2);
  window.dispatch('focus'); await Promise.resolve(); assert.equal(video.plays, 2);
  assert.equal(window.listeners.size, 0, '不监听 focus/blur');
  observer.callback([{ isIntersecting: false }]); assert.equal(video.paused, true);
  observer.callback([{ isIntersecting: true }]); await Promise.resolve(); assert.equal(video.plays, 3);
  release(); assert.equal(video.paused, true);
  assert.equal(observer.disconnected, true); assert.equal(window.listeners.size, 0);
  assert.equal(document.listeners.size, 0); assert.equal(video.listeners.size, 0);
});

test('播放 Promise 晚到不在卸载后播放；缩略图保持暂停，自动播放拒绝不抛异常', async () => {
  const document = events({ hidden: false, hasFocus: () => true }), window = events();
  const api = load('state/wallpaperPlayback.ts', undefined, { document, window });
  let resolve;
  const video = events({ paused: true,
    play() { return new Promise(done => { resolve = () => { this.paused = false; done(); }; }); },
    pause() { this.paused = true; },
  });
  const release = api.bindWallpaperPlayback(video); release(); resolve(); await Promise.resolve();
  assert.equal(video.paused, true);
  video.play = () => { throw new Error('thumbnail must not play'); };
  const thumbnail = api.bindWallpaperPlayback(video, false);
  window.dispatch('focus'); video.dispatch('loadeddata'); assert.equal(video.paused, true); thumbnail();
  video.play = () => Promise.reject(new Error('autoplay denied'));
  const refused = api.bindWallpaperPlayback(video); await new Promise(resolve => setImmediate(resolve)); refused();
});

test('StrictMode 重挂载后旧播放 Promise 不能暂停同一节点的新播放器', async () => {
  const document = events({ hidden: false, hasFocus: () => true }), window = events();
  const api = load('state/wallpaperPlayback.ts', undefined, { document, window });
  let oldResolve, call = 0;
  const video = events({ paused: true,
    play() {
      if (++call === 1) return new Promise(resolve => { oldResolve = resolve; });
      this.paused = false; return Promise.resolve();
    },
    pause() { this.paused = true; },
  });
  const oldRelease = api.bindWallpaperPlayback(video); oldRelease();
  const newRelease = api.bindWallpaperPlayback(video); await Promise.resolve();
  oldResolve(); await Promise.resolve(); assert.equal(video.paused, false);
  newRelease(); assert.equal(video.paused, true);
});

function dom() {
  const created = [];
  function element(tag = 'div') {
    const node = events({ tagName: tag.toUpperCase(), children: [], dataset: {}, styles: new Map(), paused: true,
      style: { setProperty(key, value) { node.styles.set(key, value); } },
      get isConnected() { return this.root === true || this.parent?.isConnected === true; },
      setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
      append(child) { child.remove(); this.children.push(child); child.parent = this; },
      prepend(child) { child.remove(); this.children.unshift(child); child.parent = this; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; },
      load() { this.loads = (this.loads ?? 0) + 1; }, pause() { this.paused = true; },
    });
    created.push(node); return node;
  }
  const root = element(); root.root = true;
  return { document: { createElement: element }, root, created };
}
test('动态层按相同选区几何显示；调整透明度/比例不重建视频，切换/重置清理旧播放器', () => {
  const env = dom(), bindings = [];
  const geometry = load('state/wallpaperCrop.ts');
  const api = load('state/wallpaperMotion.ts', name => {
    if (name === './wallpaperCrop') return geometry;
    if (name === './wallpaperPlayback') return { bindWallpaperPlayback(video) {
      const binding = { video, disposed: false }; bindings.push(binding);
      return () => { binding.disposed = true; video.pause(); };
    } };
    throw new Error(name);
  }, { document: env.document });
  const motion = api.createWallpaperMotionLayer(env.root);
  const appearance = { wallpaperUrl: 'blob:first', wallpaperKind: 'video', wallpaperFit: 'contain', width: 1920, height: 1080,
    wallpaperCrop: { ratio: 1, view: { zoom: 2, centerX: .5, centerY: .5 } } };
  motion.apply(appearance);
  assert.equal(env.root.children.length, 1);
  const layer = env.root.children[0], plane = layer.children[0], video = plane.children[0];
  assert.equal(video.tagName, 'VIDEO'); assert.equal(video.src, 'blob:first');
  assert.equal(video.muted, true); assert.equal(video.loop, true); assert.equal(video.playsInline, true);
  assert.equal(layer.dataset.fit, 'contain'); assert.equal(layer.styles.get('--motion-ratio'), '1');
  const rect = geometry.wallpaperCropRect(appearance, 1, appearance.wallpaperCrop.view);
  assert.equal(video.style.width, `${1920 / rect.width * 100}%`);
  assert.equal(video.style.top, `${-rect.y / rect.height * 100}%`);
  motion.apply({ ...appearance, transparency: 90, wallpaperFit: 'cover' });
  assert.equal(plane.children[0], video); assert.equal(bindings.length, 1);
  motion.apply({ ...appearance, wallpaperUrl: 'blob:gif', wallpaperKind: 'animated' });
  assert.equal(bindings[0].disposed, true); assert.equal(video.src, undefined); assert.equal(video.loads, 1);
  assert.equal(plane.children[0].tagName, 'IMG'); assert.equal(plane.children[0].src, 'blob:gif');
  motion.apply({ ...appearance, wallpaperKind: 'image' }); assert.equal(env.root.children.length, 0);
  motion.apply(appearance); motion.dispose(); assert.equal(env.root.children.length, 0);
  assert.ok(bindings.every(binding => binding.disposed));
});

test('视频预览复用取景平面，右侧缩略图不自动播放，无声音或视频控件', () => {
  const cache = new Map();
  function requireModule(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return runtime;
    if (name.endsWith('/clientAppearance')) return { wallpaperReadability: () => ({ blur: 0 }) };
    if (name.endsWith('/wallpaperPlayback')) return {};
    if (name === './WallpaperVideo' || name === './Ui') {
      if (!cache.has(name)) cache.set(name, load(`components/${name.slice(2)}.tsx`, requireModule));
      return cache.get(name);
    }
    throw new Error(name);
  }
  const { WallpaperWorkspacePreview } = load('components/WallpaperWorkspacePreview.tsx', requireModule);
  const html = renderToStaticMarkup(React.createElement(WallpaperWorkspacePreview, {
    source: { kind: 'video', url: 'blob:video', width: 1920, height: 1080 },
    rect: { x: 100, y: 100, width: 800, height: 800 }, fit: 'contain', transparency: 70, protection: true, caption: '未保存效果',
  }));
  assert.match(html, /<video[^>]*src="blob:video"/); assert.match(html, /muted=""/);
  assert.match(html, /loop=""/); assert.match(html, /playsInline=""/);
  assert.doesNotMatch(html, /controls|<img/);
  const editor = readFileSync(new URL('../src/components/WallpaperCropEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /className="wallpaper-source-image" src=\{source.url\} playing=\{false\}/);
  const picker = readFileSync(new URL('../src/components/AppearanceSettings.tsx', import.meta.url), 'utf8');
  assert.match(picker, /accept="[^"]*image\/gif[^"]*video\/mp4/);
});
