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
  { document: { documentElement: root } }, '\nexport { currentTerminalTheme };');

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
      assert.equal(colors.background, wallpaper === 'true' ? '#00000000' : theme === 'dark' ? '#0d1624' : '#ffffff');
      assert.equal(colors.foreground, theme === 'dark' ? '#d8e5f4' : '#243b60');
      for (const key of ['scrollbarSliderBackground', 'scrollbarSliderHoverBackground', 'scrollbarSliderActiveBackground']) {
        assert.match(colors[key], /^#[\da-f]{8}$/i);
        assert.notEqual(colors[key].slice(-2), '00', 'Only the ruler border is hidden, not the scroll slider');
      }
    }
  }
});
