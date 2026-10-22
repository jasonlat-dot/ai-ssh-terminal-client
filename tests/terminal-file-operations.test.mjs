import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness(options={}){
  const calls=[],valid={current:true},runtime={sessionId:'terminal-one',connectionId:'connection-one'};
  const api={
    async open(...args){calls.push(['open',...args]);await options.open?.(valid);return{sftpSessionId:'metadata-one'};},
    async close(id){calls.push(['close',id]);},
    async deleteEntry(...args){calls.push(['delete',...args]);await options.change?.(valid,calls);},
    async renameEntry(...args){calls.push(['rename',...args]);await options.change?.(valid,calls);},
  };
  const context=vm.createContext({exports:{},Error,TextEncoder,require(name){
    if(name==='../api/sftp')return{sftpApi:api};
    if(name==='./terminalDirectory')return{directoryChild:(path,name)=>`${path.replace(/\/+$/,'')}/${name}`};
    throw new Error(name);
  }});
  vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/state/terminalFileOperations.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return{calls,valid,runtime,...context.exports,run(operation){return context.exports.runSidebarFileOperation(runtime,operation,()=>valid.current);}};
}

test('rename and batch move reuse a temporary session bound to the exact terminal and always close it',async()=>{
  const ui=harness();
  assert.equal(await ui.run({kind:'rename',path:'/home',names:['旧.txt'],value:'新.txt'}),1);
  const open=ui.calls[0];assert.equal(open[1],'connection-one');assert.equal(open[2],'/');assert.equal(open[4],'login');assert.equal(open[6],'terminal-one');
  assert.deepEqual(ui.calls[1],['rename','metadata-one','/home/旧.txt','/home/新.txt']);assert.deepEqual(ui.calls.at(-1),['close','metadata-one']);
  ui.calls.length=0;
  assert.equal(await ui.run({kind:'move',path:'/home',names:['folder','a.txt'],value:'/srv/files/'}),2);
  assert.deepEqual(ui.calls.slice(1,-1),[['rename','metadata-one','/home/folder','/srv/files/folder'],['rename','metadata-one','/home/a.txt','/srv/files/a.txt']]);
});

test('delete is explicit and recursive, a mid-batch failure stops remaining items and reports completed count',async()=>{
  let count=0;
  const ui=harness({change:()=>{if(++count===2)throw new Error('权限不足');}});
  await assert.rejects(ui.run({kind:'delete',path:'/home',names:['folder','denied','not-touched'],value:''}),/denied.*权限不足.*已完成 1 项/);
  assert.deepEqual(ui.calls.slice(1,-1),[['delete','metadata-one','/home/folder',true],['delete','metadata-one','/home/denied',true]]);
  assert.deepEqual(ui.calls.at(-1),['close','metadata-one']);
});

test('identity changes before opening or while connecting never write, and changes between items stop the rest',async()=>{
  const early=harness();early.valid.current=false;
  await assert.rejects(early.run({kind:'delete',path:'/home',names:['a'],value:''}),/访问身份已变化/);assert.equal(early.calls.length,0);
  const opening=harness({open:valid=>{valid.current=false;}});
  await assert.rejects(opening.run({kind:'delete',path:'/home',names:['a'],value:''}),/访问身份已变化/);
  assert.deepEqual(opening.calls.map(call=>call[0]),['open','close']);
  const batch=harness({change:valid=>{valid.current=false;}});
  await assert.rejects(batch.run({kind:'move',path:'/home',names:['a','b'],value:'/srv'}),/已完成 1 项/);
  assert.deepEqual(batch.calls.map(call=>call[0]),['open','rename','close']);
});

test('invalid names, traversal, unchanged destinations and moving inside itself are rejected before connecting',async()=>{
  const ui=harness();
  for(const operation of [
    {kind:'rename',path:'/home',names:['a'],value:'../x'},
    {kind:'rename',path:'/home',names:['a','b'],value:'new'},
    {kind:'move',path:'/home',names:['folder'],value:'/home/folder/subdir'},
    {kind:'move',path:'/home',names:['folder'],value:'/home'},
    {kind:'move',path:'/home',names:['a'],value:'/srv/../escape'},
    {kind:'move',path:'/home',names:['a'],value:''},
    {kind:'delete',path:'/home',names:['bad\n'],value:''},
    {kind:'delete',path:'/home',names:[],value:''},
  ])await assert.rejects(ui.run(operation));
  assert.equal(ui.calls.length,0);
});
