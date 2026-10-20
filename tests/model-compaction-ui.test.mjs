import { loadToastErrorHooks } from './helpers/toast-errors.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as protocolUi from '../src/api/modelProtocols.ts';
import * as channelUi from '../src/state/modelChannels.ts';
import * as pinUi from '../src/state/modelPins.ts';
import {newModelConfig} from '../src/api/models.ts';
import {chatErrorGuidance} from '../src/api/chatErrors.ts';

test('New profiles use the chosen token, timeout and response defaults without sharing mutable state',()=>{
  const config=newModelConfig();
  assert.deepEqual([config.contextWindow,config.outputReserve,config.safetyReserve,config.compactPercent,config.timeoutSeconds,config.maxResponseBytes,config.temperature],
    [256000,2048,8192,75,120,1048576,null]);
  config.safetyReserve=512;config.capabilities.temperature=true;
  assert.equal(newModelConfig().safetyReserve,8192);assert.equal(newModelConfig().capabilities.temperature,false);
});

function settings(legacyVision, options={}) {
  const pinData=new Map();
  const pinStorage=options.pinStorage??{getItem:key=>pinData.get(key)??null,setItem:(key,value)=>pinData.set(key,value)};
  const profile={id:'stable-profile',displayName:'日常模型',revision:7,config:{...newModelConfig(),baseUrl:'https://example.test/v1/',model:'text'},apiKeyConfigured:true,ready:true};
  if(legacyVision!==undefined)profile.config.capabilities.vision=legacyVision;
  const slots=[],effects=[],saved=[],deleted=[],notices=[];let cursor=0,tree,autoOpened=false,changed=0;
  const props={changed(){changed++;},locked:false};
  const hooks={
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
      return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useEffect(effect,deps){const index=cursor++;if(!slots[index]||deps.some((value,i)=>value!==slots[index][i])){slots[index]=deps;effects.push(effect);}},
  };
  const api={list:async()=>options.items??[profile],save:async(...args)=>{saved.push(args);return {...profile,id:args[0],displayName:args[4],config:args[2],revision:args[1]+1};},delete:async(...args)=>{deleted.push(args);return true;},...options.api};
  api.channels=(...args)=>api.list(...args);
  api.saveChannel=async(...args)=>({...await api.save(...args),models:args[5].map((model,i)=>({id:i?`member-${i}`:args[0],model}))});
  api.deleteChannel=(...args)=>api.delete(...args);
  const source=readFileSync(new URL('../src/components/ModelSettings.tsx',import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const leaf=()=>null;
  const context=vm.createContext({exports:{},crypto,Error,document:{body:{}},require(name){
    if(name==='../state/useToastError')return loadToastErrorHooks(hooks,(...args)=>notices.push(args));if(name==='react')return hooks;
    if(name==='react-dom')return {createPortal:node=>node};
    if(name==='../state/notifications')return {notify(...args){notices.push(args);}};
    if(name==='react/jsx-runtime'){const jsx=(type,props)=>type==='endpoint-input-stub'?{type:'input',props:{...props,onChange:event=>props.onChange(event.target.value)}}:type==='catalog-input-stub'?{type:'textarea',props:{...props,id:'model-id',onChange:event=>props.onChange(event.target.value)}}:{type,props};return {jsx,jsxs:jsx};}
    if(name==='../api/modelProtocols')return protocolUi;
    if(name==='../state/modelChannels')return channelUi;
    if(name==='../state/modelPins')return {...pinUi,loadModelPins:user=>pinUi.loadModelPins(user,pinStorage),saveModelPins:(user,pins)=>pinUi.saveModelPins(user,pins,pinStorage)};
    if(name==='../api/ssh')return {sshUserId:'test-user'};
    if(name==='../api/models')return {modelApi:api,newModelConfig};
    if(name==='./Ui')return {AccentIcon:leaf,Badge:leaf,Icon:leaf,Toggle:leaf,Modal:leaf};
    if(name==='./Select')return {Select:leaf};
    if(name==='./ModelSupplierIcon')return {ModelSupplierIcon:leaf};
    if(name==='./ModelNumberInput')return {ModelNumberInput:leaf};
    if(name==='./ModelEndpointInput')return {ModelEndpointInput:'endpoint-input-stub'};
    if(name==='./ModelCatalogInput')return {ModelCatalogInput:'catalog-input-stub'};
    if(name.endsWith('.css'))return {};
    throw new Error(name);
  }});
  vm.runInContext(output,context);
  function render(){cursor=0;tree=context.exports.ModelSettings(props);while(effects.length)effects.shift()();}
  function find(predicate,node){
    if(arguments.length===1)node=tree;
    if(Array.isArray(node)){for(const child of node){const result=find(predicate,child);if(result)return result;}return;}
    if(!node?.props)return;
    if(predicate(node))return node;
    return find(predicate,node.props.children);
  }
  function openEdit(){find(node=>node.props.className?.split(' ').includes('model-edit')).props.onClick();render();}
  function text(node){if(arguments.length===0)node=tree;if(Array.isArray(node))return node.map(text).join(' ');if(typeof node==='string'||typeof node==='number')return String(node);return node?.props?text(node.props.children):'';}
  return {props,api,saved,deleted,notices,render,find,text,openEdit,get changed(){return changed;},async settle(){await new Promise(resolve=>setImmediate(resolve));render();
    if(options.autoOpen!==false&&!autoOpened&&find(node=>node.props.className?.split(' ').includes('model-edit'))){autoOpened=true;openEdit();}
  }};
}

test('直接展示的自动整理比例支持常用档位并保存，保持配置 ID、名称和密钥保留动作',async()=>{
  const ui=settings();ui.render();await ui.settle();
  const field=ui.find(node=>node.props.id==='model-compact'&&node.props.label);
  assert.equal(field.props.label,'自动整理触发比例');assert.equal(field.props.badge,'%');
  assert.match(field.props.hint,/原始历史仍会保留/);
  const input=ui.find(node=>node.props.id==='model-compact'&&node.props.kind==='compact');
  assert.equal(input.props.value,75);assert.equal(input.props.kind,'compact');
  input.props.onChange(60);ui.render();
  assert.equal(ui.find(node=>node.props.id==='model-compact'&&node.props.kind==='compact').props.value,60);
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  await ui.settle();
  assert.equal(ui.saved.length,1);
  assert.equal(ui.saved[0][0],'stable-profile');assert.equal(ui.saved[0][1],7);
  assert.equal(ui.saved[0][2].compactPercent,60);
  assert.equal(ui.saved[0][3].action,'keep');assert.equal(ui.saved[0][4],'日常模型');
  assert.equal(ui.saved[0][2].baseUrl,'https://example.test/v1/');
});
test('配置卡片保留后端创建顺序，编辑不移动，新建追加到末尾',async()=>{
  const make=(id,displayName)=>({id,displayName,revision:1,config:{...newModelConfig(),baseUrl:'https://example.test/v1/',model:'one'},apiKeyConfigured:false,ready:true});
  const ui=settings(undefined,{items:[make('z-first','Z first'),make('a-second','A second')],autoOpen:false});
  ui.render();await ui.settle();
  const names=()=>Array.from(ui.find(node=>node.props.className==='model-profile-grid').props.children,card=>card.props['aria-label']);
  assert.deepEqual(names(),['Z first','A second']);
  ui.openEdit();ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.onChange({target:{value:'ZZ renamed'}});ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.deepEqual(names(),['ZZ renamed','A second']);
  ui.find(node=>node.props.className==='model-create primary-button').props.onClick();ui.render();
  for(const [id,value] of [['model-name','0 new'],['model-url','https://example.test/v1/'],['model-id','new-model']]){
    ui.find(node=>node.props.id===id&&['input','textarea'].includes(node.type)).props.onChange({target:{value}});ui.render();
  }
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.deepEqual(names(),['ZZ renamed','A second','0 new']);
});

test('供应商与渠道名称按并且筛选，兼容协议归组且保留创建顺序',async()=>{
  const make=(id,displayName,provider)=>({id,displayName,revision:1,config:{...newModelConfig(),baseUrl:'https://example.test/v1/',model:'only-model-id',provider},apiKeyConfigured:false,ready:true});
  const items=[make('z-first','Work Chat','openAiCompatible'),make('a-second','Work Claude','anthropicMessages'),make('m-third','Work Responses','openAiResponses')];
  let reads=0;
  const ui=settings(undefined,{autoOpen:false,api:{list:async()=>{reads++;return items;}}});ui.render();await ui.settle();
  const names=()=>Array.from(ui.find(node=>node.props.className==='model-profile-grid')?.props.children??[],card=>card.props['aria-label']);
  const supplier=value=>{ui.find(node=>node.props.id==='model-catalog-supplier').props.onChange(value);ui.render();};
  const search=value=>{ui.find(node=>node.props['aria-label']==='搜索供应商 / 渠道名称').props.onChange({target:{value}});ui.render();};
  supplier('openai');search('  WORK  ');assert.deepEqual(names(),['Work Chat','Work Responses']);
  search('Claude');assert.deepEqual(names(),[]);assert.match(ui.text(),/没有匹配的模型配置/);assert.doesNotMatch(ui.text(),/还没有模型配置/);
  supplier('anthropic');assert.deepEqual(names(),['Work Claude']);
  ui.find(node=>node.props['aria-label']==='清空名称搜索').props.onClick();ui.render();assert.deepEqual(names(),['Work Claude']);
  search('only-model-id');assert.deepEqual(names(),[],'search only matches the channel name, not the model ID');
  ui.find(node=>node.props.className==='model-clear-filters').props.onClick();ui.render();
  assert.deepEqual(names(),['Work Chat','Work Claude','Work Responses']);assert.equal(reads,1,'filtering does not refetch or change configuration');
  supplier('openai');search('Responses');ui.find(node=>node.props['aria-label']==='刷新模型配置').props.onClick();await ui.settle();
  assert.deepEqual(names(),['Work Responses']);assert.equal(reads,2);
});

test('最近置顶优先，取消恢复创建顺序，刷新和重新打开保留且筛选仍按并且匹配',async()=>{
  const make=(id,provider='openAiCompatible')=>({id,displayName:id,revision:1,config:{...newModelConfig(),baseUrl:'https://example.test/v1/',model:'one',provider},apiKeyConfigured:false,ready:true});
  const pinData=new Map(),pinStorage={getItem:key=>pinData.get(key)??null,setItem:(key,value)=>pinData.set(key,value)};
  const options={items:[make('first'),make('second'),make('third','anthropicMessages')],pinStorage,autoOpen:false};
  const ui=settings(undefined,options);ui.render();await ui.settle();
  const names=view=>Array.from(view.find(node=>node.props.className==='model-profile-grid')?.props.children??[],card=>card.props['aria-label']);
  const toggle=label=>{ui.find(node=>node.props['aria-label']===label).props.onClick();ui.render();};
  toggle('置顶 second');toggle('置顶 third');assert.deepEqual(names(ui),['third','second','first']);
  assert.equal(ui.find(node=>node.props['aria-label']==='取消置顶 third').props['aria-pressed'],true);
  ui.find(node=>node.props['aria-label']==='刷新模型配置').props.onClick();await ui.settle();assert.deepEqual(names(ui),['third','second','first']);
  const reopened=settings(undefined,options);reopened.render();await reopened.settle();assert.deepEqual(names(reopened),['third','second','first']);
  ui.find(node=>node.props.id==='model-catalog-supplier').props.onChange('openai');ui.render();
  assert.deepEqual(names(ui),['second','first'],'hidden supplier pins do not bypass the active filter');
  ui.find(node=>node.props['aria-label']==='搜索供应商 / 渠道名称').props.onChange({target:{value:'first'}});ui.render();assert.deepEqual(names(ui),['first']);
  ui.find(node=>node.props.className==='model-clear-filters').props.onClick();ui.render();
  toggle('取消置顶 second');assert.deepEqual(names(ui),['third','first','second']);
  toggle('取消置顶 third');assert.deepEqual(names(ui),['first','second','third']);
  assert.equal(ui.saved.length,0);assert.equal(ui.changed,0,'pinning is a local display preference, not a model configuration edit');
});

test('置顶偏好写入失败保留原排序并提示错误，不误报保存成功',async()=>{
  const pinStorage={getItem:()=>null,setItem(){throw new Error('storage full');}};
  const ui=settings(undefined,{autoOpen:false,pinStorage});ui.render();await ui.settle();
  ui.find(node=>node.props['aria-label']==='置顶 日常模型').props.onClick();ui.render();
  assert.equal(ui.find(node=>node.props['aria-label']==='置顶 日常模型').props['aria-pressed'],false);
  assert.ok(ui.notices.some(([message])=>message.includes('置顶状态保存失败')));
});

test('模型设置锁定时整理参数沿用原表单禁用状态',async()=>{
  const ui=settings();ui.render();await ui.settle();ui.props.locked=true;ui.render();
  assert.equal(ui.find(node=>node.type==='fieldset').props.disabled,true);
  assert.equal(ui.find(node=>node.type==='button'&&node.props.className?.split(' ').includes('model-save-button')).props.disabled,true);
});
test('整理失败与容量错误提示保留原历史并要求明确重试，不显示已成功压缩',()=>{
  for(const code of ['AGENT_COMPACTION_FAILED','AGENT_COMPACTION_LIMIT','MODEL_CONTEXT_LIMIT']) {
    const message=chatErrorGuidance(code);
    assert.ok(message.length);assert.doesNotMatch(message,/已成功|已压缩|尚未接入/);
  }
  assert.match(chatErrorGuidance('AGENT_COMPACTION_FAILED'),/原始历史仍保留/);
  assert.match(chatErrorGuidance('AGENT_COMPACTION_LIMIT'),/缩短输入|新建会话/);
});

test('Responses 协议与远端整理开关可保存，复用稳定配置和原密钥',async()=>{
  const ui=settings();ui.render();await ui.settle();
  ui.find(node=>node.props.id==='model-protocol'&&node.props.options).props.onChange('openAiResponses');ui.render();
  assert.equal(ui.find(node=>node.type==='input'&&node.props.id==='model-path').props.value,'responses');
  const output=ui.find(node=>node.type==='input'&&node.props.id==='model-token-param');
  assert.equal(output.props.value,'max_output_tokens');assert.equal(output.props.readOnly,true);
  const toggle=ui.find(node=>node.props.label==='启用 Responses 远端整理');
  assert.equal(toggle.props.value,false);
  assert.match(ui.find(node=>node.props.id==='model-compact'&&node.props.hint).props.hint,/启用供应商远端整理/);
  toggle.props.onChange(true);ui.render();
  assert.match(ui.find(node=>node.props.id==='model-compact'&&node.props.hint).props.hint,/原始历史/);
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved[0][0],'stable-profile');
  assert.equal(ui.saved[0][2].provider,'openAiResponses');
  assert.equal(ui.saved[0][2].remoteCompaction,true);
  assert.equal(ui.saved[0][2].completionsPath,'responses');
  assert.equal(ui.saved[0][3].action,'keep');
  assert.equal(ui.saved[0][4],'日常模型');
});

test('切回 Chat Completions 清除远端能力，锁定时协议和能力不可操作',async()=>{
  const ui=settings();ui.render();await ui.settle();
  ui.find(node=>node.props.id==='model-protocol'&&node.props.options).props.onChange('openAiResponses');ui.render();
  ui.find(node=>node.props.label==='启用 Responses 远端整理').props.onChange(true);ui.render();
  ui.props.locked=true;ui.render();
  assert.equal(ui.find(node=>node.props.id==='model-protocol'&&node.props.options).props.disabled,true);
  assert.equal(ui.find(node=>node.props.label==='启用 Responses 远端整理').props.disabled,true);
  ui.props.locked=false;ui.render();
  ui.find(node=>node.props.id==='model-protocol'&&node.props.options).props.onChange('openAiCompatible');ui.render();
  assert.equal(ui.find(node=>node.props.label==='启用 Responses 远端整理'),undefined);
  assert.equal(ui.find(node=>node.type==='input'&&node.props.id==='model-path').props.value,'chat/completions');
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved[0][2].remoteCompaction,false);
  assert.match(chatErrorGuidance('MODEL_CONTEXT_BINDING_CHANGED'),/当前对话中切换模型/);
  assert.match(chatErrorGuidance('MODEL_RESPONSES_UNSUPPORTED'),/供应商/);
});

