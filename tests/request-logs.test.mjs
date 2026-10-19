import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/api/requestLogs.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function api(desktop, invoke) {
  const context = vm.createContext({ exports: {}, Error, require(name) {
    if (name === '@tauri-apps/api/core') return { invoke };
    if (name === '../state/runtime') return { isTauriRuntime: () => desktop };
    throw Error(name);
  } });
  vm.runInContext(code, context);
  return context.exports;
}
test('Log reveal sends only the exact Trace ID to the registered native command', async () => {
  const calls = [];
  await api(true, async (...args) => calls.push(args)).revealRequestLog('trace-123');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['bundled_backend_reveal_request_log', { traceId: 'trace-123' }]]);
  const native = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(native, /bundled_backend::bundled_backend_reveal_request_log,/);
});
test('Native lookup errors become readable errors instead of silently succeeding', async () => {
  await assert.rejects(api(true, async () => { throw '未找到日志，可能已过期清理'; }).revealRequestLog('trace-123'), /过期清理/);
});
test('Browser-only mode does not invoke native file operations', async () => {
  await assert.rejects(api(false, () => assert.fail('no native calls')).revealRequestLog('trace-123'), /桌面客户端/);
});
