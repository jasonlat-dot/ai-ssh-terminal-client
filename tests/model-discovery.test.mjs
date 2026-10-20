import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as protocolUi from '../src/api/modelProtocols.ts';
import {addModelIds,selectedModelIds} from '../src/state/modelSelection.ts';

function ui(discover = async()=>[]) {
  const props={value:'manual-model',onChange(value){props.value=value;},disabled:false,query:{provider:'openAiCompatible',baseUrl:'https://example.test/proxy/v1/',requireApiKey:true,apiKey:{action:'set',value:'test-key'},channelId:null,revision:null}};
  const slots=[],effects=[],errors=[],calls=[];let cursor=0,tree;
  const hooks={
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
    useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
    useEffect(effect,deps){const i=cursor++;const prev=slots[i];if(!prev||deps.some((v,j)=>v!==prev.deps[j])){effects.push(()=>{prev?.cleanup?.();const cleanup=effect();slots[i]={deps,cleanup};});}},
  };
  const jsx=(type,props)=>({type,props});
  const source=readFileSync(new URL('../src/components/ModelCatalogInput.tsx',import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({exports:{},Error,AbortController,Set,require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='../api/models')return {modelApi:{discover:async(...args)=>{calls.push(args);return discover(...args);}}};
    if(name==='../api/modelProtocols')return protocolUi;
    if(name==='../state/modelSelection')return {addModelIds,selectedModelIds};
    if(name==='../state/useToastError')return {useToastError:()=>[null,value=>{if(value)errors.push(value);} ]};
    if(name==='./Ui')return {Icon:'icon'};
    if(name.endsWith('.css'))return {};
    throw new Error(name);
  }});vm.runInContext(output,context);
  function render(){cursor=0;tree=context.exports.ModelCatalogInput(props);while(effects.length)effects.shift()();}
  function find(predicate,node){if(arguments.length===1)node=tree;if(Array.isArray(node)){for(const item of node){const found=find(predicate,item);if(found)return found;}}else if(node?.props){if(predicate(node))return node;return find(predicate,node.props.children);}}
  async function settle(){await new Promise(resolve=>setImmediate(resolve));render();}
  function click(label){const node=find(node=>node.type==='button'&&(node.props['aria-label']===label||text(node)===label));assert.ok(node,label);assert.ok(!node.props.disabled,`${label} enabled`);node.props.onClick();render();}
  function text(node){if(Array.isArray(node))return node.map(text).join('');if(typeof node==='string'||typeof node==='number')return String(node);return node?.props?text(node.props.children):'';}
  render();render();
  return {props,calls,errors,render,settle,find,click,text,unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
const entries=[{id:'model-a',displayName:'Alpha'},{id:'model-b'},{id:'manual-model'}];
test('查询只读；点击添加、叉掉、全部添加保留手动模型并去重',async()=>{
  const view=ui(async()=>entries);view.click('查询上游模型');await view.settle();
  assert.equal(view.props.value,'manual-model');assert.equal(view.calls.length,1);assert.equal(view.calls[0][0].baseUrl,'https://example.test/proxy/v1/');
  view.click('添加 model-a');assert.equal(view.props.value,'manual-model\nmodel-a');assert.ok(view.find(n=>n.props['aria-label']==='添加 model-a').props.disabled);
  view.click('移除 model-a');assert.equal(view.props.value,'manual-model');assert.ok(!view.find(n=>n.props['aria-label']==='添加 model-a').props.disabled);
  view.click('全部添加');assert.equal(view.props.value,'manual-model\nmodel-a\nmodel-b');assert.ok(view.find(n=>n.type==='button'&&view.text(n)==='全部添加').props.disabled);
  view.click('移除 manual-model');view.click('移除 model-a');view.click('移除 model-b');assert.equal(view.props.value,'');
});
test('搜索匹配 ID 和展示名，全部添加始终使用完整查询结果',async()=>{
  const view=ui(async()=>entries);view.click('查询上游模型');await view.settle();
  view.find(n=>n.props['aria-label']==='搜索上游模型').props.onChange({target:{value:'alpha'}});view.render();
  assert.ok(view.find(n=>n.props['aria-label']==='添加 model-a'));assert.equal(view.find(n=>n.props['aria-label']==='添加 model-b'),undefined);
  view.click('全部添加');assert.match(view.props.value,/model-b/);
});
test('超出渠道上限整批拒绝，已有选择不丢失；Google 前缀别名不重复',()=>{
  const existing=Array.from({length:63},(_,i)=>`m-${i}`).join('\n');assert.throws(()=>addModelIds(existing,['extra-a','extra-b'],'openAiCompatible'),/64/);
  assert.equal(addModelIds('models/gemini-one',['gemini-one','models/gemini-two'],'googleGemini'),'gemini-one\ngemini-two');
});
test('查询失败用 Toast，保留输入、已有结果和重试入口；空列表有反馈',async()=>{
  let fail=false;const view=ui(async()=>{if(fail)throw new Error('上游未提供模型列表接口（404）');return [];});
  view.click('查询上游模型');await view.settle();assert.match(view.text(view.find(n=>n.props.className==='model-discovery-empty')),/手动填写/);
  fail=true;view.click('重新查询');await view.settle();assert.match(view.errors[0],/404/);assert.equal(view.props.value,'manual-model');assert.ok(view.find(n=>view.text(n)==='重新查询'));
});
test('地址、供应商、密钥和启用状态变化时取消旧查询；迟到结果不能回填',async()=>{
  for(const change of [p=>{p.query={...p.query,supplier:'glm'};},p=>{p.query={...p.query,supplier:'deepseek'};},p=>{p.query={...p.query,baseUrl:'https://other.test/v1/'};},p=>{p.query={...p.query,provider:'googleGemini'};},p=>{p.query={...p.query,apiKey:{action:'set',value:'changed-key'}};},p=>{p.query={...p.query,requireApiKey:false};}]) {
    let resolve;const view=ui(()=>new Promise(done=>{resolve=done;}));view.click('查询上游模型');const signal=view.calls[0][1];
    change(view.props);view.render();view.render();assert.ok(signal.aborted);resolve(entries);await view.settle();assert.equal(view.find(n=>n.props['aria-label']==='添加 model-a'),undefined);assert.equal(view.props.value,'manual-model');
  }
});
test('重复查询被阻止，关闭时中止请求；已存渠道留空密钥使用 keep',async()=>{
  let resolve;const view=ui(()=>new Promise(done=>{resolve=done;}));view.props.query={...view.props.query,apiKey:{action:'keep'},channelId:'saved-channel',revision:8};view.render();view.render();
  view.click('查询上游模型');assert.equal(view.calls[0][0].apiKey.action,'keep');assert.equal(view.calls[0][0].revision,8);
  assert.ok(view.find(n=>view.text(n)==='查询中…').props.disabled);view.unmount();assert.ok(view.calls[0][1].aborted);resolve(entries);await view.settle();assert.equal(view.errors.length,0);
});
test('地址留空时模型查询使用对应协议默认值，保留空草稿；自定义版本和前缀不改写',async()=>{
 for(const {value:supplier} of protocolUi.modelSupplierOptions) for(const {value:provider} of protocolUi.supplierProtocolOptions(supplier)) {
  const view=ui(async()=>entries);view.props.query={...view.props.query,supplier,provider,baseUrl:''};view.render();view.render();
  view.click('查询上游模型');await view.settle();assert.equal(view.calls.length,1);assert.equal(view.calls[0][0].baseUrl,protocolUi.modelBasePlaceholder(view.props.query));assert.equal(view.props.query.baseUrl,'');
 }
});
test('缺少新配置必需密钥时不发请求，关闭鉴权可按默认地址查询',async()=>{
 const view=ui();view.props.query={...view.props.query,baseUrl:'',apiKey:{action:'keep'}};view.render();view.render();view.click('查询上游模型');assert.match(view.errors[0],/API Key/);assert.equal(view.calls.length,0);
 view.props.query={...view.props.query,requireApiKey:false};view.render();view.render();view.click('查询上游模型');await view.settle();assert.equal(view.calls.length,1);assert.equal(view.calls[0][0].baseUrl,'https://api.openai.com/v1');
});
test('全部添加超过 64 个时 Toast 提示且不截断、不覆盖已选模型',async()=>{
  const view=ui(async()=>Array.from({length:65},(_,i)=>({id:`m-${i}`})));view.click('查询上游模型');await view.settle();view.click('全部添加');assert.match(view.errors[0],/64/);assert.equal(view.props.value,'manual-model');
});

test('模型搜索回车仅用于搜索，不触发外层配置保存',async()=>{
  const view=ui(async()=>entries);view.click('查询上游模型');await view.settle();
  let prevented=false;view.find(n=>n.props['aria-label']==='搜索上游模型').props.onKeyDown({key:'Enter',preventDefault(){prevented=true;}});assert.ok(prevented);
});