test('函数工具默认启用，设置中不再提供单独开关',async()=>{
  const ui=settings();ui.render();await ui.settle();
  assert.equal(ui.find(node=>node.props.label==='启用模型函数工具能力'),undefined);
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();assert.equal(ui.saved[0][2].capabilities.toolCalls,true);
  ui.openEdit();ui.find(node=>node.props.id==='model-protocol'&&node.props.options).props.onChange('openAiResponses');ui.render();assert.equal(ui.find(node=>node.props.label==='启用模型函数工具能力'),undefined);
});

test('密钥不回显，留空保存保留密钥，输入新值则替换并清空输入框',async()=>{
  const ui=settings();ui.render();await ui.settle();
  const keyInput=()=>ui.find(node=>node.type==='input'&&node.props.id==='model-api-key');
  assert.equal(keyInput().props.type,'password');
  assert.equal(keyInput().props.value,'');
  assert.equal(keyInput().props.placeholder,'已配置，留空表示不修改');
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved[0][3].action,'keep');
  assert.equal(ui.saved[0][3].value,undefined);
  ui.openEdit();keyInput().props.onChange({target:{value:'  fake-replacement-key  '}});ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved[1][3].action,'set');
  assert.equal(ui.saved[1][3].value,'fake-replacement-key');
  assert.equal(keyInput(),undefined);
});

