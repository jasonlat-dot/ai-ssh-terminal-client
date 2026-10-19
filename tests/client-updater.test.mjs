import { loadToastErrorHooks } from './helpers/toast-errors.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { makeManifest, validatePublicKey, validateVersion, UPDATE_ENDPOINT } from '../scripts/updater-release.mjs';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function load(path, requireModule = () => { throw new Error('Unexpected import'); }, globals = {}) {
  const compiled = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require: requireModule, ...globals });
  vm.runInContext(compiled, context); return context.exports;
}
const { createClientUpdater } = load('state/clientUpdater.ts');
const config = { version: '0.1.5', configured: true, supported: true, development: false };
function fixture(options = {}) {
  const calls = [];
  const resource = { version: '0.1.6', body: 'Release notes', date: '2026-10-11T00:00:00Z',
    async download(progress, settings) { calls.push('download'); assert.equal(settings.timeout, 120000);
      progress({ event: 'Started', data: { contentLength: 100 } });
      progress({ event: 'Progress', data: { chunkLength: 60 } });
      progress({ event: 'Progress', data: { chunkLength: 40 } }); progress({ event: 'Finished' }); },
    async install(settings) { calls.push('install'); assert.equal(settings.restartAfterInstall, true); },
    async close() { calls.push('close'); }, ...options.resource };
  const updater = createClientUpdater({ configuration: async () => { calls.push('configuration'); return { ...config, ...options.config }; },
    check: async () => { calls.push('check'); return options.current ? null : resource; },
    prepare: async () => { calls.push('prepare'); }, now: () => 1234, ...options.deps });
  return { updater, calls, resource };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };

test('disabled configurations never check, download, prepare or install', async () => {
  for (const disabled of [{ configured: false }, { development: true }, { supported: false }]) {
    const { updater, calls } = fixture({ config: disabled });
    await updater.check(); await updater.download(); await updater.install(async () => calls.push('save'));
    assert.equal(updater.getSnapshot().phase, 'disabled'); assert.deepEqual(calls, ['configuration']);
  }
});
test('initialization is shared; failure can be retried without reporting current', async () => {
  let attempts = 0;
  const { updater } = fixture({ deps: { configuration: async () => { if (++attempts === 1) throw new Error('IPC failed'); return config; } } });
  await updater.check(); assert.equal(updater.getSnapshot().phase, 'error');
  assert.match(updater.getSnapshot().error, /读取更新配置失败/);
  await updater.check(); assert.equal(attempts, 2); assert.equal(updater.getSnapshot().phase, 'available');
  await Promise.all([updater.initialize(), updater.initialize()]); assert.equal(attempts, 2);
});
test('automatic check happens once; manual check remains available; prior resource is closed', async () => {
  const { updater, calls } = fixture();
  assert.equal(await updater.check(true), '0.1.6'); assert.equal(await updater.check(true), null);
  assert.equal(calls.filter(x => x === 'check').length, 1);
  assert.equal(updater.getSnapshot().version, '0.1.6'); assert.equal(updater.getSnapshot().checkedAt, 1234);
  await updater.check(); assert.deepEqual(calls, ['configuration', 'check', 'close', 'check']);
});

