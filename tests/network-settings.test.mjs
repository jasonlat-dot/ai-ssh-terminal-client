import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function ui() {
  const slots=[],effects=[],notices=[],requests=[];let cursor=0,tree,fail=false;
  const proxy={mode:'custom',protocol:'http',host:'127.0.0.1',port:7890,username:'user',passwordConfigured:true,bypass:['existing.example:443']};
  const view={ai:proxy,ssh:{...proxy,mode:'direct'},systemProxy:'HTTP · 127.0.0.1:7890'};
  const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useEffect(effect){const i=cursor++;if(!slots[i]){slots[i]=true;effects.push(effect);}}};
  const context=vm.createContext({exports:{},require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime'){const jsx=(type,props)=>({type,props});return {jsx,jsxs:jsx};}
    if(name==='../api/network')return {networkApi:{read:async()=>view,save:async value=>{requests.push(value);if(fail)throw Error('代理配置无效');return view;}}};
    if(name==='../state/notifications')return {notify:(...args)=>notices.push(args)};
    if(name==='./Select')return {Select:'select'};if(name==='./Ui')return {Icon:'icon'};throw Error(name);
  }});
  vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/components/NetworkSettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,context);
  function expand(node){if(Array.isArray(node))return node.map(expand);if(!node?.props)return node;if(typeof node.type==='function')return expand(node.type(node.props));return {...node,props:{...node.props,children:expand(node.props.children)}};}
  function render(){cursor=0;tree=expand(context.exports.NetworkSettings());while(effects.length)effects.shift()();}
  function find(predicate,node=tree){if(Array.isArray(node)){for(const child of node){const result=find(predicate,child??null);if(result)return result;}return;}if(!node?.props)return;return predicate(node)?node:find(predicate,node.props.children??null);}
  render();return {render,find,requests,notices,setFail(){fail=true;},async settle(){await new Promise(resolve=>setImmediate(resolve));render();},save(){find(n=>n.type==='form').props.onSubmit({preventDefault(){}});}};
}
test('代理设置独立编辑、显式保存；空密码保留，清除密码明确提交',async()=>{
  const app=ui();await app.settle();assert.equal(app.requests.length,0);
  assert.equal(app.find(n=>n.props['aria-label']==='大模型请求代理密码').props.value,'');
  app.find(n=>n.props.label==='SSH 与文件传输连接方式').props.onChange('system');app.render();
  app.save();await app.settle();assert.equal(app.requests[0].ssh.mode,'system');assert.equal(app.requests[0].ai.clearPassword,false);assert.equal('password' in app.requests[0].ai,false);assert.equal('passwordConfigured' in app.requests[0].ai,false);
  app.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});app.render();app.save();await app.settle();assert.equal(app.requests[1].ai.clearPassword,true);
});
test('代理保存失败保留草稿并显示错误',async()=>{
  const app=ui();await app.settle();app.find(n=>n.props['aria-label']==='大模型请求代理密码').props.onChange({target:{value:'new-secret'}});app.render();app.setFail();app.save();await app.settle();assert.equal(app.requests[0].ai.password,'new-secret');assert.equal(app.find(n=>n.props['aria-label']==='大模型请求代理密码').props.value,'new-secret');assert.equal(app.notices.at(-1)[1],'error');
});
test('保存成功清空密码输入，刷新检测不覆盖正在编辑的字段',async()=>{
  const app=ui();await app.settle();app.find(n=>n.props['aria-label']==='大模型请求代理主机').props.onChange({target:{value:'edited.example'}});app.render();app.find(n=>n.type==='button'&&n.props.children==='刷新本机代理').props.onClick();await app.settle();assert.equal(app.find(n=>n.props['aria-label']==='大模型请求代理主机').props.value,'edited.example');
  app.find(n=>n.props['aria-label']==='大模型请求代理密码').props.onChange({target:{value:'new-secret'}});app.render();app.save();await app.settle();assert.equal(app.requests[0].ai.password,'new-secret');assert.equal(app.find(n=>n.props['aria-label']==='大模型请求代理密码').props.value,'');
});
test('其他设置位于更新前，模型页不再包含补全配置',()=>{
  const context=vm.createContext({exports:{}});vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/config/settingsNavigation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  const nav=Array.from(context.exports.settingsNavigation);assert.equal(nav.at(-2).section,'other');assert.equal(nav.at(-2).label,'其他设置');assert.equal(nav.at(-1).section,'updates');
  const source=readFileSync(new URL('../src/components/RustBackendSettingsDialog.tsx',import.meta.url),'utf8');assert.ok(source.includes("tab==='other'&&<OtherSettings"));assert.equal(source.includes('TerminalCompletionSettings'),false);
});

test('模型和 SSH 白名单独立编辑，保留草稿并以规则列表保存；清空表示删除',async()=>{
 const app=ui();await app.settle();assert.equal(app.find(n=>n.props['aria-label']==='大模型请求直连白名单').props.value,'existing.example:443');
 app.find(n=>n.props['aria-label']==='大模型请求直连白名单').props.onChange({target:{value:' 192.168.1.10\napi.example.com:443, *.example.com；[2001:db8::1]:22\napi.example.com:443'}});app.render();
 app.find(n=>n.props['aria-label']==='SSH 与文件传输直连白名单').props.onChange({target:{value:''}});app.render();
 app.find(n=>n.type==='button'&&n.props.children==='刷新本机代理').props.onClick();await app.settle();assert.match(app.find(n=>n.props['aria-label']==='大模型请求直连白名单').props.value,/192.168.1.10/);
 app.save();await app.settle();assert.deepEqual(Array.from(app.requests[0].ai.bypass),['192.168.1.10','api.example.com:443','*.example.com','[2001:db8::1]:22']);assert.deepEqual(Array.from(app.requests[0].ssh.bypass),[]);assert.equal('bypassText' in app.requests[0].ai,false);
});