test('关闭和重新开启使用密钥只保存开关，不删除或回传现有密钥',async()=>{
  const ui=settings();ui.render();await ui.settle();
  for(const enabled of [false,true]){
    if(!ui.find(node=>node.type==='form'))ui.openEdit();
    ui.find(node=>node.props.label==='此服务需要 API Key').props.onChange(enabled);ui.render();
    ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
    const args=ui.saved.at(-1);
    assert.equal(args[2].requireApiKey,enabled);
    assert.equal(args[3].action,'keep');
    assert.equal(args[3].value,undefined);
    assert.equal(ui.find(node=>node.props.id==='model-api-key'&&node.type==='input'),undefined);
  }
});

test('更换 API 地址可保留已存密钥，无需重新输入',async()=>{
  const ui=settings();ui.render();await ui.settle();
  ui.find(node=>node.type==='input'&&node.props.id==='model-url').props.onChange({target:{value:'https://other.example/v1/'}});ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved.length,1);
  assert.equal(ui.saved[0][2].baseUrl,'https://other.example/v1/');
  assert.equal(ui.saved[0][3].action,'keep');
  assert.equal(ui.saved[0][3].value,undefined);
});

test('Image input defaults on without a switch and legacy opt-out saves enabled',async()=>{
 assert.equal(newModelConfig().capabilities.vision,true);
 const h=settings(false);h.render();await h.settle();
 assert.equal(h.find(n=>n.props.label==='模型支持图片理解'),undefined);
 h.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await h.settle();
 assert.equal(h.saved[0][2].capabilities.vision,true);
 assert.equal(h.saved[0][2].capabilities.toolCalls,true);
});