function startupHook(updater) {
  const timers = new Map(), slots = [];
  let cursor = 0, pendingEffects = [];
  const { useStartupUpdateCheck } = load('state/useClientUpdater.ts', name => {
    if (name === 'react') return {
      useRef: initial => { const i = cursor++; return slots[i] ??= { current: initial }; },
      useEffect: callback => { const i = cursor++; if (!slots[i]) pendingEffects.push(() => { slots[i] = { cleanup: callback() }; }); },
    };
    if (name === './clientUpdater') return { createClientUpdater: () => updater };
    if (name === './runtime') return { isTauriRuntime: () => true };
    if (name === '@tauri-apps/api/core') return { invoke() {} };
    if (name === '@tauri-apps/plugin-updater') return { check() {} };
    if (name === '../../package.json') return { version: '0.1.5' };
    throw new Error(name);
  }, {
    setTimeout: (callback, delay) => { assert.equal(delay, 3000); const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return {
    render(notify) { cursor = 0; useStartupUpdateCheck(notify); pendingEffects.forEach(run => run()); pendingEffects = []; },
    run() { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
    cleanup() { slots.forEach(slot => slot?.cleanup?.()); },
    timerCount: () => timers.size,
  };
}

test('startup check is delayed, checks once, announces only availability, and never downloads', async () => {
  const { updater, calls } = fixture(), announced = [];
  const hook = startupHook(updater);
  hook.render(version => announced.push(version)); assert.deepEqual(calls, []); assert.equal(hook.timerCount(), 1);
  hook.run(); await flush(); assert.deepEqual(announced, ['0.1.6']);
  assert.deepEqual(calls, ['configuration', 'check']);
  hook.render(() => { throw new Error('must not announce again'); }); assert.equal(hook.timerCount(), 0);
  // Remounts (including StrictMode) cannot repeat an already completed startup check.
  hook.cleanup(); const remount = startupHook(updater); remount.render(() => { throw new Error('duplicate'); });
  remount.run(); await flush(); assert.equal(calls.filter(x => x === 'check').length, 1);
});

test('startup checks remain silent for no update, network/config failures and disabled modes', async () => {
  for (const options of [{ current: true }, { config: { development: true } }, { config: { configured: false } },
    { config: { supported: false } }, { deps: { check: async () => { throw new Error('network unavailable'); } } },
    { deps: { configuration: async () => { throw new Error('IPC failed'); } } }]) {
    const { updater, calls } = fixture(options), announced = [];
    const hook = startupHook(updater); hook.render(version => announced.push(version)); hook.run(); await flush();
    assert.deepEqual(announced, []); assert.ok(!calls.includes('download')); assert.ok(!calls.includes('install'));
  }
});

test('startup timer cleanup and callback refresh do not produce stale notifications', async () => {
  const cancelled = startupHook(fixture().updater); cancelled.render(() => { throw new Error('unmounted'); });
  cancelled.cleanup(); assert.equal(cancelled.timerCount(), 0);
  const wait = deferred(), { updater } = fixture({ deps: { check: () => wait.promise } });
  const hook = startupHook(updater), announced = [];
  hook.render(() => { throw new Error('stale callback'); }); hook.run(); await flush();
  hook.render(version => announced.push(version)); wait.resolve({ ...fixture().resource }); await flush();
  assert.deepEqual(announced, ['0.1.6']);
  const late = deferred(), lateHook = startupHook(fixture({ deps: { check: () => late.promise } }).updater);
  lateHook.render(() => { throw new Error('unmounted in-flight'); }); lateHook.run(); await flush();
  lateHook.cleanup(); late.resolve(fixture().resource); await flush();
});
test('no update vs failed network are distinct; duplicate checks are serialized', async () => {
  const current = fixture({ current: true }); await current.updater.check(); assert.equal(current.updater.getSnapshot().phase, 'current');
  const wait = deferred(); let checks = 0;
  const { updater } = fixture({ deps: { check: () => { checks++; return wait.promise; } } });
  const first = updater.check(); await flush(); await updater.check(); assert.equal(checks, 1);
  wait.reject(new Error('404')); await first;
  assert.equal(updater.getSnapshot().phase, 'error'); assert.equal(updater.getSnapshot().version, '');
  assert.match(updater.getSnapshot().error, /latest.json/);
});
test('Finished is not signature success; install is forbidden until verified download resolves', async () => {
  const wait = deferred(); let attempts = 0;
  const { updater, calls } = fixture({ resource: { download: async progress => {
    calls.push('download'); attempts++;
    progress({ event: 'Started', data: { contentLength: 100 } });
    progress({ event: 'Progress', data: { chunkLength: 100 } }); progress({ event: 'Finished' });
    if (attempts === 1) await wait.promise;
  } } });
  await updater.check(); await updater.install(async () => calls.push('save')); assert.ok(!calls.includes('save'));
  const downloading = updater.download(); await flush();
  assert.equal(updater.getSnapshot().downloaded, 100); assert.equal(updater.getSnapshot().total, 100);
  assert.equal(updater.getSnapshot().verified, false); await updater.download();
  await updater.install(async () => calls.push('save')); assert.ok(!calls.includes('prepare'));
  wait.reject(new Error('signature mismatch')); await downloading;
  assert.equal(updater.getSnapshot().verified, false); assert.match(updater.getSnapshot().error, /签名校验失败/);
  await updater.install(async () => calls.push('save')); assert.ok(!calls.includes('install'));
  await updater.download(); assert.equal(updater.getSnapshot().verified, true);
  await updater.install(async () => calls.push('save'));
  assert.deepEqual(calls.slice(-3), ['save', 'prepare', 'install']);
});
test('unknown content length remains indeterminate; installation errors retain a retryable verified package', async () => {
  const { updater, calls } = fixture({ resource: {
    download: async progress => { progress({ event: 'Started', data: {} }); progress({ event: 'Progress', data: { chunkLength: 12 } }); },
    install: async () => { throw new Error('installer locked'); },
  } });
  await updater.check(); await updater.download(); assert.equal(updater.getSnapshot().total, null);
  assert.equal(updater.getSnapshot().downloaded, 12); await updater.install(async () => calls.push('save'));
  assert.equal(updater.getSnapshot().phase, 'error'); assert.equal(updater.getSnapshot().verified, true);
  assert.match(updater.getSnapshot().error, /installer locked/);
  const checks = calls.filter(x => x === 'check').length; await updater.check(); assert.equal(calls.filter(x => x === 'check').length, checks);
  await updater.discard(); assert.equal(updater.getSnapshot().verified, false); assert.equal(updater.getSnapshot().version, '');
  assert.ok(calls.includes('close'));
});
test('failed save or native preparation aborts before starting installer', async () => {
  for (const stage of ['save', 'prepare']) {
    const { updater, calls } = fixture(stage === 'prepare' ? { deps: { prepare: async () => { calls.push('prepare'); throw new Error('stop failed'); } } } : {});
    await updater.check(); await updater.download();
    await updater.install(async () => { calls.push('save'); if (stage === 'save') throw new Error('unsaved settings'); });
    assert.equal(updater.getSnapshot().phase, 'error'); assert.ok(!calls.includes('install'));
    assert.equal(calls.includes('prepare'), stage === 'prepare');
  }
});
test('subscriptions detach; discard failure does not leave a false install/download option', async () => {
  const { updater } = fixture({ resource: { close: async () => { throw new Error('close failed'); } } });
  let notifications = 0; const unsubscribe = updater.subscribe(() => notifications++);
  await updater.check(); assert.ok(notifications > 0); unsubscribe(); const count = notifications;
  await updater.download(); await updater.discard(); assert.equal(notifications, count);
  assert.equal(updater.getSnapshot().phase, 'error'); assert.equal(updater.getSnapshot().version, '');
  assert.equal(updater.getSnapshot().verified, false);
});

// Public example fixture from minisign-verify; no private or production key.
const encoded = text => Buffer.from(text).toString('base64');
const key = encoded('untrusted comment: test public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3');
const sig = encoded('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==');
test('release manifest pins tag and architecture and carries signature contents, not a URL', () => {
  const manifest = makeManifest({ version: '0.1.6', installerName: 'ai-ssh-terminal-client_0.1.6_x64-setup.exe', signature: sig, notes: 'Notes', date: '2026-10-11T00:00:00Z' });
  assert.equal(manifest.version, '0.1.6'); assert.equal(manifest.notes, 'Notes');
  assert.equal(manifest.pub_date, '2026-10-11T00:00:00.000Z');
  assert.equal(manifest.platforms['windows-x86_64'].signature, sig);
  assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/jasonlat-dot/ai-ssh-terminal-client/releases/download/v0.1.6/ai-ssh-terminal-client_0.1.6_x64-setup.exe');
  assert.match(UPDATE_ENDPOINT, /ai-ssh-terminal-client\/releases\/latest\/download\/latest.json$/);
  const renamed = makeManifest({ version: '0.1.10', installerName: 'ShellPilot_0.1.10_x64-setup.exe', signature: sig });
  assert.equal(renamed.platforms['windows-x86_64'].url, 'https://github.com/jasonlat-dot/ai-ssh-terminal-client/releases/download/v0.1.10/ShellPilot_0.1.10_x64-setup.exe');
  assert.equal(renamed.platforms['windows-x86_64'].signature, sig);
});
test('release validation rejects private/invalid keys, prereleases, paths and mismatched installers', () => {
  assert.equal(validatePublicKey(`${key}\n`), key);
  for (const invalid of ['', 'secret key', encoded('untrusted comment: secret key\nAAAA'), encoded('untrusted comment: key\nAAAA')]) assert.throws(() => validatePublicKey(invalid));
  for (const invalid of ['v0.1.6', '0.1.6-beta', '01.1.6', undefined, '0.1']) assert.throws(() => validateVersion(invalid));
  for (const installerName of ['client_0.1.5_x64-setup.exe', '../client_0.1.6_x64-setup.exe', '..\\client_0.1.6_x64-setup.exe', 'client_0.1.6_x86-setup.exe', 'client_0.1.6_x64.msi', 'client_0.1.6_x64junk-setup.exe']) {
    assert.throws(() => makeManifest({ version: '0.1.6', installerName, signature: sig }));
  }
  assert.throws(() => makeManifest({ version: '0.1.6', installerName: 'client_0.1.6_x64-setup.exe', signature: 'https://example.com/pkg.sig' }));
  assert.throws(() => makeManifest({ version: '0.1.6', installerName: 'client_0.1.6_x64-setup.exe', signature: sig, date: 'invalid' }));
});

function ui(initial = {}, component = 'ClientUpdateSettings') {
  let state = { phase: 'available', config, version: '0.1.6', notes: '<script>alert(1)</script>', downloaded: 0, total: null, verified: false, error: '', checkedAt: null, ...initial };
  const calls = [], slots = []; let cursor = 0, tree;
  const beforeInstall = async () => calls.push('save');
  let announce;
  const node = (type, props) => ({ type, props });
  const hooks = { useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = value; }]; }, useEffect() {} };
  const module = load(`components/${component}.tsx`, name => {
    if (name === '../state/useToastError') return loadToastErrorHooks(hooks);
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: node, jsxs: node };
    if (name === '../state/useClientUpdater') return { useClientUpdater: () => state, useStartupUpdateCheck: callback => { announce = callback; }, clientUpdater: {
      check: async () => calls.push('check'), download: async () => calls.push('download'), discard: async () => calls.push('discard'),
      install: async callback => { calls.push('install'); assert.equal(callback, beforeInstall); },
    } };
    if (name === '../state/runtime') return { isTauriRuntime: () => true };
    if (name === '../config/appRuntime') return { APP_VERSION: '0.2.1' };
    if (name === './Ui') return { Badge: 'badge', Icon: 'icon', Modal: 'modal' };
    if (name === '@tauri-apps/plugin-opener') return { openUrl: async () => calls.push('open') };
    if (name.endsWith('.css')) return {};
    throw new Error(name);
  });
  function nodes(item) { if (Array.isArray(item)) return item.flatMap(child => nodes(child));
    if (!item || typeof item !== 'object') return []; return [item, ...nodes(item.props.children)]; }
  function text(item) { if (Array.isArray(item)) return item.map(text).join(''); if (!item || typeof item !== 'object') return typeof item === 'string' ? item : '';
    return text(item.props.children); }
  function render(patch = {}) { state = { ...state, ...patch }; cursor = 0; tree = module[component]({ beforeInstall, onViewUpdate: () => calls.push('view') }); }
  render(); return { calls, render, announce: version => announce(version), nodes: () => nodes(tree), button: label => nodes(tree).find(x => x.type === 'button' && text(x) === label) };
}

