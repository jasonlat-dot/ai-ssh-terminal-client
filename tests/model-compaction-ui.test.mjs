import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {newModelConfig} from '../src/api/models.ts';
import {chatErrorGuidance} from '../src/api/chatErrors.ts';

function settings() {
  const profile={id:'stable-profile',displayName:'日常模型',revision:7,config:{...newModelConfig(),baseUrl:'https://example.test/v1/',model:'text'},
    apiKeyConfigured:true,ready:true};
  const slots=[],effects=[],saved=[];let cursor=0,tree;
  const props={changed(){},locked:false};
  const hooks={
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
      return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useEffect(effect,deps){const index=cursor++;if(!slots[index]||deps.some((value,i)=>value!==slots[index][i])){
      slots[index]=deps;effects.push(effect);}},
  };
  const api={list:async()=>[profile],save:async(...args)=>{saved.push(args);return {...profile,config:args[2],revision:8};}};
  const source=readFileSync(new URL('../src/components/ModelSettings.tsx',import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const leaf=()=>null;
  const context=vm.createContext({exports:{},crypto,Error,require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='../api/models')return {modelApi:api,newModelConfig};
    if(name==='./Ui')return {AccentIcon:leaf,Badge:leaf,Icon:leaf,Toggle:leaf};
    if(name==='./Select')return {Select:leaf};
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
  return {props,saved,render,find,async settle(){await new Promise(resolve=>setImmediate(resolve));render();}};
}
test('高级参数的自动整理比例可编辑并保存，保持配置 ID、名称和密钥保留动作',async()=>{
  const ui=settings();ui.render();await ui.settle();
  ui.find(node=>node.props.className==='model-advanced-toggle').props.onClick();ui.render();
  const field=ui.find(node=>node.props.id==='model-compact'&&node.props.label);
  assert.equal(field.props.label,'自动整理触发比例');assert.equal(field.props.badge,'%');
  assert.match(field.props.hint,/原始历史仍会保留/);
  const input=ui.find(node=>node.type==='input'&&node.props.id==='model-compact');
  assert.equal(input.props.value,75);assert.equal(input.props.min,1);assert.equal(input.props.max,99);
  input.props.onChange({target:{value:'60'}});ui.render();
  assert.equal(ui.find(node=>node.type==='input'&&node.props.id==='model-compact').props.value,60);
  ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  await ui.settle();
  assert.equal(ui.saved.length,1);
  assert.equal(ui.saved[0][0],'stable-profile');assert.equal(ui.saved[0][1],7);
  assert.equal(ui.saved[0][2].compactPercent,60);
  assert.equal(ui.saved[0][3].action,'keep');assert.equal(ui.saved[0][4],'日常模型');
  assert.equal(ui.saved[0][2].baseUrl,'https://example.test/v1/');
});
test('模型设置锁定时整理参数沿用原表单禁用状态',async()=>{
  const ui=settings();ui.render();await ui.settle();ui.props.locked=true;ui.render();
  assert.equal(ui.find(node=>node.type==='fieldset').props.disabled,true);
  assert.equal(ui.find(node=>node.type==='button'&&node.props.className==='model-save-button').props.disabled,true);
});
test('整理失败与容量错误提示保留原历史并要求明确重试，不显示已成功压缩',()=>{
  for(const code of ['AGENT_COMPACTION_FAILED','AGENT_COMPACTION_LIMIT','MODEL_CONTEXT_LIMIT']) {
    const message=chatErrorGuidance(code);
    assert.ok(message.length);assert.doesNotMatch(message,/已成功|已压缩|尚未接入/);
  }
  assert.match(chatErrorGuidance('AGENT_COMPACTION_FAILED'),/原始历史仍保留/);
  assert.match(chatErrorGuidance('AGENT_COMPACTION_LIMIT'),/缩短输入|新建会话/);
});