test('Claude 原生协议在模型设置可选并保存 messages / max_tokens，默认不发送强度及远端整理',async()=>{
  const ui=settings();ui.render();await ui.settle();
  const select=ui.find(node=>node.props.id==='model-supplier'&&node.props.options);
  assert.ok(select.props.options.some(option=>option.value==='anthropic'));
  select.props.onChange('anthropic');ui.render();
  assert.equal(ui.find(node=>node.props.id==='model-protocol'&&node.props.options),undefined);
  assert.equal(ui.find(node=>node.props.id==='model-path'&&node.type==='input').props.value,'messages');
  assert.equal(ui.find(node=>node.props.id==='model-token-param'&&node.type==='input').props.value,'max_tokens');
  assert.equal(ui.find(node=>node.props.id==='model-temperature'&&node.props.kind==='temperature').props.maximum,1);
  assert.equal(ui.find(node=>node.props.label==='启用 Responses 远端整理'),undefined);
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved.length,1);const config=ui.saved[0][2];
  assert.equal(config.provider,'anthropicMessages');assert.equal(config.outputTokenParameter,'maxTokens');
  assert.equal(config.reasoningEffort,null);assert.equal(config.remoteCompaction,false);
  assert.equal(config.baseUrl,'https://example.test/v1/');assert.equal(ui.saved[0][3].action,'keep');
});

