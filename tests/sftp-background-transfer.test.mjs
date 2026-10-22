import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.createSourceFile('useSftp.ts',readFileSync(new URL('../src/state/useSftp.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let completedEffect;
function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('settledTasks.current'))completedEffect=node.arguments[0].getText(source);
  ts.forEachChild(node,visit);
}
visit(source);assert.ok(completedEffect);
function harness(){
  const calls=[];
  const context=vm.createContext({exports:{},phase:'ready',tasks:[],settledTasks:{current:new Map()},local:{path:'C:\\downloads'},remotePath:'/home',
    loadLocal:path=>calls.push(['local',path]),loadRemote:path=>calls.push(['remote',path])});
  vm.runInContext(ts.transpileModule(`exports.refresh=${completedEffect}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return{context,calls,apply:()=>context.exports.refresh()};
}
const task=(status,completedItems=0,failedItems=0)=>({transferId:'one',progress:{status,completedItems,failedItems}});

test('后台任务完成后刷新当前目录，重复进度通知不重复刷新，切换目录不再读取旧目录',()=>{
  const ui=harness();ui.context.tasks=[task('RUNNING')];ui.apply();assert.equal(ui.calls.length,0);
  ui.context.local.path='D:\\current';ui.context.remotePath='/next';ui.context.tasks=[task('COMPLETED',1)];ui.apply();
  assert.deepEqual(ui.calls,[['local','D:\\current'],['remote','/next']]);
  ui.apply();assert.equal(ui.calls.length,2);
  ui.context.tasks=[task('RUNNING')];ui.apply();ui.context.tasks=[task('COMPLETED',1)];ui.apply();assert.equal(ui.calls.length,4,'重试完成后重新刷新');
});

test('失败批次后续成功项和取消结果也刷新；会话关闭及队列回收会清除旧记录',()=>{
  const ui=harness();ui.context.tasks=[task('FAILED',0,1)];ui.apply();assert.equal(ui.calls.length,2);
  ui.context.tasks=[task('FAILED',1,1)];ui.apply();assert.equal(ui.calls.length,4);
  ui.context.tasks=[task('CANCELLED',1,1)];ui.apply();assert.equal(ui.calls.length,6);
  ui.context.tasks=[];ui.apply();assert.equal(ui.context.settledTasks.current.size,0);
  ui.context.tasks=[task('COMPLETED',1)];ui.apply();assert.equal(ui.context.settledTasks.current.size,1);
  ui.context.phase='closed';ui.apply();assert.equal(ui.context.settledTasks.current.size,0);assert.equal(ui.calls.length,8);
});
