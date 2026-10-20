import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {newModelConfig} from '../src/api/models.ts';
import * as protocols from '../src/api/modelProtocols.ts';

function harness(provider='anthropicMessages') {
  let profile={id:'model',revision:3,displayName:'代理模型',config:{...newModelConfig(),provider,model:'custom-alias'}};
  const states=[],effects=[],saved=[],notices=[],busy=[];let cursor=0,tree,fail=false;
  const hooks={
    useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
    useRef(initial){const i=cursor++;return states[i]??(states[i]={current:initial});},
    useEffect(effect,deps){const i=cursor++;if(!states[i]||deps.some((value,j)=>value!==states[i][j])){states[i]=deps;effects.push(effect);}},
  };
  const api={list:async()=>[profile],save:async(...args)=>{
    if(fail)throw new Error('revision conflict');
    saved.push(args);profile={...profile,revision:args[1]+1,config:args[2]};return profile;
  }};
  const leaf=()=>null;
  const code=ts.transpileModule(readFileSync(new URL('../src/components/ComposerReasoningControl.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({exports:{},Error,require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props})};
    if(name==='../api/models')return {modelApi:api};
    if(name==='../api/modelProtocols')return protocols;
    if(name==='../state/notifications')return {notify:(...args)=>notices.push(args)};
    if(name==='./Select')return {Select:leaf};
    if(name==='./Ui')return {Icon:leaf};
    throw new Error(name);
  }});
  vm.runInContext(code,context);
  const props={modelId:'model',revision:0,disabled:false,onSavingChange:value=>busy.push(value)};
  function render(){cursor=0;tree=context.exports.ComposerReasoningControl(props);while(effects.length)effects.shift()();}
  return {props,saved,notices,busy,render,get control(){return tree.props.children;},
    setProfile(next){profile={...profile,...next};},get profile(){return profile;},failSave(){fail=true;},
    async settle(){await new Promise(resolve=>setImmediate(resolve));render();},
  };
}

test('Claude 输入框可保存全部原生强度并恢复默认，合并最新配置且保留密钥',async()=>{
  const ui=harness();ui.render();await ui.settle();
  assert.equal(ui.control.props.disabled,false);
  assert.deepEqual(Array.from(ui.control.props.options,option=>option.value),['','low','medium','high','xhigh','max']);
  ui.setProfile({revision:8,config:{...ui.profile.config,baseUrl:'https://updated.example/v1/'}});
  for(const value of ['low','medium','high','xhigh','max','']){
    ui.control.props.onChange(value);await ui.settle();
    const args=ui.saved.at(-1);
    assert.equal(args[2].reasoningEffort,value||null);
    assert.equal(args[2].capabilities.reasoningEffort,value!=='');
    assert.equal(args[2].baseUrl,'https://updated.example/v1/');
    assert.equal(args[3].action,'keep');assert.equal(args[4],'代理模型');
  }
  assert.equal(ui.saved[0][1],8);
  assert.equal(ui.control.props.displayValue,'推理 · 默认');
  assert.deepEqual(ui.busy,[true,false,true,false,true,false,true,false,true,false,true,false]);
});

test('输入框拒绝不适用档位，保存期间及锁定状态禁止重复操作',async()=>{
  const ui=harness();ui.render();await ui.settle();
  for(const value of ['none','minimal'])ui.control.props.onChange(value);
  await ui.settle();assert.equal(ui.saved.length,0);
  ui.control.props.onChange('high');ui.control.props.onChange('max');await ui.settle();
  assert.equal(ui.saved.length,1);assert.equal(ui.saved[0][2].reasoningEffort,'high');
  ui.props.disabled=true;ui.render();ui.control.props.onChange('max');await ui.settle();assert.equal(ui.saved.length,1);
  const openAi=harness('openAiResponses');openAi.render();await openAi.settle();
  assert.ok(openAi.control.props.options.some(option=>option.value==='none'));
  openAi.control.props.onChange('max');await openAi.settle();assert.equal(openAi.saved.length,0);
});