test('模型设置保存 Claude 原生强度，默认选项关闭参数发送',async()=>{
  const ui=settings();ui.render();await ui.settle();
  ui.find(node=>node.props.id==='model-supplier'&&node.props.options).props.onChange('anthropic');ui.render();
  let control=ui.find(node=>node.props.id==='model-effort'&&node.props.options);
  assert.deepEqual(Array.from(control.props.options,option=>option.value),['','low','medium','high','xhigh','max']);
  control.props.onChange('max');ui.render();
  assert.equal(ui.find(node=>node.props.id==='model-effort'&&node.props.options).props.value,'max');
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved[0][2].reasoningEffort,'max');assert.equal(ui.saved[0][2].capabilities.reasoningEffort,true);
  ui.openEdit();
  control=ui.find(node=>node.props.id==='model-effort'&&node.props.options);
  control.props.onChange('');ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved[1][2].reasoningEffort,null);assert.equal(ui.saved[1][2].capabilities.reasoningEffort,false);
});


test('模型页只展示已有卡片，不自动打开编辑器；空配置展示空状态',async()=>{
  const ui=settings(undefined,{autoOpen:false});ui.render();await ui.settle();
  assert.equal(ui.find(node=>node.type==='form'),undefined);
  assert.ok(ui.find(node=>node.type==='article'&&node.props['aria-label']==='日常模型'));
  assert.match(ui.text(),/Chat Completions/);
  assert.equal(ui.saved.length,0);
  const empty=settings(undefined,{autoOpen:false,items:[]});empty.render();await empty.settle();
  assert.match(empty.text(),/还没有模型配置/);assert.equal(empty.find(node=>node.type==='input'),undefined);
});

test('新建弹窗显示供应商地址提示，填写真实地址后保存并更新卡片',async()=>{
  const ui=settings(undefined,{autoOpen:false,items:[]});ui.render();await ui.settle();
  ui.find(node=>node.props.className?.split(' ').includes('model-create')).props.onClick();ui.render();
  assert.ok(ui.find(node=>node.props.title==='新建模型配置'));
  assert.equal(ui.find(node=>node.props.id==='model-protocol'&&node.props.options).props.options.length,2);
  assert.equal(ui.find(node=>node.props.id==='model-url'&&node.type==='input').props.value,'');
  assert.equal(ui.find(node=>node.props.id==='model-url'&&node.type==='input').props.placeholder,'https://api.openai.com/v1');
  ui.find(node=>node.props.id==='model-supplier'&&node.props.options).props.onChange('anthropic');ui.render();
  assert.equal(ui.find(node=>node.props.id==='model-protocol'&&node.props.options),undefined);
  assert.equal(ui.find(node=>node.props.id==='model-url'&&node.type==='input').props.value,'');
  assert.equal(ui.find(node=>node.props.id==='model-url'&&node.type==='input').props.placeholder,'https://api.anthropic.com/v1');
  ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.onChange({target:{value:'Claude 测试'}});
  ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.onChange({target:{value:'claude-test'}});
  ui.find(node=>node.props.id==='model-api-key'&&node.type==='input').props.onChange({target:{value:'fake-key'}});ui.render();
  ui.find(node=>node.props.id==='model-url'&&node.type==='input').props.onChange({target:{value:'https://custom.proxy/v1/'}});ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved.length,1);assert.equal(ui.saved[0][1],0);assert.equal(ui.saved[0][2].provider,'anthropicMessages');
  assert.equal(ui.saved[0][2].baseUrl,'https://custom.proxy/v1/');
  assert.equal(ui.saved[0][3].action,'set');assert.equal(ui.changed,1);
  assert.equal(ui.find(node=>node.type==='form'),undefined);
  assert.ok(ui.find(node=>node.type==='article'&&node.props['aria-label']==='Claude 测试'));
});

test('取消编辑不保存，重新打开丢弃草稿和输入的密钥',async()=>{
  const ui=settings();ui.render();await ui.settle();
  assert.equal(ui.find(node=>node.props.className==='model-catalog').props.inert,true);
  ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.onChange({target:{value:'未保存'}});
  ui.find(node=>node.props.id==='model-api-key'&&node.type==='input').props.onChange({target:{value:'fake-draft'}});ui.render();
  ui.find(node=>node.props.title==='编辑模型配置').props.onClose();ui.render();
  assert.equal(ui.saved.length,0);assert.equal(ui.changed,0);
  assert.equal(ui.find(node=>node.props.className==='model-catalog').props.inert,false);
  ui.openEdit();assert.equal(ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.value,'日常模型');
  assert.equal(ui.find(node=>node.props.id==='model-api-key'&&node.type==='input').props.value,'');
});

