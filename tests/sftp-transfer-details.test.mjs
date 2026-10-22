import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as details from '../src/state/sftpTransferDetails.ts';
import * as sftp from '../src/state/sftp.ts';

const item=(path,status='PENDING',patch={})=>({itemId:path,relativePath:path,kind:'FILE',size:100,transferredBytes:0,status,errorCode:null,message:null,...patch});
function task(items,patch={}){return {transferId:'task-one',sftpSessionId:'session-one',direction:'UPLOAD',remotePath:'/home',items,
  progress:{transferId:'task-one',direction:'UPLOAD',status:'RUNNING',totalBytes:300,transferredBytes:100,completedItems:1,totalItems:items.length,failedItems:1,awaitingConfirmation:0,updatedAt:'2026-10-22T00:00:00Z',activeItems:[]},...patch};}

test('task type comes from the shallowest manifest item, including empty directories and ordinary files',()=>{
  const dir=task([item('logs/nested/file.log'),item('logs','COMPLETED',{kind:'DIRECTORY',size:0}),item('logs/empty','COMPLETED',{kind:'DIRECTORY',size:0})]);
  assert.deepEqual(details.transferIdentity(dir),{name:'logs',relativePath:'logs',kind:'DIRECTORY',fileCount:1,directoryCount:2,location:'上传到 /home'});
  assert.equal(details.transferIdentity(task([item('empty','PENDING',{kind:'DIRECTORY',size:0})])).kind,'DIRECTORY');
  assert.equal(details.transferIdentity(task([item('a.txt')])).kind,'FILE');
  assert.equal(details.transferIdentity(task([])).kind,undefined);
});

test('active item progress overlays saved snapshots without changing completed, skipped or pending files',()=>{
  const dir=task([item('logs/done','COMPLETED',{transferredBytes:100}),item('logs/active'),item('logs/skip','SKIPPED'),item('logs/pending')]);
  dir.progress.activeItems=[item('logs/active','RUNNING',{transferredBytes:42})];
  const rows=details.transferItems(dir);
  assert.equal(rows[1].status,'RUNNING');assert.equal(details.itemPercent(rows[1]),42);
  assert.equal(rows[0].status,'COMPLETED');assert.equal(rows[2].status,'SKIPPED');assert.equal(rows[3].status,'PENDING');
  assert.equal(dir.items[1].status,'PENDING','never mutate task snapshot');
  assert.deepEqual(rows.filter(details.itemUnfinished).map(row=>row.relativePath),['logs/active','logs/pending']);
});

test('100% bytes is never a completed status; zero-byte files, skipped entries and local confirmation stay distinct',()=>{
  const transfer=task([item('a','SENT',{transferredBytes:100}),item('zero','PENDING',{size:0}),item('skipped','SKIPPED')],{direction:'DOWNLOAD'});
  const rows=details.transferItems(transfer,{'a':60,'zero':99,'skipped':100});
  assert.equal(rows[0].status,'SENT');assert.equal(details.itemPercent(rows[0]),60);
  assert.equal(details.itemPercent(rows[1]),null);assert.equal(details.itemPercent(rows[2]),null);
  assert.equal(details.itemPercent(item('zero','COMPLETED',{size:0})),100);
  assert.equal(details.itemPercent(item('failed','FAILED',{transferredBytes:100})),100);
  assert.equal(details.itemUnfinished(item('failed','FAILED',{transferredBytes:100})),true);
  assert.equal(details.transferItemStatus.SENT,'待本地保存确认');
});

test('cancelled tasks retain completed and failed results while remaining entries display cancelled',()=>{
  const transfer=task([item('done','COMPLETED'),item('bad','FAILED',{message:'连接中断'}),item('pending'),item('skip','SKIPPED')]);
  transfer.progress.status='CANCELLED';
  const rows=details.transferItems(transfer);
  assert.deepEqual(rows.map(row=>row.status),['COMPLETED','FAILED','CANCELLED','SKIPPED']);assert.equal(rows[1].message,'连接中断');
});

function harness(transfer){
  const slots=[];let cursor=0,tree;const calls=[];
  const props={task:transfer,ready:true,working:false,cancelling:false,retry:()=>calls.push('retry'),cancel:()=>calls.push('cancel')};
  const context=vm.createContext({exports:{},require(name){
    if(name==='react')return {useId:()=> 'items-one',useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];}};
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='../state/sftp')return sftp;
    if(name==='../state/sftpTransferDetails')return details;
    if(name==='./Ui')return {Badge:'badge',Icon:'icon'};
    throw new Error(name);
  }});
  vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/components/SftpTransferTask.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const visit=node=>Array.isArray(node)?node.flatMap(child=>visit(child)):node?.props?[node,...visit(node.props.children)]:[];
  const all=()=>visit(tree);
  const render=()=>{cursor=0;tree=context.exports.SftpTransferTask(props);};render();
  const text=node=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'||typeof node==='number'?String(node):'';
  return {props,calls,render,all,find:fn=>all().find(fn),text:()=>text(tree),expand(){all().find(node=>node.type==='details').props.onToggle({currentTarget:{open:true}});render();}};
}

