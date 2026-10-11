import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPortal } from 'react-dom';

function loadModule(path, requireModule, globals = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, ...globals });
  vm.runInContext(compiled, context);
  return context.exports;
}

const geometry = loadModule('state/wallpaperCrop.ts', () => { throw new Error('Unexpected geometry import'); });
const textColors = loadModule('state/clientTextColors.ts', () => { throw new Error('Unexpected text color import'); });
const typography = loadModule('state/clientTypography.ts', () => { throw new Error('Unexpected typography import'); });
const appearance = {
  ready: true, busy: false, error: null, wallpaperUrl: 'blob:current', wallpaperName: 'cat-wallpaper.webp',
  width: 1920, height: 1080, transparency: 25, readabilityProtection: true, wallpaperFit: 'cover',
};
const windowSize = { innerWidth: 1920, innerHeight: 1080 };

/** 使用真实 React 服务端渲染，确认已有壁纸的控件直接出现在页面，而非藏在按钮后。 */
function renderAppearance(snapshot) {
  const cache = new Map();
  const api = { wallpaperReadability: () => ({ blur: 0 }) };
  function requireModule(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'react-dom') return { createPortal };
    if (name.endsWith('.css')) return {};
    if (name.endsWith('/clientAppearance')) return api;
    if (name.endsWith('/useClientAppearance')) return { useClientAppearance: () => snapshot };
    if (name.endsWith('/clientTextColors')) return textColors;
    if (name.endsWith('/useClientTextColors')) return { useClientTextColors: () => ({ ...textColors.readClientTextColors(), theme: 'light' }) };
    if (name.endsWith('/clientTypography')) return typography;
    if (name.endsWith('/useClientTypography')) return { useClientTypography: typography.readClientTypography };
    if (name.endsWith('/wallpaperCrop')) return geometry;
    if (name.endsWith('/wallpaperPlayback')) return { bindWallpaperPlayback: () => () => {} };
    if (['./Ui', './Select', './WallpaperCropEditor', './WallpaperFitControl', './WallpaperWorkspacePreview', './TextColorSettings', './TypographySettings', './WallpaperVideo'].includes(name)) {
      if (!cache.has(name)) cache.set(name, loadModule(`components/${name.slice(2)}.tsx`, requireModule, { window: windowSize }));
      return cache.get(name);
    }
    throw new Error(`Unexpected import: ${name}`);
  }
  const { AppearanceSettings } = loadModule('components/AppearanceSettings.tsx', requireModule);
  return renderToStaticMarkup(React.createElement(AppearanceSettings));
}

test('已有壁纸打开外观页即可看到比例、缩放、显示方式，透明度与保护也在同页', () => {
  const html = renderAppearance(appearance);
  assert.match(html, /<legend>[\s\S]*?画面比例<\/span><\/legend>/);
  assert.match(html, /id="wallpaper-crop-zoom"/);
  assert.match(html, /保存画面/);
  assert.match(html, /还原已保存画面/);
  assert.match(html, /id="appearance-transparency"/);
  assert.match(html, /文字可读性保护/);
  assert.match(html, /界面文字颜色/);
  assert.match(html, /主要文字 HEX/);
  assert.match(html, /辅助文字 HEX/);
  assert.match(html, /恢复当前主题文字颜色/);
  assert.match(html, /界面字体/);
  assert.match(html, /正常字体粗细/);
  assert.match(html, /粗体字体粗细/);
  assert.match(html, /id="ui-font-family"[^>]*role="combobox"/);
  const preview = html.match(/<figure class="appearance-preview"[\s\S]*?<\/figure>/)?.[0];
  assert.ok(preview);
  assert.doesNotMatch(preview, /<svg|<aside|<i\b|•••|appearance-preview-(?:bar|workspace|dots|terminal|agent)/);
  assert.doesNotMatch(html, /ssh your-server|AI 助手|连接就绪|远程连接与 AI 协作|Agent SSH/);
  assert.match(html, /<figcaption class="visually-hidden">/);
  assert.doesNotMatch(html, /wallpaper-crop-grid|wallpaper-crop-corners|appearance-picker-copy|cat-wallpaper\.webp/,
    '不能把裁剪框或重复的导出文件信息当作工作区效果预览');
  assert.equal((html.match(/壁纸显示方式<\/span><\/legend>/g) ?? []).length, 1, '不能重复显示两套状态不同的显示方式控件');
  assert.doesNotMatch(html, />重新裁剪<|>取消更换</, '既有图片不需要进入或退出裁剪模式');
});

test('无壁纸时仍提供选择图片与默认预览，不读取不存在的原图', () => {
  const html = renderAppearance({ ...appearance, wallpaperUrl: null, wallpaperName: '' });
  assert.match(html, /选择一张喜欢的图片/);
  assert.match(html, /默认背景/);
  assert.doesNotMatch(html, /id="wallpaper-crop-zoom"/);
});

