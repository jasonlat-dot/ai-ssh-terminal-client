import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function clock() {
  let time = 0, next = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, delay) { const id = ++next; jobs.set(id, { at: time + delay, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(ms) {
      const until = time + ms;
      for (;;) {
        const due = [...jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at; jobs.delete(due[0]); due[1].fn();
      }
      time = until;
    },
    get pending() { return jobs.size; },
  };
}

function harness({ desktop = true, delayShow = false, hookOnly = false } = {}) {
  const timers = clock(), slots = [], effects = [], shows = [], probes = [], listeners = new Set();
  let cursor = 0, output, updates = 0;
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial,
        set(value) { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; updates++; } };
      return [slots[i].value, slots[i].set];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps, effect: fn };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const jsx = (type, props) => ({ type, props });
  const globals = {
    ...hooks, AbortController, console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    window: { clearTimeout: timers.clearTimeout, setTimeout: timers.setTimeout },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === '@tauri-apps/api/window') return { getCurrentWindow: () => ({ show() {
        const pending = deferred(); shows.push(pending); if (!delayShow) pending.resolve(); return pending.promise;
      } }) };
      throw new Error(`Unexpected import ${name}`);
    },
  };
  const load = (source, filename) => {
    const module = { exports: {} };
    const code = ts.transpileModule(source, { fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(code, { ...globals, module, exports: module.exports }, { filename });
    return module.exports;
  };
  const { useStartupMinimum } = load(readFileSync('src/state/useStartupMinimum.ts', 'utf8'), 'useStartupMinimum.ts');
  const { useStartupTransition } = load(readFileSync('src/state/useStartupTransition.ts', 'utf8'), 'useStartupTransition.ts');
  Object.assign(globals, {
    useStartupMinimum, useStartupTransition, isTauriRuntime: () => desktop,
    useTheme: () => ({ theme: 'light', setTheme() {} }), useApplyClientAppearance() {},
    useApplyClientTextColors() {}, useApplyClientTypography() {},
    readBackendUrl: () => 'ipc://builtin/e6', saveBackendUrl: value => value,
    adoptBundledBackendUrl: value => value || 'ipc://builtin/e6',
    watchBundledBackendStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    restartBundledBackend: async () => ({ revision: 10, status: 'running', backendUrl: 'ipc://builtin/retry' }),
    probeBackendHealth(options) { const pending = deferred(); probes.push({ ...pending, ...options }); return pending.promise; },
    errorMessage: error => String(error),
    StartupScreen: 'StartupScreen', AppContent: 'AppContent', BackendSettingsDialog: 'BackendSettingsDialog',
    StartupUpdatePrompt: 'StartupUpdatePrompt', NotificationCenter: 'NotificationCenter',
  });
  const source = readFileSync('src/App.tsx', 'utf8');
  const app = hookOnly ? () => useStartupMinimum(desktop)
    : load(source.slice(source.indexOf('export default function App()')), 'AppRoot.tsx').default;
  const ui = {
    timers, shows, probes,
    render() { cursor = 0; output = app(); while (effects.length) effects.shift()(); return ui.page; },
    async settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); ui.render(); },
    emit(status, revision) { for (const listener of [...listeners]) listener({ status, revision, message: status, logPath: null, backendUrl: 'ipc://builtin/e6' }); },
    health(index, ok) { probes[index].resolve({ ok, backendUrl: probes[index].backendUrl, latencyMs: 1, message: ok ? null : 'not ready', checkedAt: '2026-10-18' }); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    replayEffects() { for (const slot of slots) if (slot?.effect) { slot.cleanup?.(); slot.cleanup = slot.effect(); } },
    get updates() { return updates; },
    get page() { return hookOnly ? output : output.props.children[0]; },
  };
  ui.render(); return ui;
}

test('fast healthy services still wait for 2000 ms of visible startup time', async () => {
  const ui = harness(); await ui.settle(); ui.emit('running', 1); ui.health(0, true); await ui.settle();
  assert.equal(ui.page.type, 'StartupScreen'); assert.equal(ui.page.props.phase, 'ready');
  ui.timers.advance(1999); ui.render(); assert.equal(ui.page.type, 'StartupScreen');
  ui.timers.advance(1); ui.render(); assert.equal(ui.page.type, 'StartupScreen');
  ui.timers.advance(219); ui.render(); assert.equal(ui.page.type, 'StartupScreen');
  ui.timers.advance(1); ui.render(); assert.equal(ui.page.type, 'AppContent'); ui.unmount();
});