test('startup prompt persists until dismissed; viewing uses the guarded settings update flow', () => {
  const view = ui({}, 'StartupUpdatePrompt'); assert.equal(view.nodes().length, 0);
  view.announce('0.1.6'); view.render();
  assert.equal(view.nodes().find(x => x.type === 'modal').props.title, '发现客户端新版本');
  const notes = view.nodes().find(x => x.props.className === 'startup-update-notes');
  assert.equal(notes.props.children, '<script>alert(1)</script>'); assert.equal(notes.props.dangerouslySetInnerHTML, undefined);
  view.render(); assert.ok(view.button('稍后再说'));
  view.button('稍后再说').props.onClick(); view.render(); assert.equal(view.nodes().length, 0); assert.deepEqual(view.calls, []);
  view.announce('0.1.6'); view.render(); view.button('查看并下载更新').props.onClick(); view.render();
  assert.equal(view.nodes().length, 0); assert.deepEqual(view.calls, ['view']);
});

test('startup prompt does not show stale versions or manual check failures', () => {
  const view = ui({}, 'StartupUpdatePrompt'); view.announce('0.1.6'); view.render({ version: '0.1.7' });
  assert.equal(view.nodes().length, 0); view.render({ version: '0.1.6', phase: 'error' }); assert.equal(view.nodes().length, 0);
  const app = source('App.tsx'), dialog = source('components/RustBackendSettingsDialog.tsx');
  assert.ok(!app.includes('useStartupUpdateCheck(notify)'));
  assert.match(app, /return <>\{page\}<StartupUpdatePrompt/);
  assert.match(app, /waitingForBackend && !updateSettingsRequested/);
  assert.match(app, /beforeClientUpdate=\{prepareForClientUpdate\}/);
  assert.match(dialog, /if\(showUpdates\)setTab\('updates'\)/);
});
test('UI blocks unavailable updates, allows configuration-error retry, and renders escaped notes', () => {
  const disabled = ui({ config: { ...config, configured: false }, phase: 'disabled' });
  assert.equal(disabled.button('检查更新').props.disabled, true); assert.equal(disabled.button('下载更新').props.disabled, true);
  const retry = ui({ config: null, phase: 'error', version: '' }); assert.equal(retry.button('检查更新').props.disabled, false);
  const view = ui(); const notes = view.nodes().find(x => x.props.className === 'client-update-notes');
  assert.equal(notes.props.children, '<script>alert(1)</script>'); assert.equal(notes.props.dangerouslySetInnerHTML, undefined);
});
test('UI requires second confirmation, cancel does not install, busy state disables actions', () => {
  const view = ui({ phase: 'downloaded', verified: true });
  assert.equal(view.button('确认安装并重启'), undefined);
  view.button('安装并重启').props.onClick(); view.render(); assert.deepEqual(view.calls, []);
  view.button('取消').props.onClick(); view.render(); assert.deepEqual(view.calls, []);
  assert.equal(view.button('确认安装并重启'), undefined);
  view.button('安装并重启').props.onClick(); view.render(); view.button('确认安装并重启').props.onClick();
  assert.deepEqual(view.calls, ['install']);
  view.render({ phase: 'installing' }); assert.equal(view.button('安装并重启').props.disabled, true);
});
test('UI supports indeterminate/known progress and settings update path works without backend config', () => {
  const view = ui({ phase: 'downloading', total: null, downloaded: 42 });
  assert.equal(view.nodes().find(x => x.type === 'progress').props.value, undefined);
  assert.equal(view.button('下载更新').props.disabled, true);
  view.render({ total: 100, downloaded: 50 }); assert.equal(view.nodes().find(x => x.type === 'progress').props.value, 50);
  const dialog = source('components/RustBackendSettingsDialog.tsx'), app = source('App.tsx');
  assert.doesNotMatch(dialog, /tab==='about'|关于试用版/);
  assert.match(dialog, /settingsNavigation\.map/);
  assert.doesNotMatch(dialog, /BackendConnectionSettings|connection-url/);
  assert.match(app, /await persistClientSession[\s\S]*await cleanupBeforeClose\(5_000\)/);
});
