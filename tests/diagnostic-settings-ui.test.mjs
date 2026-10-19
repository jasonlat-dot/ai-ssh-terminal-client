import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {loadToastErrorHooks} from './helpers/toast-errors.mjs';

function harness(fail=false) {
  let config={applicationFile:'C:/workspace/workspace.json',sqliteFile:'C:/data/db',uploadDirectory:'C:/data/files',logDirectory:'C:/workspace/logs',traceLogDirectory:'C:/workspace/logs/agent',values:{dataDirectory:{value:'C:/data'},fileStorageEnabled:{value:'true'},maxStorageMiB:{value:'1024'},fileRetentionDays:{value:'0'},logLevel:{value:'info'}}};
  const slots=[],effects=[],saved=[],notices=[],opened=[];let cursor=0,tree,restarted=0;
  const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useEffect(effect,deps){const i=cursor++;if(!slots[i]||deps.some((value,index)=>value!==slots[i][index])){slots[i]=deps;effects.push(effect);}}};
  const leaf=()=>null;
  const code=ts.transpileModule(readFileSync(new URL('../src/components/RustBackendSettingsDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({exports:{},Error,require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='../state/useToastError')return loadToastErrorHooks(hooks,(message,type)=>notices.push({message,type}));
    if(name==='../state/notifications')return {notify:(message,type)=>notices.push({message,type})};
    if(name==='@tauri-apps/plugin-opener')return {openPath:async path=>opened.push(path),revealItemInDir:async()=>{}};
    if(name==='../api/bundledBackend')return {readBundledBackendConfig:async()=>config,readBundledBackendAutoStart:async()=>true,watchBundledBackendStatus:()=>()=>{},restartBundledBackend:async()=>{restarted++;},saveBundledBackendConfig:async update=>{saved.push(update);if(fail)throw new Error('模拟日志配置保存失败');config={...config,values:{...config.values,...Object.fromEntries(Object.entries(update.values).map(([key,value])=>[key,{value}]))}};return config;}};
    if(name==='../config/appRuntime')return {APP_VERSION:'0.2.1'};
    if(name==='../state/runtime')return {isTauriRuntime:()=>true};
    if(name==='../state/appWindow')return {dragAppWindow(){}};
    if(name==='../config/settingsNavigation')return {settingsNavigation:[]};
    if(name==='./Ui')return {Icon:leaf,Badge:leaf,Toggle:leaf,IconHeading:leaf,AccentIcon:leaf};
    if(name.endsWith('.css'))return {};
    if(name.startsWith('./'))return {[name.slice(2)]:leaf};
    throw new Error(name);
  }});vm.runInContext(code,context);
  function render(){cursor=0;tree=context.exports.RustBackendSettingsDialog({currentUrl:'ipc://builtin/test',onClose(){},onSave(){}});while(effects.length)effects.shift()();}
  function all(node=tree){return Array.isArray(node)?node.flatMap(all):node?.props?[node,...all(node.props.children??null)]:[];}
  function text(node=tree){return Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children??null):typeof node==='string'?node:'';}
  const find=predicate=>all().find(predicate);
  render();return {saved,notices,opened,render,find,text,get restarted(){return restarted;},async settle(){await new Promise(setImmediate);render();}};
}

test('日志级别从本地配置恢复，切换立即单独保存且不重启工作区',async()=>{
  const h=harness();await h.settle();const select=()=>h.find(node=>node.props.id==='workspace-log-level');
  assert.equal(select().props.value,'info');assert.deepEqual(Array.from(select().props.options,option=>option.value),['debug','info','warn','error']);
  h.find(node=>node.props.id==='workspace-data-directory').props.onChange({target:{value:'D:/unsaved'}});h.render();
  select().props.onChange('debug');await h.settle();
  assert.equal(select().props.value,'debug');assert.deepEqual(JSON.parse(JSON.stringify(h.saved[0])),{values:{logLevel:'debug'}});
  assert.equal(h.restarted,0);assert.equal(h.find(node=>node.props.id==='workspace-data-directory').props.value,'D:/unsaved');
  assert.equal(h.notices.at(-1).type,'success');assert.match(h.notices.at(-1).message,/立即生效/);
});

test('日志级别保存失败保留原值，使用 Toast 并恢复控件',async()=>{
  const h=harness(true);await h.settle();h.find(node=>node.props.id==='workspace-log-level').props.onChange('error');await h.settle();
  const select=h.find(node=>node.props.id==='workspace-log-level');assert.equal(select.props.value,'info');assert.equal(select.props.disabled,false);
  assert.equal(h.notices.at(-1).type,'error');assert.match(h.notices.at(-1).message,/模拟日志配置保存失败/);assert.equal(h.find(node=>node.props.role==='alert'),undefined);
});

test('日志设置展示日期和 Trace ID 规则，可直接打开专用目录',async()=>{
  const h=harness();await h.settle();assert.match(h.text(),/Trace ID/);
  h.find(node=>node.type==='button'&&node.props.children?.some?.(child=>child==='打开日志目录')).props.onClick();await h.settle();
  assert.deepEqual(h.opened,['C:/workspace/logs/agent']);
});

test('原生日志目录打开权限仅限定到应用诊断目录',()=>{
  const capability=JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json',import.meta.url),'utf8'));
  const permission=capability.permissions.find(value=>value.identifier==='opener:allow-open-path');
  assert.deepEqual(permission.allow,[{path:'$APPLOCALDATA/logs/agent'}]);
});