test('保存失败保留弹窗和草稿，不显示成功；保存中禁止关闭及重复提交',async()=>{
  let finish;
  const ui=settings();ui.render();await ui.settle();
  ui.api.save=()=>new Promise((resolve,reject)=>{finish={resolve,reject};});
  ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.onChange({target:{value:'保留草稿'}});ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});ui.render();
  assert.equal(ui.find(node=>node.props.title==='编辑模型配置').props.dismissDisabled,true);
  ui.find(node=>node.props.title==='编辑模型配置').props.onClose();ui.render();assert.ok(ui.find(node=>node.type==='form'));
  assert.equal(ui.find(node=>node.type==='fieldset').props.disabled,true);
  finish.reject(new Error('模拟保存失败'));await ui.settle();
  assert.match(ui.notices.at(-1)[0],/模拟保存失败/);assert.equal(ui.notices.at(-1)[1],'error');assert.equal(ui.find(node=>node.props.role==='alert'),undefined);
  assert.equal(ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.value,'保留草稿');
});

test('卡片删除需要确认；失败可重试，成功移除卡片并回到空状态',async()=>{
  const ui=settings(undefined,{autoOpen:false});ui.render();await ui.settle();
  const original=ui.api.delete;ui.api.delete=async()=>{throw new Error('模拟删除失败');};
  ui.find(node=>node.props.className==='model-card-delete').props.onClick();ui.render();
  assert.equal(ui.deleted.length,0);assert.ok(ui.find(node=>node.props.title==='删除渠道配置？'));
  ui.find(node=>node.props.className==='danger-button').props.onClick();await ui.settle();
  assert.match(ui.notices.at(-1)[0],/模拟删除失败/);assert.ok(ui.find(node=>node.type==='article'));
  ui.api.delete=original;ui.find(node=>node.props.className==='danger-button').props.onClick();await ui.settle();
  assert.deepEqual(ui.deleted,[['stable-profile',7]]);assert.equal(ui.changed,1);
  assert.equal(ui.find(node=>node.type==='article'),undefined);assert.match(ui.text(),/还没有模型配置/);
});

test('已有 Claude 配置按供应商恢复，加载失败不显示空配置并可重试',async()=>{
  const profile={id:'claude',revision:2,displayName:'Claude',ready:false,apiKeyConfigured:false,config:{...newModelConfig(),provider:'anthropicMessages',completionsPath:'proxy/messages',baseUrl:'https://proxy.test/v1/'}};
  const ui=settings(undefined,{items:[profile]});ui.render();await ui.settle();
  assert.equal(ui.find(node=>node.props.id==='model-supplier'&&node.props.options).props.value,'anthropic');
  assert.equal(ui.find(node=>node.props.id==='model-protocol'&&node.props.options),undefined);
  assert.equal(ui.find(node=>node.props.id==='model-path'&&node.type==='input').props.value,'proxy/messages');
  const broken=settings(undefined,{autoOpen:false,api:{list:async()=>{throw new Error('模拟加载失败');}}});broken.render();await broken.settle();
  assert.match(broken.notices.at(-1)[0],/模拟加载失败/);assert.doesNotMatch(broken.text(),/还没有模型配置/);
  broken.api.list=async()=>[];broken.find(node=>node.props['aria-label']==='刷新模型配置').props.onClick();await broken.settle();assert.match(broken.text(),/还没有模型配置/);
});