test('elapsed minimum cannot bypass a slow or unhealthy service; retry requires a fresh healthy instance', async () => {
  const ui = harness(); await ui.settle(); ui.timers.advance(2000); ui.emit('starting', 1); ui.render();
  assert.equal(ui.page.type, 'StartupScreen');
  ui.emit('running', 2); ui.health(0, false); await ui.settle();
  assert.equal(ui.page.type, 'StartupScreen'); assert.equal(ui.page.props.phase, 'failed');
  ui.page.props.onRetry(); await ui.settle(); assert.equal(ui.probes.length, 2);
  assert.equal(ui.page.type, 'StartupScreen'); ui.health(1, true); await ui.settle(); ui.timers.advance(220); ui.render();
  assert.equal(ui.page.type, 'AppContent'); ui.unmount();
});

test('native failure while health is pending invalidates a late UP response', async () => {
  const ui = harness(); await ui.settle(); ui.emit('running', 1); ui.emit('failed', 2);
  assert.equal(ui.probes[0].signal.aborted, true); ui.health(0, true); await ui.settle();
  ui.timers.advance(3000); ui.render();
  assert.equal(ui.page.type, 'StartupScreen'); assert.equal(ui.page.props.phase, 'failed'); ui.unmount();
});

test('service stopping after successful health but before 2000 ms prevents admission', async () => {
  const ui = harness(); await ui.settle(); ui.emit('running', 1); ui.health(0, true); await ui.settle();
  ui.emit('stopped', 2); ui.timers.advance(2000); ui.render();
  assert.equal(ui.page.type, 'StartupScreen'); assert.equal(ui.page.props.phase, 'stopped');
  assert.equal(ui.page.props.onContinue, undefined); ui.unmount();
});

test('duplicate or stale native statuses neither re-probe nor reset the minimum', async () => {
  const ui = harness(); await ui.settle(); ui.timers.advance(1500); ui.emit('running', 2);
  ui.emit('starting', 1); ui.emit('running', 2); assert.equal(ui.probes.length, 1);
  ui.health(0, true); await ui.settle(); ui.timers.advance(500); ui.render();
  ui.timers.advance(220); ui.render(); assert.equal(ui.page.type, 'AppContent'); assert.equal(ui.shows.length, 1); ui.unmount();
});

test('minimum starts after window.show resolves, not while the WebView is hidden', async () => {
  const ui = harness({ delayShow: true, hookOnly: true });
  ui.timers.advance(9000); ui.render(); assert.equal(ui.page, false); assert.equal(ui.timers.pending, 0);
  ui.shows[0].resolve(); await ui.settle(); ui.timers.advance(1999); ui.render(); assert.equal(ui.page, false);
  ui.timers.advance(1); ui.render(); assert.equal(ui.page, true); ui.unmount();
});

test('StrictMode effect replay discards the first show continuation and cleans pending timers', async () => {
  const ui = harness({ delayShow: true, hookOnly: true }); ui.replayEffects();
  ui.shows[0].resolve(); await ui.settle(); assert.equal(ui.timers.pending, 0);
  ui.shows[1].resolve(); await ui.settle(); assert.equal(ui.timers.pending, 1);
  ui.unmount(); ui.timers.advance(2000); ui.render(); assert.equal(ui.page, false);
});

test('unmount aborts health and ignores its late response', async () => {
  const ui = harness(); await ui.settle(); ui.emit('running', 1); ui.unmount();
  const before = ui.updates; ui.health(0, true); await ui.settle();
  assert.equal(ui.probes[0].signal.aborted, true); assert.equal(ui.updates, before);
});

test('browser development does not wait for unavailable native window or services', async () => {
  const ui = harness({ desktop: false }); await ui.settle();
  assert.equal(ui.page.type, 'AppContent'); assert.equal(ui.shows.length, 0); assert.equal(ui.probes.length, 0); ui.unmount();
});


test('a native failure during fade-out cancels workspace admission and restores the error screen', async () => {
  const ui = harness(); await ui.settle(); ui.timers.advance(2000); ui.emit('running', 1);
  ui.health(0, true); await ui.settle(); ui.render(); assert.equal(ui.page.props.exiting, true);
  ui.timers.advance(100); ui.emit('failed', 2); ui.render();
  ui.timers.advance(300); ui.render();
  assert.equal(ui.page.type, 'StartupScreen'); assert.equal(ui.page.props.phase, 'failed');
  assert.equal(ui.page.props.exiting, false); ui.unmount();
});
