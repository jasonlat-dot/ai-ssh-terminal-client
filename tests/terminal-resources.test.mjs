import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const sample = (patch = {}) => ({ sampledAtMs: 1700000010000, supported: true, stale: false, message: null,
  cpuPercent: 25, memoryTotalBytes: 100000, memoryUsedBytes: 60000, uptimeSeconds: 90061, bootTimeSeconds: 1700000000,
  network: [{ name: 'eth0', primary: true, receiveBytesPerSecond: 1024, transmitBytesPerSecond: 2048 }],
  disks: [{ mountPoint: '/', totalBytes: 100000, usedBytes: 40000, availableBytes: 60000, usePercent: 40 }], ...patch });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(hidden = false) {
  const jobs = new Map(), listeners = new Map(), requests = [], received = [], failures = [];
  let now = 0, id = 0;
  const document = { hidden, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const context = vm.createContext({ exports: {}, AbortController, document,
    setTimeout: (fn, delay) => { jobs.set(++id, { fn, at: now + delay }); return id; }, clearTimeout: id => jobs.delete(id) });
  vm.runInContext(compile(source('state/terminalResources.ts')), context);
  const watcher = context.exports.watchTerminalResources(signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })), value => received.push(value), error => failures.push(error));
  return { ...context.exports, watcher, requests, received, failures, jobs, listeners,
    visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')?.(); },
    async advance(ms) { now += ms; for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.fn(); } await flush(); },
  };
}
test('polling never overlaps and uses a 5 second interval after the previous response', async () => {
  const ui = harness(); assert.equal(ui.requests.length, 1);
  await ui.advance(30000); ui.watcher.refresh(); assert.equal(ui.requests.length, 1);
  ui.requests[0].resolve(sample()); await flush(); assert.equal(ui.received.length, 1);
  await ui.advance(4999); assert.equal(ui.requests.length, 1);
  await ui.advance(1); assert.equal(ui.requests.length, 2);
  ui.requests[1].reject(new Error('offline')); await flush();
  await ui.advance(14999); assert.equal(ui.requests.length, 2);
  await ui.advance(1); assert.equal(ui.requests.length, 3); ui.watcher.stop();
  assert.ok(ui.requests[2].signal.aborted); assert.equal(ui.jobs.size, 0);
});
test('hidden pages pause, resume immediately, and ignore late responses after switching or stopping', async () => {
  const ui = harness(true); assert.equal(ui.requests.length, 0);
  ui.visibility(false); assert.equal(ui.requests.length, 1);
  ui.visibility(true); assert.ok(ui.requests[0].signal.aborted);
  ui.visibility(false); assert.equal(ui.requests.length, 2);
  ui.requests[0].resolve(sample({ cpuPercent: 99 })); await flush(); assert.equal(ui.received.length, 0);
  ui.requests[1].resolve(sample()); await flush(); assert.equal(ui.received.length, 1);
  ui.watcher.refresh(); ui.watcher.stop(); ui.requests[2].resolve(sample()); await flush();
  assert.equal(ui.received.length, 1); assert.equal(ui.listeners.size, 0); assert.equal(ui.jobs.size, 0);
});
test('unsupported systems stop polling; explicit refresh retries and stale snapshots back off', async () => {
  const ui = harness(); ui.requests[0].resolve(sample({ supported: false })); await flush();
  await ui.advance(60000); assert.equal(ui.requests.length, 1);
  ui.watcher.refresh(); ui.requests[1].resolve(sample({ stale: true })); await flush();
  await ui.advance(5000); assert.equal(ui.requests.length, 2);
  await ui.advance(10000); assert.equal(ui.requests.length, 3); ui.watcher.stop();
});
test('formatters keep unknown values distinct from measured zero and use server byte rates', () => {
  const ui = harness(true);
  assert.equal(ui.resourceBytes(null, true), '—'); assert.equal(ui.resourceBytes(0, true), '0 B/s');
  assert.equal(ui.resourceBytes(2048, true), '2.0 KiB/s'); assert.equal(ui.resourceBytes(1024 ** 3), '1.0 GiB');
  assert.equal(ui.resourcePercent(null), '—'); assert.equal(ui.resourcePercent(0), '0.0%');
  assert.equal(ui.resourceUptime(90061), '1天 1时'); assert.equal(ui.resourceUptime(null), '—'); ui.watcher.stop();
});
function render(snapshot, { stateSession = 'session', connected = true, error = null } = {}) {
  const utils = harness(true); utils.watcher.stop();
  const context = vm.createContext({ exports: {}, require(name) {
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react') return { ...React, useEffect() {}, useRef: () => ({ current: null }), useState: initial => [initial && typeof initial === 'object' && 'sessionId' in initial ? { sessionId: stateSession, sample: snapshot, error } : initial, () => {}] };
    if (name.endsWith('terminalResources')) return utils;
    if (name === './Ui') return { Icon: () => React.createElement('svg', { 'aria-hidden': true }) };
    if (name.endsWith('.css')) return {};
    throw new Error(name);
  } });
  vm.runInContext(compile(source('components/TerminalResources.tsx')), context);
  return renderToStaticMarkup(React.createElement(context.exports.TerminalResources, { runtime: { sessionId: 'session', resources() {} }, visible: true, connected, title: 'WSL' }));
}
test('status bar and details show the right metrics, server directions, boot time and disk', () => {
  const html = render(sample());
  for (const value of ['25%', '60%', '40%', 'eth0', '2.0 KiB/s', '1.0 KiB/s', '1天 1时', '开机', 'WSL', '暂停监控']) assert.ok(html.includes(value), value);
  assert.match(html, /服务器上传/); assert.match(html, /服务器下载/); assert.match(html, /<summary[^>]*aria-label=/);
});
test('loading, stale and session replacement never show invented zero or another server data', () => {
  const empty = render(null); assert.ok(empty.includes('采样中')); assert.ok(!empty.includes('<meter')); assert.ok(!empty.includes('0.0%'));
  const old = render(sample(), { connected: false }); assert.match(old, /data-stale="true"/); assert.ok(old.includes('上次采样值'));
  const stale = render(sample(), { error: '采集失败' }); assert.ok(stale.includes('旧数据')); assert.ok(stale.includes('25%'));
  const switched = render(sample(), { stateSession: 'other-session' }); assert.ok(!switched.includes('25%')); assert.ok(!switched.includes('eth0'));
});

test('首次明确等待约 5 秒，后续显示测得网速，零流量仍是有效测量', () => {
  const first = render(sample({ cpuPercent: null, network: [{ name: 'eth0', primary: true, receiveBytesPerSecond: null, transmitBytesPerSecond: null }] }));
  assert.ok(first.includes('约 5 秒后更新')); assert.ok(!first.includes('相邻两次采样'));
  const measured = render(sample({ network: [{ name: 'eth0', primary: true, receiveBytesPerSecond: 0, transmitBytesPerSecond: 10240 }] }));
  assert.ok(measured.includes('0 B/s')); assert.ok(measured.includes('10 KiB/s')); assert.ok(!measured.includes('采样中'));
});
