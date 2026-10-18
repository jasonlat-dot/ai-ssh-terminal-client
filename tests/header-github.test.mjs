import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const PROJECT_URL = 'https://github.com/jasonlat-dot/ai-ssh-terminal-server';
function header({ tauri = false, fail = false } = {}) {
  const calls = [], notifications = [];
  const node = (type, props) => ({ type, props });
  const output = ts.transpileModule(readFileSync(new URL('../src/components/Shell.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = vm.createContext({ exports: {}, require: name => {
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === './Ui') return { Icon: () => null };
    if (name === './WindowControls') return { WindowControls: () => null };
    if (name === './NavigationButton') return { NavigationButton: () => null };
    if (name === '../config/settingsNavigation') return { settingsNavigation: [] };
    if (name === '../config/appRuntime') return { APP_VERSION: '0.2.1' };
    if (name.endsWith('.css')) return {};
    if (name === '../state/appWindow') return { dragAppWindow() {} };
    if (name === '../state/runtime') return { isTauriRuntime: () => tauri };
    if (name === '@tauri-apps/plugin-opener') return { openUrl: url => {
      calls.push(url); return fail ? Promise.reject(new Error('No browser')) : Promise.resolve();
    } };
    throw new Error(name);
  } });
  vm.runInContext(output, context);
  const tree = context.exports.AppHeader({ notify: text => notifications.push(text), theme: 'dark', setTheme() {} });
  function all(value) {
    if (Array.isArray(value)) return value.flatMap(all);
    return value?.props ? [value, ...all(value.props.children)] : [];
  }
  return { calls, notifications, link: all(tree).find(item => item.type === 'a') };
}

test('头像入口替换为 jasonlat GitHub 链接；网页版使用安全新标签，不触发账户提示', () => {
  const ui = header();
  assert.equal(ui.link.props.href, PROJECT_URL);
  assert.equal(ui.link.props.target, '_blank'); assert.equal(ui.link.props.rel, 'noopener noreferrer');
  assert.match(ui.link.props['aria-label'], /jasonlat.*GitHub/);
  assert.equal(ui.link.props.children[1].props.children, 'jasonlat');
  assert.equal(ui.link.props.children[0].props.children.props.name, 'github');
  assert.equal(ui.link.props.children[2].props.name, 'upRight');
  let prevented = false;
  ui.link.props.onClick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false); assert.equal(ui.calls.length, 0); assert.equal(ui.notifications.length, 0);
});

test('桌面点击通过现有 opener 打开系统浏览器；打开失败给出明确提示', async () => {
  for (const fail of [false, true]) {
    const ui = header({ tauri: true, fail }); let prevented = false;
    ui.link.props.onClick({ preventDefault: () => { prevented = true; } });
    await Promise.resolve();
    assert.equal(prevented, true); assert.deepEqual(ui.calls, [PROJECT_URL]);
    assert.equal(ui.notifications.length, fail ? 1 : 0);
    if (fail) assert.match(ui.notifications[0], /无法打开 GitHub 项目/);
  }
});
