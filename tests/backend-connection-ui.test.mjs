import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function config(storage) {
  const compiled = ts.transpileModule(source('config/backend.ts'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const context = vm.createContext({ exports: {}, localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key,value) => storage.set(key,value),
  } });
  vm.runInContext(compiled,context);
  return context.exports;
}

test('old remote profiles cannot choose an application backend',()=>{
  const storage=new Map([['agent-ssh-backend-connections-v2',JSON.stringify({version:2,activeId:'remote',profiles:[
    {id:'remote',kind:'remote',url:'https://retired.example.test'}]})]]);
  const backend=config(storage);
  assert.equal(backend.readBackendUrl(),'ipc://builtin');
  assert.throws(()=>backend.saveBackendUrl('https://retired.example.test'));
  assert.throws(()=>backend.saveBackendUrl('http://127.0.0.1:8889'));
  assert.equal(backend.readBackendUrl(),'ipc://builtin');
});

test('workspace identities change while the remembered tab key remains stable',()=>{
  const old='http://127.0.0.1:45678';
  const history=JSON.stringify([{id:'remembered-local-tab'}]);
  const storage=new Map([
    ['agent-ssh-backend-connections-v2',JSON.stringify({profiles:[{id:'builtin',kind:'builtin',url:old}]})],
    [`agent-ssh-terminal-sessions-v1:${old}`,history],
  ]);
  const backend=config(storage);
  const first='ipc://builtin/00000000-0000-4000-8000-000000000001';
  const second='ipc://builtin/00000000-0000-4000-8000-000000000002';
  backend.adoptBundledBackendUrl(first);
  backend.adoptBundledBackendUrl(second);
  assert.equal(backend.readBackendUrl(),second);
  assert.equal(backend.backendWorkspaceKey(first),backend.backendWorkspaceKey(second));
  assert.equal(storage.get('agent-ssh-terminal-sessions-v1:ipc://builtin'),history);
});