test('无壁纸预览显示轻装饰、居中上传入口与真实支持格式；初始化和已有图片不显示空状态', () => {
  const html = renderAppearance({ ...appearance, wallpaperUrl: null, wallpaperName: '' });
  const preview = html.match(/<figure class="appearance-preview"[\s\S]*?<\/figure>/)?.[0];
  assert.match(preview, /class="wallpaper-preview-empty"/);
  assert.match(preview, /添加工作区壁纸/);
  assert.match(preview, /选择壁纸/);
  assert.match(preview, /支持 PNG \/ JPG \/ GIF \/ WebP \/ MP4/);
  assert.equal((preview.match(/class="wallpaper-empty-orbit(?: is-opposite)?"/g) ?? []).length, 2);
  assert.match(preview, /class="wallpaper-empty-orbit"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.doesNotMatch(preview, /拖拽|拖曳|拖放|http[s]?:\/\//, '不宣传未实现的拖放上传，也不加载外部装饰图片');
  const pending = renderAppearance({ ...appearance, ready: false, wallpaperUrl: null });
  assert.doesNotMatch(pending, /class="wallpaper-preview-empty"/);
  assert.doesNotMatch(renderAppearance(appearance), /class="wallpaper-preview-empty"/);
  const busy = renderAppearance({ ...appearance, busy: true, wallpaperUrl: null });
  assert.match(busy, /class="primary-button wallpaper-empty-select"[^>]*disabled=""/);
});

test('空状态样式使用主题变量、紧凑窗口适配；上传按钮能接收鼠标且保留键盘焦点反馈', () => {
  const styles = readFileSync(new URL('../src/components/AppearanceSettings.css', import.meta.url), 'utf8');
  assert.match(styles, /\.wallpaper-preview-empty \{[^}]*pointer-events: auto/s);
  assert.match(styles, /--empty-blue: color-mix\(in srgb, var\(--settings-blue\)/);
  assert.match(styles, /\.wallpaper-preview-empty::before \{[^}]*border: 1px dashed/s);
  assert.match(styles, /@container wallpaper-empty \(max-height: 240px\)/);
  assert.match(styles, /\.appearance-settings :is\(button, input\):focus-visible \{[^}]*outline:/);
});

test('外观页左侧为工作区效果，右侧原图入口和参数，不增加额外导航或工作区列表', () => {
  const html = renderAppearance(appearance);
  assert.equal((html.match(/>更换壁纸</g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="恢复默认背景"/g) ?? []).length, 1);
  assert.match(html, /wallpaper-source-thumbnail/);
  assert.match(html, /wallpaper-source-actions/);
  assert.match(html, /<aside class="wallpaper-crop-controls"/);
  assert.doesNotMatch(html, /wallpaper-crop-footer|wallpaper-crop-file|wallpaper-crop-draft|仅此客户端/);
  assert.doesNotMatch(html, /AppearanceWorkspaceOutline|appearance-workspace-outline|推荐背景|背景库|>新建</);
  const styles = readFileSync(new URL('../src/components/AppearanceSettings.css', import.meta.url), 'utf8');
  const editorStyles = readFileSync(new URL('../src/components/WallpaperCropEditor.css', import.meta.url), 'utf8');
  const parentStyles = readFileSync(new URL('../src/components/BackendSettingsDialog.css', import.meta.url), 'utf8');
  assert.match(styles, /\[data-section='appearance'\][^{]*\{[^}]*scrollbar-width: none/s);
  assert.match(styles, /\[data-section='appearance'\]::-webkit-scrollbar \{ display: none;/);
  assert.match(parentStyles, /\.settings-content-panel > \.settings-content \{[^}]*overflow: auto/s);
  assert.match(editorStyles, /\.wallpaper-crop-editor \{[^}]*grid-template-rows: auto auto/s, '侧栏自然撑高，不被固定轨道或保存栏遮挡');
  assert.match(editorStyles, /\.wallpaper-source-image \{[^}]*object-fit: cover/s, '原图作为铺满式缩略背景，不出现两侧主题留白');
  assert.match(editorStyles, /\.wallpaper-source-actions \{[^}]*inset: 0/s, '更换入口轻量叠在图片上，不使用独立的盒装按钮');
  assert.match(editorStyles, /@media \(max-width: 1050px\)/);
  assert.doesNotMatch(styles, /\.appearance-settings \{[^}]*overflow: hidden/s);
});

test('画面比例使用宽幅四角与对角箭头图标，不再使用单纯方框', () => {
  const editor = readFileSync(new URL('../src/components/WallpaperCropEditor.tsx', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../src/components/Ui.tsx', import.meta.url), 'utf8');
  assert.match(editor, /<Icon name="aspectRatio" size=\{16\} \/>画面比例/);
  assert.doesNotMatch(editor, /<Icon name="maximize"[^>]*\/>画面比例/);
  assert.match(ui, /aspectRatio: 'M8 5H3v5 M16 5h5v5 M3 14v5h5 M21 14v5h-5 M8 15l8-6/);
});

test('还原和保存仅出现在顶部标题栏，不再显示底部文件栏或顶部保存状态', () => {
  const html = renderAppearance(appearance);
  const header = html.match(/<header class="wallpaper-crop-heading">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header);
  assert.match(header, /wallpaper-crop-actions/);
  assert.match(header, /还原已保存画面/);
  assert.match(header, /保存画面/);
  assert.doesNotMatch(html, /wallpaper-crop-footer|wallpaper-crop-file|wallpaper-crop-draft|原图已保留|仅此客户端/);
  assert.equal((html.match(/class="wallpaper-crop-actions"/g) ?? []).length, 1);
});

test('左右等高标题使预览与更换入口上边缘对齐；键盘说明保留但不占版面', () => {
  const html = renderAppearance(appearance);
  const styles = readFileSync(new URL('../src/components/WallpaperCropEditor.css', import.meta.url), 'utf8');
  assert.match(html, /id="wallpaper-crop-keyboard" class="visually-hidden"/);
  assert.match(html, /aria-describedby="wallpaper-crop-keyboard"/);
  assert.match(styles, /\.wallpaper-crop-frame \{[^}]*place-items: start center/s);
  assert.match(styles, /\.wallpaper-crop-main \{[^}]*padding-top: 0[^}]*align-self: start/s);
  assert.match(styles, /\.wallpaper-crop-controls \{[^}]*align-self: start/s);
  assert.match(html, /<h3 class="wallpaper-preview-heading">[\s\S]*?效果预览<\/h3>/);
  assert.match(styles, /\.wallpaper-preview-heading, \.wallpaper-source-control h3 \{[^}]*min-height: 22px;[^}]*margin: 0 0 8px/s);
  assert.doesNotMatch(styles, /--wallpaper-source-heading-height/);
  assert.match(styles, /@media \(max-width: 1050px\)[\s\S]*\.wallpaper-crop-main \{[^}]*grid-template-rows: auto/);
});

test('外观页限宽居中，预览不超过 500px 高度，文字颜色与字体位于壁纸设置下方', () => {
  const html = renderAppearance(appearance);
  const sidebar = html.match(/<aside class="wallpaper-crop-controls"[\s\S]*?<\/aside>/)?.[0];
  assert.ok(sidebar);
  assert.match(sidebar, /背景设置|画面比例/);
  assert.doesNotMatch(sidebar, /appearance-text-colors|appearance-typography|ui-font-family/);
  const interfaceSettings = html.indexOf('class="appearance-interface-settings"');
  assert.ok(interfaceSettings > html.indexOf('</aside>'));
  assert.ok(html.indexOf('class="appearance-text-colors"') > interfaceSettings);
  assert.ok(html.indexOf('class="appearance-typography"') > interfaceSettings);
  assert.equal((html.match(/id="ui-font-family"/g) ?? []).length, 1);
  const styles = readFileSync(new URL('../src/components/AppearanceSettings.css', import.meta.url), 'utf8');
  const editorStyles = readFileSync(new URL('../src/components/WallpaperCropEditor.css', import.meta.url), 'utf8');
  assert.match(styles, /\.appearance-settings \{[^}]*max-width: 1280px;[^}]*margin-inline: auto/s);
  assert.doesNotMatch(styles, /\.appearance-settings \{[^}]*height: 100%/s);
  assert.match(editorStyles, /\.wallpaper-crop-editor \{[^}]*flex: 0 0 auto;[^}]*grid-template-columns: minmax\(0, 1fr\) 380px/s);
  assert.match(editorStyles, /\.wallpaper-crop-frame \{[^}]*max-width: min\(900px, calc\(500px \* var\(--appearance-preview-window-ratio/s);
  assert.match(styles, /\.appearance-interface-settings \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.appearance-interface-settings \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  // 与 CSS 上限对应的几何：画面尺寸随真实窗口比例改变，绝不裁切或拉伸预览本身。
  for (const ratio of [16 / 9, 16 / 10, 1, 0.75]) {
    const width = Math.min(1280 - 380 - 24, 900, 500 * ratio);
    assert.ok(width / ratio <= 500);
  }
});

test('显示方式的短提示仍保留完整读屏说明', () => {
  const html = renderAppearance(appearance);
  assert.match(html, /title="填满整个窗口，保留比例；窗口与图片比例不同时会裁掉部分边缘。">填满窗口，超出边缘会裁切。/);
  assert.match(html, /aria-describedby="crop-fit-help"/);
  assert.match(html, /<span id="crop-fit-help" class="visually-hidden">填满整个窗口/);
});

test('外观标题与控件使用已有图标、语义徽标及选中勾选，不给壁纸预览重新叠加图标', () => {
  const html = renderAppearance(appearance);
  assert.match(html, /appearance-section-title[^>]*>[\s\S]*?ui-accent-icon/);
  assert.match(html, /ui-badge[^>]*data-accent="cyan"/);
  assert.match(html, /本地壁纸/);
  assert.match(html, /appearance-choice-check/);
  const preview = html.match(/<figure class="appearance-preview"[\s\S]*?<\/figure>/)?.[0];
  assert.ok(preview);
  assert.doesNotMatch(preview, /<svg|ui-badge/);
  const styles = readFileSync(new URL('../src/components/AppearanceSettings.css', import.meta.url), 'utf8');
  assert.match(styles, /button\.selected \{ background: var\(--settings-selection-bg\);/);
  assert.match(styles, /button:disabled \{ cursor: not-allowed; opacity: .5;/);
});

test('字体使用主题下拉组件，替代白底原生选择框，并保留选中、浮层和键盘状态', () => {
  const html = renderAppearance(appearance);
  assert.match(html, /id="ui-font-family"[^>]*role="combobox"[^>]*class="ui-select-trigger settings-control"/);
  assert.doesNotMatch(html, /<select\b|<option\b/);
  const select = readFileSync(new URL('../src/components/Select.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/components/Select.css', import.meta.url), 'utf8');
  assert.match(select, /createPortal/);
  assert.match(select, /role="listbox"/);
  assert.match(select, /aria-selected/);
  assert.match(select, /ArrowDown/);
  assert.match(select, /Escape/);
  assert.match(css, /background: var\(--theme-panel\)/);
  assert.match(css, /\.ui-select-option\.is-selected/);
  assert.match(css, /\.ui-select-option\.is-active/);
});

test('字体选择在标题同行，缩略图有轻蒙版，格式提示替代可见的播放规则', () => {
  const html = renderAppearance(appearance);
  const heading = html.match(/class="appearance-text-colors-heading appearance-typography-heading"[\s\S]*?<\/div>/)?.[0];
  assert.match(heading, /界面字体/);
  assert.match(heading, /id="ui-font-family"/);
  assert.doesNotMatch(html, /<label[^>]*for="ui-font-family"/);
  assert.match(html, /支持 PNG \/ JPG \/ GIF \/ WebP \/ MP4/);
  assert.doesNotMatch(html, />静音循环 · 仅最小化或不可见时暂停</);
  const css = readFileSync(new URL('../src/components/WallpaperCropEditor.css', import.meta.url), 'utf8');
  assert.match(css, /\.wallpaper-source-actions \{[^}]*18%[^}]*34%/s);
});

test('预览交互框按实际窗口比例收缩，不被网格拉高或用最小高度撑出底部空白', async () => {
  const styles = readFileSync(new URL('../src/components/WallpaperCropEditor.css', import.meta.url), 'utf8');
  assert.match(styles, /\.wallpaper-crop-frame \{[^}]*min-height: 0[^}]*align-self: start[^}]*aspect-ratio: var\(--appearance-preview-window-ratio/s);
  assert.doesNotMatch(styles, /\.wallpaper-crop-frame \{[^}]*(?:min-height: 240px|container-type: size)/s);
  const harness = editorHarness();
  await harness.settle();
  const frame = () => harness.find(node => node.props.className === 'wallpaper-crop-frame');
  assert.equal(frame().props.style['--appearance-preview-window-ratio'], 16 / 9);
  harness.button('1 : 1').props.onClick();
  harness.render();
  assert.equal(frame().props.style['--appearance-preview-window-ratio'], 16 / 9, '选区变方形不能把交互框也变成方形');
  assert.equal(frame().props.style['--crop-ratio'], 1);
  harness.resize(1280, 1024);
  assert.equal(frame().props.style['--appearance-preview-window-ratio'], 1.25);
  assert.equal(frame().props.style['--crop-ratio'], 1, '窗口大小变化只适配展示，不改写壁纸选区');
  assert.equal(harness.saves.length, 0);
});

test('删除图片按钮在悬停和键盘聚焦时使用红色高亮，禁用时不触发', () => {
  const styles = readFileSync(new URL('../src/components/WallpaperCropEditor.css', import.meta.url), 'utf8');
  assert.match(styles, /:root\[data-theme\] \.settings-page \.appearance-settings \.wallpaper-source-remove \.appearance-remove-image:is\(:hover, :focus-visible\):not\(:disabled\) \{[^}]*color: #ffd6dc;[^}]*background: #a52638;/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[^}]*\.appearance-remove-image \{ transition: none;/s);
});

test('壁纸仍在时外部操作错误只显示一次，不重复堆叠两份提示', () => {
  const html = renderAppearance({ ...appearance, error: '模拟恢复默认失败' });
  assert.equal((html.match(/模拟恢复默认失败/g) ?? []).length, 1);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
});

/**
 * 轻量 hook 驱动器测试事件与生命周期；不模拟实际 DOM 布局、不访问用户 IndexedDB。
 * 几何计算使用生产实现，导出/存储端口可延迟或失败，以验证常驻编辑器不会提前退出。
 */
function editorHarness({ file, initialCrop, hasWallpaper = true, initializing = false, saveResult = true, prepareWait, exportWait, onSelectWallpaper, externalBusy = false } = {}) {
  const slots = [], pendingEffects = [], revoked = [], busy = [], saves = [], exports = [];
  const windowEvents = new Map();
  const editorWindow = { ...windowSize,
    addEventListener: (name, callback) => windowEvents.set(name, callback),
    removeEventListener: name => windowEvents.delete(name),
  };
  let cursor = 0, tree, closeCount = 0, prepareCount = 0;
  const createNode = (type, props, key) => ({ type, props: props ?? {}, key });
  const fakeReact = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      const effect = { deps, cleanup: undefined };
      slots[index] = effect;
      pendingEffects.push(() => { previous?.cleanup?.(); effect.cleanup = callback(); });
    },
  };
  const source = { blob: new Blob(['mock image']), url: 'blob:original', name: 'cat.png', width: 3200, height: 1800 };
  const originalCrop = initialCrop ?? { ratio: 16 / 9, view: { zoom: 1, centerX: .5, centerY: .5 } };
  const api = {
    wallpaperReadability: () => ({ blur: 0 }),
    async prepareClientWallpaper() { prepareCount++; if (prepareWait) await prepareWait; return source; },
    async prepareSavedClientWallpaper() {
      prepareCount++; if (prepareWait) await prepareWait;
      return { ...source, crop: originalCrop, fit: 'cover', limitedSource: false };
    },
    async chooseClientWallpaper(cropped, fit, metadata) { saves.push({ cropped, fit, metadata }); return saveResult; },
    readClientAppearance: () => ({ error: '模拟保存失败' }),
  };
  async function exportCrop(prepared, rect) {
    exports.push({ prepared, rect });
    if (exportWait) await exportWait;
    return new File(['mock crop'], 'cat-wallpaper.webp', { type: 'image/webp' });
  }
  let fitControl, workspacePreview;
  function requireModule(name) {
    if (name === 'react') return fakeReact;
    if (name === 'react/jsx-runtime') return { jsx: createNode, jsxs: createNode };
    if (name.endsWith('.css')) return {};
    if (name === './Ui') return { Icon: () => createNode('svg'), AccentIcon: () => createNode('svg'), Badge: ({ children }) => createNode('span', { children }) };
    if (name.endsWith('/clientAppearance')) return api;
    if (name.endsWith('/wallpaperCrop')) return { ...geometry, exportWallpaperCrop: exportCrop };
    if (name === './WallpaperVideo') return { WallpaperVideo: props => createNode('video', { ...props, muted: true, loop: true, playsInline: true }) };
    if (name === './WallpaperFitControl') return fitControl ??= loadModule('components/WallpaperFitControl.tsx', requireModule);
    if (name === './WallpaperWorkspacePreview') return workspacePreview ??= loadModule('components/WallpaperWorkspacePreview.tsx', requireModule);
    throw new Error(`Unexpected import: ${name}`);
  }
  const { WallpaperCropEditor } = loadModule('components/WallpaperCropEditor.tsx', requireModule, {
    window: editorWindow, URL: { revokeObjectURL: url => revoked.push(url) },
  });
  const props = { file, hasWallpaper, initializing, onSelectWallpaper, externalBusy, onClose: () => closeCount++, onSavingChange: value => busy.push(value) };
  function render() {
    cursor = 0;
    tree = WallpaperCropEditor(props);
    pendingEffects.splice(0).forEach(effect => effect());
    return tree;
  }
  function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(item => nodes(item));
    if (typeof node.type === 'function') return nodes(node.type(node.props));
    return [node, ...nodes(node.props.children)];
  }
  function text(node) {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return String(node);
    if (Array.isArray(node)) return node.map(item => text(item)).join('');
    return typeof node.type === 'function' ? text(node.type(node.props)) : text(node.props.children);
  }
  const find = predicate => nodes(tree).find(predicate);
  const button = label => find(node => node.type === 'button' && text(node) === label);
  const zoom = () => find(node => node.type === 'input' && node.props.id === 'wallpaper-crop-zoom');
  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    render();
    render();
  }
  function resize(width, height) {
    editorWindow.innerWidth = width;
    editorWindow.innerHeight = height;
    windowEvents.get('resize')?.();
    render();
    render();
  }
  function unmount() { slots.forEach(slot => slot?.cleanup?.()); }
  render();
  return { render, settle, resize, button, zoom, find, text: () => text(tree), unmount, busy, revoked, exports, saves, source,
    get closeCount() { return closeCount; }, get prepareCount() { return prepareCount; } };
}

test('恢复上次自定义比例和缩放，控件可直接调整；未修改时不重复保存', async () => {
  const harness = editorHarness({ initialCrop: { ratio: 1.731, view: { zoom: 1.5, centerX: .55, centerY: .5 } } });
  await harness.settle();
  assert.equal(harness.button('上次比例').props['aria-pressed'], true);
  assert.equal(harness.zoom().props.value, 1.5);
  assert.equal(harness.button('保存画面').props.disabled, true);
  harness.button('保存画面').props.onClick();
  await harness.settle();
  assert.equal(harness.exports.length, 0);
  harness.button('1 : 1').props.onClick();
  harness.render();
  assert.equal(harness.button('1 : 1').props['aria-pressed'], true);
  assert.equal(harness.button('完整显示').props['aria-pressed'], true);
  assert.equal(harness.button('保存画面').props.disabled, false);
  assert.equal(harness.saves.length, 0, '调整仅预览，保存前不写库');
  harness.unmount();
  assert.deepEqual(harness.revoked, ['blob:original']);
});

test('工作区效果预览不显示模拟文案，比例/缩放/显示方式仍更新原图选区，不产生裁剪框或重复文件名', async () => {
  const harness = editorHarness();
  await harness.settle();
  assert.equal((harness.text().match(/cat\.png/g) ?? []).length, 0, '不再显示底部文件信息栏');
  assert.doesNotMatch(harness.text(), /ssh your-server|AI 助手|连接就绪|远程连接与 AI 协作|Agent SSH/);
  assert.equal(harness.find(node => node.props.className === 'appearance-preview-bar'), undefined);
  assert.equal(harness.find(node => node.props.className === 'appearance-preview-workspace'), undefined);
  assert.equal(harness.find(node => node.props.className === 'wallpaper-crop-grid'), undefined);
  harness.button('1 : 1').props.onClick();
  harness.render();
  harness.zoom().props.onChange({ target: { value: '2' } });
  harness.render();
  const preview = harness.find(node => node.props.className === 'appearance-preview');
  assert.equal(preview.props['data-fit'], 'contain');
  assert.equal(preview.props.style['--appearance-preview-ratio'], 1);
  assert.equal(preview.props.style['--appearance-preview-window-ratio'], 16 / 9, '1:1 不改变模拟窗口比例');
  const image = harness.find(node => node.type === 'img' && node.props.style);
  assert.equal(image.props.src, harness.source.url);
  assert.equal(image.props.style.width, `${3200 / 900 * 100}%`);
  harness.button('铺满窗口').props.onClick();
  harness.render();
  assert.equal(harness.find(node => node.props.className === 'appearance-preview').props['data-fit'], 'cover');
  assert.equal(harness.saves.length, 0, '效果预览不能因拖动或缩放写入数据库');
});

test('更换图片区域使用原图作缩略背景，调整比例和缩放只改变左侧效果，不改变右侧原图', async () => {
  const harness = editorHarness();
  await harness.settle();
  const thumbnail = () => harness.find(node => node.props.className === 'wallpaper-source-image');
  assert.equal(thumbnail().props.src, harness.source.url);
  assert.equal(thumbnail().props.alt, '当前壁纸原图缩略图');
  assert.equal(thumbnail().props.draggable, false);
  assert.equal(thumbnail().props.style, undefined, '缩略图不能使用选区偏移、缩放或透明度样式');
  harness.button('1 : 1').props.onClick();
  harness.render();
  harness.zoom().props.onChange({ target: { value: '2.5' } });
  harness.render();
  harness.button('铺满窗口').props.onClick();
  harness.render();
  assert.equal(thumbnail().props.src, harness.source.url);
  assert.equal(thumbnail().props.style, undefined);
  assert.equal(harness.prepareCount, 1);
  assert.equal(harness.saves.length, 0);
});

test('新文件草稿的右侧缩略图也取上传原图，不借用旧壁纸或导出结果', async () => {
  const harness = editorHarness({ file: new File(['mock'], 'new-wallpaper.png') });
  await harness.settle();
  assert.equal(harness.find(node => node.props.className === 'wallpaper-source-image').props.src, harness.source.url);
  harness.zoom().props.onChange({ target: { value: '3' } });
  harness.render();
  assert.equal(harness.find(node => node.props.className === 'wallpaper-source-image').props.src, harness.source.url);
  assert.equal(harness.exports.length, 0, '上传草稿和缩放不能提前导出或保存');
  harness.unmount();
  assert.deepEqual(harness.revoked, ['blob:original']);
});

test('没有壁纸不触发读取，默认预览非加载状态，窗口变化仍可更新预览比例', async () => {
  const harness = editorHarness({ hasWallpaper: false });
  await harness.settle();
  assert.equal(harness.prepareCount, 0);
  assert.equal(harness.zoom(), undefined);
  assert.equal(harness.find(node => node.props.className === 'wallpaper-crop-frame').props['aria-busy'], false);
  assert.match(harness.text(), /默认背景/);
  assert.doesNotMatch(harness.text(), /正在读取|正在准备/);
  harness.resize(1280, 1024);
  assert.equal(harness.find(node => node.props.className === 'appearance-preview').props.style['--appearance-preview-window-ratio'], 1.25);
  assert.equal(harness.prepareCount, 0);
});

test('空预览选择按钮调用现有上传入口，不读取或保存壁纸；忙碌时禁用，已有图和上传草稿不显示', async () => {
  let selections = 0;
  const harness = editorHarness({ hasWallpaper: false, onSelectWallpaper: () => selections++ });
  await harness.settle();
  const select = harness.button('选择壁纸');
  assert.equal(select.props.disabled, false);
  assert.equal(harness.find(node => node.props.className === 'wallpaper-crop-frame').props['aria-disabled'], undefined);
  select.props.onClick(); assert.equal(selections, 1);
  assert.equal(harness.prepareCount, 0); assert.equal(harness.saves.length, 0); assert.equal(harness.exports.length, 0);
  const busy = editorHarness({ hasWallpaper: false, externalBusy: true, onSelectWallpaper: () => selections++ });
  assert.equal(busy.button('选择壁纸').props.disabled, true);
  const missingEntry = editorHarness({ hasWallpaper: false }); assert.equal(missingEntry.button('选择壁纸').props.disabled, true);
  const pending = editorHarness({ hasWallpaper: false, initializing: true, onSelectWallpaper: () => selections++ });
  assert.equal(pending.button('选择壁纸'), undefined);
  const saved = editorHarness(); await saved.settle(); assert.equal(saved.button('选择壁纸'), undefined);
  const draft = editorHarness({ hasWallpaper: false, file: new File(['mock'], 'new.png') });
  assert.equal(draft.button('选择壁纸'), undefined); await draft.settle(); assert.equal(draft.button('选择壁纸'), undefined);
  for (const item of [harness, busy, missingEntry, pending, saved, draft]) item.unmount();
});

test('完整显示时按真实图像平面归一化拖动，不把左右留白算作图片宽度', async () => {
  const harness = editorHarness();
  await harness.settle();
  harness.button('1 : 1').props.onClick();
  harness.render();
  harness.zoom().props.onChange({ target: { value: '2' } });
  harness.render();
  const imagePlane = harness.find(node => node.props.className === 'appearance-preview-image-plane');
  imagePlane.props.ref.current = { getBoundingClientRect: () => ({ width: 200, height: 200 }) };
  const target = { getBoundingClientRect: () => ({ width: 600, height: 340 }), focus() {}, setPointerCapture() {} };
  const frame = harness.find(node => node.props.className === 'wallpaper-crop-frame');
  frame.props.onPointerDown({ isPrimary: true, button: 0, currentTarget: target, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} });
  frame.props.onPointerMove({ pointerId: 1, clientX: 120, clientY: 100 });
  harness.render();
  harness.button('保存画面').props.onClick();
  await harness.settle();
  assert.equal(harness.saves[0].metadata.crop.view.centerX, .5 - .1 * 900 / 3200);
});

test('保存后控件留在原位并更新基线，可继续缩放和还原，不重读或二次裁剪旧结果', async () => {
  const harness = editorHarness();
  await harness.settle();
  harness.button('1 : 1').props.onClick();
  harness.render();
  harness.zoom().props.onChange({ target: { value: '2' } });
  harness.render();
  harness.button('保存画面').props.onClick();
  await harness.settle();
  assert.equal(harness.closeCount, 0, '已有图片保存后不能退出编辑');
  assert.equal(harness.prepareCount, 1, '保存后不重新解码原图或抢焦点');
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].metadata.source.blob, harness.source.blob);
  assert.equal(harness.saves[0].metadata.source.width, 3200, '始终从完整原图导出');
  assert.equal(harness.saves[0].metadata.crop.ratio, 1);
  assert.equal(harness.saves[0].metadata.crop.view.zoom, 2);
  assert.equal(harness.saves[0].fit, 'contain');
  assert.equal(harness.button('保存画面').props.disabled, true);
  harness.zoom().props.onChange({ target: { value: '1.8' } });
  harness.render();
  harness.button('还原已保存画面').props.onClick();
  harness.render();
  assert.equal(harness.zoom().props.value, 2);
  assert.equal(harness.button('保存画面').props.disabled, true);
  assert.equal(harness.saves.length, 1, '还原草稿不额外写库');
});

test('常驻控件随窗口变化更新当前窗口选项，但选区不跳变、不重新加载原图', async () => {
  const harness = editorHarness();
  await harness.settle();
  harness.button('当前窗口').props.onClick();
  harness.render();
  const before = harness.find(node => node.props.className === 'wallpaper-crop-frame').props.style['--crop-ratio'];
  harness.resize(1280, 1024);
  assert.equal(harness.find(node => node.props.className === 'wallpaper-crop-frame').props.style['--crop-ratio'], before);
  assert.equal(harness.button('上次比例').props['aria-pressed'], true);
  assert.equal(harness.button('保存画面').props.disabled, true, '仅调整窗口大小不能产生未保存修改');
  assert.equal(harness.prepareCount, 1);
  harness.button('当前窗口').props.onClick();
  harness.render();
  assert.equal(harness.find(node => node.props.className === 'wallpaper-crop-frame').props.style['--crop-ratio'], 1.25);
  assert.equal(harness.button('保存画面').props.disabled, false);
});

test('新上传仍须确认，可取消更换；保存成功只关闭新文件草稿，随后显示常驻控件', async () => {
  const harness = editorHarness({ file: new File(['mock'], 'cat.png') });
  await harness.settle();
  assert.equal(harness.button('应用此区域').props.disabled, false);
  harness.button('应用此区域').props.onClick();
  await harness.settle();
  assert.equal(harness.closeCount, 1);
  assert.deepEqual(harness.busy, [true, false]);
  assert.equal(harness.saves[0].metadata.source, harness.source);
});

test('保存失败保留原图和未保存调整，控件不退出，可还原或重新尝试', async () => {
  const harness = editorHarness({ saveResult: false });
  await harness.settle();
  harness.zoom().props.onChange({ target: { value: '2.3' } });
  harness.render();
  harness.button('保存画面').props.onClick();
  await harness.settle();
  assert.match(harness.text(), /模拟保存失败/);
  assert.equal(harness.zoom().props.value, 2.3);
  assert.equal(harness.button('保存画面').props.disabled, false);
  assert.equal(harness.closeCount, 0);
  assert.deepEqual(harness.busy, [true, false]);
  harness.button('还原已保存画面').props.onClick();
  harness.render();
  assert.equal(harness.zoom().props.value, 1);
  assert.doesNotMatch(harness.text(), /模拟保存失败/);
});

test('Canvas 导出阶段即锁定操作并通知父页，重复点击或过期事件不覆盖正在保存的选区', async () => {
  let resolveExport;
  const exportWait = new Promise(resolve => { resolveExport = resolve; });
  const harness = editorHarness({ exportWait });
  await harness.settle();
  harness.zoom().props.onChange({ target: { value: '2' } });
  harness.render();
  const save = harness.button('保存画面'), staleZoom = harness.zoom(), restore = harness.button('还原已保存画面');
  save.props.onClick();
  save.props.onClick();
  staleZoom.props.onChange({ target: { value: '3' } });
  restore.props.onClick();
  harness.render();
  assert.equal(harness.exports.length, 1);
  assert.equal(harness.saves.length, 0);
  assert.deepEqual(harness.busy, [true]);
  assert.equal(harness.zoom().props.value, 2);
  assert.equal(harness.zoom().props.disabled, true);
  resolveExport();
  await harness.settle();
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].metadata.crop.view.zoom, 2);
  assert.deepEqual(harness.busy, [true, false]);
});

test('准备图片期间取消不写库，异步返回的原图 URL 仍释放', async () => {
  let resolvePrepare;
  const prepareWait = new Promise(resolve => { resolvePrepare = resolve; });
  const harness = editorHarness({ file: new File(['mock'], 'cat.png'), prepareWait });
  assert.equal(harness.button('取消更换').props.disabled, false);
  harness.button('取消更换').props.onClick();
  harness.unmount();
  resolvePrepare();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(harness.closeCount, 1);
  assert.equal(harness.saves.length, 0);
  assert.deepEqual(harness.revoked, ['blob:original']);
});