test('directory details expose all paths, failure reasons, filters and existing task retry action',()=>{
  const ui=harness(task([item('logs','COMPLETED',{kind:'DIRECTORY',size:0}),item('logs/done','COMPLETED'),item('logs/error.log','FAILED',{message:'网络连接中断'}),item('logs/pending'),item('logs/skipped','SKIPPED')]));
  assert.ok(ui.text().includes('目录'));assert.ok(ui.text().includes('4 个文件'));assert.ok(ui.text().includes('文件已完成 1 · 已跳过 1'));
  assert.equal(ui.all().filter(node=>node.type==='li').length,0,'collapsed details avoid rendering large manifests');
  ui.expand();assert.equal(ui.all().filter(node=>node.type==='li').length,5);assert.ok(ui.text().includes('网络连接中断'));
  ui.find(node=>node.type==='button'&&node.props.children[0]==='失败').props.onClick();ui.render();
  assert.equal(ui.all().filter(node=>node.type==='li').length,1);assert.ok(ui.text().includes('logs/error.log'));
  ui.find(node=>node.type==='button'&&node.props.children[0]==='未完成').props.onClick();ui.render();
  assert.equal(ui.all().filter(node=>node.type==='li').length,2);assert.ok(ui.text().includes('logs/pending'));
  ui.find(node=>node.type==='button'&&node.props.children==='重查并重试未完成项').props.onClick();assert.deepEqual(ui.calls,['retry']);
  ui.props.working=true;ui.render();assert.equal(ui.find(node=>node.props.children==='重查并重试未完成项').props.disabled,true);
});

test('completed directory manifests remain expandable and large lists can reveal every entry',()=>{
  const transfer=task(Array.from({length:205},(_,i)=>item(`logs/${i}`,'COMPLETED')));transfer.items.unshift(item('logs','COMPLETED',{kind:'DIRECTORY',size:0}));transfer.progress.status='COMPLETED';
  const ui=harness(transfer);ui.expand();assert.equal(ui.all().filter(node=>node.type==='li').length,100);
  ui.find(node=>node.props.className==='sftp-task-show-more').props.onClick();ui.render();assert.equal(ui.all().filter(node=>node.type==='li').length,200);
  ui.find(node=>node.props.className==='sftp-task-show-more').props.onClick();ui.render();assert.equal(ui.all().filter(node=>node.type==='li').length,206);
  assert.ok(!ui.find(node=>node.props.className==='sftp-task-show-more'));
  ui.find(node=>node.type==='button'&&node.props.children[0]==='未完成').props.onClick();ui.render();assert.ok(ui.text().includes('所有条目均已完成或跳过'));
  assert.ok(!ui.find(node=>node.props.children==='重查并重试未完成项'));
});

test('ordinary file type and cancelled local preparation errors remain visible',()=>{
  const transfer=task([item('a.txt')]);transfer.progress.status='CANCELLED';
  const ui=harness(transfer);ui.props.error='本地目标已存在，不会覆盖';ui.render();ui.expand();
  assert.ok(ui.text().includes('查看文件明细'));assert.ok(ui.text().includes('已取消'));assert.ok(ui.text().includes('本地目标已存在，不会覆盖'));
});

test('expanded details update active progress without closing, and a failed 100% task never claims to be committing',()=>{
  const transfer=task([item('a.txt','RUNNING',{transferredBytes:10})]);
  const ui=harness(transfer);ui.expand();assert.ok(ui.text().includes('10%'));
  ui.props.task={...transfer,progress:{...transfer.progress,activeItems:[item('a.txt','RUNNING',{transferredBytes:73})]}};ui.render();
  assert.equal(ui.all().filter(node=>node.type==='li').length,1);assert.ok(ui.text().includes('73%'));
  ui.props.task={...transfer,items:[item('a.txt','FAILED',{transferredBytes:100,message:'连接中断'})],progress:{...transfer.progress,status:'FAILED',totalBytes:100,transferredBytes:100}};ui.render();
  assert.ok(ui.text().includes('连接中断'));assert.ok(!ui.text().includes('正在提交或等待确认'));
});
