import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function compile(path, requireModule, globals = {}, extra = '') {
  const input = readFileSync(new URL(path, import.meta.url), 'utf8') + extra;
  const output = ts.transpileModule(input, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, experimentalDecorators: true,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, ...globals });
  vm.runInContext(output, context);
  return context.exports;
}

const root = { dataset: {} };
const { currentTerminalTheme } = compile('../src/components/RemoteTerminalView.tsx', () => ({}),
  { document: { documentElement: root } });

// Exercise the installed xterm renderer, not a CSS-selector assertion: the white line is
// drawn into its overview-ruler canvas even when there is no scrollback or decoration.
const { OverviewRulerRenderer } = compile(
  '../node_modules/@xterm/xterm/src/browser/decorations/OverviewRulerRenderer.ts', name => {
    if (name === 'vs/base/common/lifecycle') return { Disposable: class {} };
    if (name.endsWith('/services/Services')) return new Proxy({}, { get: () => () => () => {} });
    return {};
  });

test('实际 xterm 标尺的全高边线在浅色、深色及壁纸模式下均透明，主题切换不恢复白线', () => {
  for (const theme of ['light', 'dark', 'light']) {
    for (const wallpaper of ['false', 'true', 'false']) {
      root.dataset = { theme, wallpaper };
      const colors = currentTerminalTheme();
      const draws = [];
      const ctx = { fillStyle: '', fillRect(...rect) { draws.push({ color: this.fillStyle, rect }); } };
      OverviewRulerRenderer.prototype._renderRulerOutline.call({
        _ctx: ctx, _canvas: { width: 6, height: 900 },
        _themeService: { colors: { overviewRulerBorder: { css: colors.overviewRulerBorder } } },
        _optionsService: { rawOptions: { overviewRuler: { width: 6 } } },
      });
      assert.deepEqual(draws, [{ color: '#00000000', rect: [0, 0, 1, 900] }]);
      assert.equal(colors.background, wallpaper === 'true' ? '#00000000' : theme === 'dark' ? '#2c343b' : '#f8f9fb');
      assert.equal(colors.foreground, theme === 'dark' ? '#c8cdd0' : '#303942');
      for (const key of ['scrollbarSliderBackground', 'scrollbarSliderHoverBackground', 'scrollbarSliderActiveBackground']) {
        assert.match(colors[key], /^#[\da-f]{8}$/i);
        assert.notEqual(colors[key].slice(-2), '00', 'Only the ruler border is hidden, not the scroll slider');
      }
    }
  }
});

test('Soft Light 终端使用柔和灰白底，16 色正文保持可读对比度',()=>{
  root.dataset={theme:'light',wallpaper:'false'};const palette=currentTerminalTheme();
  const luminance=hex=>{const rgb=hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const background=luminance(palette.background);assert.ok(background<.96);assert.ok(background>.9);
  const colors=['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  for(const name of ['foreground',...colors]){assert.match(palette[name],/^#[a-f0-9]{6}$/i);assert.ok((background+.05)/(luminance(palette[name])+.05)>=4.5,`${name} remains readable`);}
  assert.notEqual(palette.green,palette.red);assert.notEqual(palette.brightGreen,'#00ff00');assert.notEqual(palette.brightYellow,'#ffff00');
  const css=readFileSync(new URL('../src/components/TerminalPalette.css',import.meta.url),'utf8');
  assert.ok(css.includes(`--terminal-canvas-bg: ${palette.background}`));assert.ok(css.includes(`--terminal-canvas-text: ${palette.foreground}`));
  assert.match(css,/not\(\[data-wallpaper='true'\]\)/);assert.doesNotMatch(css,/opacity\s*:|filter\s*:/);
});

test('暮雾灰终端按灰蓝基底保持 ANSI 层次，切换主题和壁纸不重建终端或褪淡文字',()=>{
  root.dataset={theme:'dark',wallpaper:'false'};const colors=currentTerminalTheme();
  assert.equal(colors.background,'#2c343b');assert.equal(colors.foreground,'#c8cdd0');
  assert.equal(colors.green,'#79c99e');assert.equal(colors.yellow,'#e5c07b');assert.equal(colors.blue,'#82b7f2');
  const luminance=hex=>hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i],0);
  for(const name of ['foreground','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'])assert.ok((luminance(colors[name])+.05)/(luminance(colors.background)+.05)>=4.5,`${name} remains readable`);
  const css=readFileSync(new URL('../src/components/TerminalPalette.css',import.meta.url),'utf8');assert.ok(css.includes(`--terminal-canvas-bg: ${colors.background}`));assert.ok(css.includes(`--terminal-canvas-text: ${colors.foreground}`));
  root.dataset.wallpaper='true';const transparent=currentTerminalTheme();assert.equal(transparent.background,'#00000000');for(const name of Object.keys(colors).filter(name=>name!=='background'))assert.equal(transparent[name],colors[name]);
});

test('两个暗色主题的目录与提示符有明确彩色层次，选区与终端底色分离，视口不露白', () => {
  const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  for (const themePreference of ['dark', 'night']) {
    root.dataset = { theme: 'dark', themePreference };
    const colors = currentTerminalTheme();
    for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
      const channels = colors[name].slice(1).match(/../g).map(value => parseInt(value, 16));
      assert.ok(Math.max(...channels) - Math.min(...channels) >= 60, `${themePreference} ${name} is distinct from gray body text`);
      assert.ok(luminance(colors[`bright${name[0].toUpperCase()}${name.slice(1)}`]) > luminance(colors[name]));
    }
    assert.ok((luminance(colors.selectionForeground) + .05) / (luminance(colors.selectionBackground) + .05) >= 4.5);
    assert.ok((luminance(colors.selectionBackground) + .05) / (luminance(colors.background) + .05) >= 2);
  }
  const css = readFileSync(new URL('../src/reference.css', import.meta.url), 'utf8');
  const viewport = css.match(/\.remote-terminal-screen \.xterm \.xterm-viewport\s*\{([^}]+)\}/)[1];
  assert.match(viewport, /background-color:\s*transparent/);
  assert.doesNotMatch(viewport, /#fff|white\b/);
});

test('夜幕黑具有独立终端配色，正文与 ANSI 保持可读，切换壁纸保留文字和透明标尺', () => {
  root.dataset = { theme: 'dark', themePreference: 'night', wallpaper: 'false' };
  const colors = currentTerminalTheme();
  assert.equal(colors.background, '#161a20'); assert.equal(colors.foreground, '#cbd3dc');
  const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  for (const name of ['foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) {
    assert.ok((luminance(colors[name]) + .05) / (luminance(colors.background) + .05) >= 4.5, name);
  }
  assert.equal(colors.overviewRulerBorder, '#00000000');
  root.dataset.wallpaper = 'true';
  assert.deepEqual({ ...currentTerminalTheme() }, { ...colors, background: '#00000000' });
  root.dataset = { theme: 'dark', themePreference: 'dark' };
  assert.equal(currentTerminalTheme().background, '#2c343b');
});