test('供应商菜单保留兼容名称，卡片仅显示品牌图标与协议地址上下文',async()=>{
  const ui=settings(undefined,{autoOpen:false});ui.render();await ui.settle();
  assert.ok(ui.find(node=>node.props.supplier==='openai'&&node.props.size===22));
  assert.doesNotMatch(ui.text(),/OpenAI 兼容|Anthropic 兼容/);
  assert.match(ui.text(),/Chat Completions/);
  assert.match(ui.text(),/https:\/\/example\.test\/v1\//);
  assert.match(ui.text(),/256K tokens/);
  assert.doesNotMatch(ui.text(),/上下文|256,000/);
  assert.equal(ui.find(node=>node.props.className==='model-profile-budget').props.title,'256,000 tokens');
  assert.doesNotMatch(ui.text(),/管理对话使用|配置保存后/);
  ui.openEdit();const supplier=ui.find(node=>node.props.id==='model-supplier'&&node.props.options);
  assert.deepEqual(supplier.props.options.map(item=>item.label),['OpenAI 兼容','Anthropic 兼容','Google 兼容','DeepSeek','GLM / 智谱']);
  assert.ok(supplier.props.options.every(item=>!item.description));
  assert.equal(supplier.props.renderIcon('anthropic').props.supplier,'anthropic');
  assert.equal(ui.find(node=>node.props.className==='model-provider-description'),undefined);
  supplier.props.onChange('anthropic');ui.render();
  assert.equal(ui.find(node=>node.props.id==='model-protocol-info'&&node.type==='input').props.value,'Messages');
});

test('渠道一次保存多个模型 ID，共享接口与密钥设置，卡片展示模型数量',async()=>{
 const ui=settings();ui.render();await ui.settle();
 ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.onChange({target:{value:'model-one\nmodel-two, vendor/model-three'}});ui.render();
 ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
 assert.deepEqual(Array.from(ui.saved[0][5]),['model-one','model-two','vendor/model-three']);
 assert.equal(ui.saved[0][2].model,'model-one');assert.equal(ui.saved[0][3].action,'keep');
 assert.match(ui.text(),/3 个模型/);ui.openEdit();
 assert.equal(ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.value,'model-one\nmodel-two\nvendor/model-three');
});

test('重复模型 ID 保存前报错，保留编辑草稿且不调用原生保存',async()=>{
 const ui=settings();ui.render();await ui.settle();
 ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.onChange({target:{value:'same\nsame'}});ui.render();
 ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
 assert.equal(ui.saved.length,0);assert.match(ui.notices.at(-1)[0],/重复/);
 assert.equal(ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.value,'same\nsame');
});


test('渠道名称与推理强度同排，基础地址、密钥、模型 ID 按顺序独占一行',async()=>{
 const ui=settings();ui.render();await ui.settle();
 const grid=ui.find(node=>node.props.className==='settings-fields-grid'&&Array.isArray(node.props.children)&&node.props.children.some(child=>child?.props?.id==='model-name'));
 const fields=grid.props.children.filter(node=>node?.props?.id);
 assert.deepEqual(Array.from(fields,node=>node.props.id),['model-name','model-effort','model-url','model-api-key','model-id']);
 assert.equal(fields[1].props.hint,undefined);
 for(const field of fields.slice(2))assert.equal(field.props.wide,true);
});


test('Google 渠道从供应商弹窗配置多个模型，保持空地址提示、原生参数并可编辑恢复',async()=>{
  const ui=settings(undefined,{autoOpen:false});ui.render();await ui.settle();ui.find(node=>node.props.className?.split(' ').includes('model-create')).props.onClick();ui.render();
  const supplier=ui.find(node=>node.props.id==='model-supplier'&&node.props.options);
  assert.ok(supplier.props.options.some(option=>option.value==='google'));
  supplier.props.onChange('google');ui.render();
  const url=ui.find(node=>node.props.id==='model-url'&&node.type==='input');
  assert.equal(url.props.value,'');assert.equal(url.props.placeholder,'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(ui.find(node=>node.props.id==='model-path'&&node.type==='input').props.value,'models');
  assert.equal(ui.find(node=>node.props.id==='model-token-param'&&node.type==='input').props.value,'maxOutputTokens');
  url.props.onChange({target:{value:'https://proxy.test/v1beta/'}});
  ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.onChange({target:{value:'Google'}});
  ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.onChange({target:{value:'gemini-test-a\ngemini-test-b'}});
  ui.find(node=>node.props.id==='model-effort'&&node.props.options).props.onChange('high');
  ui.render();ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  const saved=ui.saved[0];assert.ok(saved);assert.equal(saved[2].provider,'googleGemini');
  assert.equal(saved[2].reasoningEffort,'high');assert.equal(saved[2].outputTokenParameter,'maxTokens');
  assert.deepEqual(Array.from(saved[5]),['gemini-test-a','gemini-test-b']);
  const profile={id:saved[0],revision:1,displayName:'Google',ready:true,apiKeyConfigured:true,config:saved[2]};
  const restored=settings(undefined,{items:[profile]});restored.render();await restored.settle();
  assert.equal(restored.find(node=>node.props.id==='model-supplier'&&node.props.options).props.value,'google');
});


test('DeepSeek 双协议渠道保存、编辑恢复及鲸鱼图标沿用现有表单，地址始终仅作提示',async()=>{
 for(const protocol of ['openAiCompatible','anthropicMessages']) {
  const ui=settings(undefined,{autoOpen:false});ui.render();await ui.settle();ui.find(node=>node.props.className?.split(' ').includes('model-create')).props.onClick();ui.render();
  ui.find(node=>node.props.id==='model-supplier'&&node.props.options).props.onChange('deepseek');ui.render();
  const select=ui.find(node=>node.props.id==='model-protocol'&&node.props.options);assert.equal(select.props.options.length,2);select.props.onChange(protocol);ui.render();
  const url=ui.find(node=>node.props.id==='model-url'&&node.type==='input');assert.equal(url.props.value,'');
  assert.equal(url.props.placeholder,protocol==='anthropicMessages'?'https://api.deepseek.com/anthropic/v1':'https://api.deepseek.com/v1');
  assert.equal(ui.find(node=>node.props.id==='model-token-param'&&node.type==='input').props.value,'max_tokens');
  url.props.onChange({target:{value:'https://proxy.test/v1/'}});ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.onChange({target:{value:'DeepSeek'}});
  ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.onChange({target:{value:'model-one\nmodel-two'}});
  ui.find(node=>node.props.id==='model-effort'&&node.props.options).props.onChange('max');ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();const saved=ui.saved[0];assert.ok(saved);
  assert.equal(saved[2].supplier,'deepseek');assert.equal(saved[2].provider,protocol);assert.equal(saved[2].reasoningEffort,'max');assert.equal(saved[3].action,'keep');assert.equal(saved[5].length,2);
  const restored=settings(undefined,{items:[{id:saved[0],revision:1,displayName:'DeepSeek',ready:true,apiKeyConfigured:true,config:saved[2]}]});restored.render();await restored.settle();
  assert.equal(restored.find(node=>node.props.id==='model-supplier'&&node.props.options).props.value,'deepseek');
  assert.equal(restored.find(node=>node.props.id==='model-protocol'&&node.props.options).props.value,protocol);
 }
});

test('供应商筛选按显式 DeepSeek 身份区分同协议渠道，卡片展示鲸鱼图标',async()=>{
 const items=['openai','deepseek'].map((supplier,i)=>({id:supplier,revision:1,displayName:supplier,ready:true,apiKeyConfigured:true,config:{...newModelConfig(),supplier:i?'deepseek':undefined,model:'alias',baseUrl:'https://proxy.test/v1/'}}));
 const ui=settings(undefined,{items,autoOpen:false});ui.render();await ui.settle();
 ui.find(node=>node.props.id==='model-catalog-supplier'&&node.props.options).props.onChange('deepseek');ui.render();
 assert.equal(ui.find(node=>node.type==='article').props['aria-label'],'deepseek');
 assert.ok(ui.find(node=>node.props.supplier==='deepseek'));assert.ok(!ui.find(node=>node.type==='article'&&node.props['aria-label']==='openai'));
});

test('GLM 双协议配置保存及恢复，供应商和名称并且筛选，保留 Key 与代理',async()=>{
 for(const provider of ['openAiCompatible','anthropicMessages']) {
  const config={...protocolUi.applyModelSupplier(newModelConfig(),'glm'),provider,model:'alias',baseUrl:'https://proxy.test/glm/'};
  const items=[{id:'glm',revision:3,displayName:'智谱生产',ready:true,apiKeyConfigured:true,config},
    {id:'openai',revision:1,displayName:'智谱测试',ready:true,apiKeyConfigured:true,config:{...newModelConfig(),model:'alias'}}];
  const ui=settings(undefined,{items,autoOpen:false});ui.render();await ui.settle();
  ui.find(node=>node.props.id==='model-catalog-supplier'&&node.props.options).props.onChange('glm');ui.render();
  assert.equal(ui.find(node=>node.type==='article').props['aria-label'],'智谱生产');assert.ok(ui.find(node=>node.props.supplier==='glm'));
  ui.find(node=>node.props['aria-label']==='搜索供应商 / 渠道名称').props.onChange({target:{value:'测试'}});ui.render();assert.equal(ui.find(node=>node.type==='article'),undefined);
  ui.find(node=>node.props['aria-label']==='搜索供应商 / 渠道名称').props.onChange({target:{value:'生产'}});ui.render();ui.openEdit();
  assert.equal(ui.find(node=>node.props.id==='model-supplier'&&node.props.options).props.value,'glm');
  assert.equal(ui.find(node=>node.props.id==='model-protocol'&&node.props.options).props.value,provider);
  ui.find(node=>node.props.id==='model-effort'&&node.props.options).props.onChange('high');ui.render();
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved[0][0],'glm');assert.equal(ui.saved[0][1],3);assert.equal(ui.saved[0][2].supplier,'glm');
  assert.equal(ui.saved[0][2].provider,provider);assert.equal(ui.saved[0][2].baseUrl,config.baseUrl);assert.equal(ui.saved[0][3].action,'keep');
 }
});


test('各供应商与协议地址留空可保存，保存使用提示默认值且草稿始终不自动回填',async()=>{
 for(const {value:supplier} of protocolUi.modelSupplierOptions) for(const {value:provider} of protocolUi.supplierProtocolOptions(supplier)) {
  const ui=settings(undefined,{autoOpen:false,items:[]});ui.render();await ui.settle();ui.find(node=>node.props.className?.split(' ').includes('model-create')).props.onClick();ui.render();
  ui.find(node=>node.props.id==='model-supplier'&&node.props.options).props.onChange(supplier);ui.render();
  ui.find(node=>node.props.id==='model-protocol'&&node.props.options)?.props.onChange(provider);ui.render();
  const url=ui.find(node=>node.props.id==='model-url'&&node.type==='input');assert.equal(url.props.value,'');assert.equal(url.props.placeholder,protocolUi.modelBasePlaceholder({supplier,provider}));
  ui.find(node=>node.props.id==='model-name'&&node.type==='input').props.onChange({target:{value:'Default endpoint'}});
  ui.find(node=>node.props.id==='model-id'&&node.type==='textarea').props.onChange({target:{value:'example-model'}});
  ui.find(node=>node.props.id==='model-api-key'&&node.type==='input').props.onChange({target:{value:'fixture-key'}});ui.render();
  assert.equal(ui.find(node=>node.props.id==='model-url'&&node.type==='input').props.value,'');
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await ui.settle();
  assert.equal(ui.saved.length,1);assert.equal(ui.saved[0][2].baseUrl,url.props.placeholder);assert.equal(ui.saved[0][2].provider,provider);
 }
});