test('协议并发变更和保存失败保留原设置，不误报成功并释放保存锁',async()=>{
  const ui=harness();ui.render();await ui.settle();
  ui.setProfile({config:{...ui.profile.config,provider:'openAiCompatible'}});
  ui.control.props.onChange('high');await ui.settle();
  assert.equal(ui.saved.length,0);assert.equal(ui.notices.at(-1)[1],'error');
  assert.equal(ui.control.props.displayValue,'推理 · 默认');assert.deepEqual(ui.busy,[true,false]);
  ui.setProfile({config:{...ui.profile.config,provider:'anthropicMessages'}});ui.failSave();
  ui.control.props.onChange('max');await ui.settle();
  assert.equal(ui.saved.length,0);assert.equal(ui.notices.at(-1)[1],'error');
  assert.equal(ui.control.props.displayValue,'推理 · 默认');assert.deepEqual(ui.busy,[true,false,true,false]);
});


test('Google 输入框复用协议目录保存四档 thinkingLevel，不接受 OpenAI 或 Claude 专属档位',async()=>{
  const ui=harness('googleGemini');ui.render();await ui.settle();
  assert.deepEqual(Array.from(ui.control.props.options,option=>option.value),['','minimal','low','medium','high']);
  for(const value of ['none','xhigh','max'])ui.control.props.onChange(value);
  await ui.settle();assert.equal(ui.saved.length,0);
  for(const value of ['minimal','low','medium','high','']){
    ui.control.props.onChange(value);await ui.settle();
    assert.equal(ui.saved.at(-1)[2].provider,'googleGemini');assert.equal(ui.saved.at(-1)[2].reasoningEffort,value||null);
    assert.equal(ui.saved.at(-1)[3].action,'keep');
  }
});


test('DeepSeek 两种协议使用独立思考档位并保留供应商身份，品牌并发变更时拒绝旧设置',async()=>{
 for(const provider of ['openAiCompatible','anthropicMessages']) {
  const ui=harness(provider);ui.setProfile({config:{...ui.profile.config,supplier:'deepseek'}});ui.render();await ui.settle();
  assert.deepEqual(Array.from(ui.control.props.options,option=>option.value),['','none','low','high','max']);
  for(const value of ['none','low','high','max','']) {ui.control.props.onChange(value);await ui.settle();assert.equal(ui.saved.at(-1)[2].supplier,'deepseek');assert.equal(ui.saved.at(-1)[2].reasoningEffort,value||null);}
  ui.setProfile({config:{...ui.profile.config,supplier:undefined}});ui.control.props.onChange('high');await ui.settle();assert.equal(ui.saved.length,5);assert.equal(ui.notices.at(-1)[1],'error');
 }
});

test('GLM 双协议输入框推理保存保留供应商与 Key，拒绝不支持的档位',async()=>{
 for(const provider of ['openAiCompatible','anthropicMessages']) {
  const ui=harness(provider);ui.setProfile({config:{...ui.profile.config,supplier:'glm'}});ui.render();await ui.settle();
  assert.deepEqual(Array.from(ui.control.props.options,option=>option.value),['','none','low','high','max']);
  for(const value of ['minimal','medium','xhigh'])ui.control.props.onChange(value);
  await ui.settle();assert.equal(ui.saved.length,0);
  for(const value of ['none','low','high','max','']) {ui.control.props.onChange(value);await ui.settle();assert.equal(ui.saved.at(-1)[2].supplier,'glm');assert.equal(ui.saved.at(-1)[2].reasoningEffort,value||null);assert.equal(ui.saved.at(-1)[3].action,'keep');}
 }
});

test('Qwen 输入框支持独立开启思考和模型档位，保存保留供应商与已存 Key',async()=>{
 for(const provider of ['openAiCompatible','anthropicMessages']) {
  const ui=harness(provider);ui.setProfile({config:{...ui.profile.config,supplier:'qwen'}});ui.render();await ui.settle();
  assert.deepEqual(Array.from(ui.control.props.options,option=>option.value),['','none','enabled','low','medium','xhigh']);
  for(const value of ['minimal','high','max'])ui.control.props.onChange(value);await ui.settle();assert.equal(ui.saved.length,0);
  for(const value of ['none','enabled','low','medium','xhigh','']) {ui.control.props.onChange(value);await ui.settle();assert.equal(ui.saved.at(-1)[2].supplier,'qwen');assert.equal(ui.saved.at(-1)[2].reasoningEffort,value||null);assert.equal(ui.saved.at(-1)[3].action,'keep');}
 }
});
