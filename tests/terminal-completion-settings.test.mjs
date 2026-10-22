import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
function ui(){
 const slots=[],effects=[],notices=[];let cursor=0,tree,prefs={enabled:false,aiEnabled:false,sendDirectory:false,modelId:'',delayMs:500},fail=false,loads=0;
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];},
 useEffect(effect){const i=cursor++;if(!slots[i]){slots[i]=true;effects.push(effect);}}};
 const model={agentId:'profile',agentName:'测试渠道',channelId:'channel',modelName:'deepseek-flash',agentDesc:''};let models=[model];
 const context=vm.createContext({exports:{},require(name){
  if(name==='react')return hooks;if(name==='react/jsx-runtime'){const jsx=(type,props)=>({type,props});return {jsx,jsxs:jsx};}
  if(name==='../api/agent')return {agentApi:{list:async()=>{loads++;return models;}}};
  if(name==='../state/terminalCompletionPreferences')return {readCompletionPreferences:()=>prefs,saveCompletionPreferences:value=>{if(fail)throw new Error('storage');prefs=value;}};
  if(name==='../state/notifications')return {notify:(...args)=>notices.push(args)};
  if(name==='./Select')return {Select:'select'};if(name==='./ModelPicker')return {ModelPicker:'model-picker'};if(name==='./Ui')return {Toggle:'toggle',Icon:'icon'};if(name.endsWith('.css'))return {};throw new Error(name);
 }});
 vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/components/TerminalCompletionSettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,context);
 function render(){cursor=0;tree=context.exports.TerminalCompletionSettings();while(effects.length)effects.shift()();}
 function find(predicate,node=tree){if(Array.isArray(node)){for(const n of node){const result=find(predicate,n);if(result)return result;}return;}if(!node?.props)return;return predicate(node)?node:find(predicate,node.props.children??null);}
 render();return {render,find,notices,setModels:value=>{models=value;},setFail:()=>{fail=true;},get prefs(){return prefs;},get loads(){return loads;},async settle(){await new Promise(resolve=>setImmediate(resolve));render();}};
}
test('补全设置只列可用模型，独立保存模型和触发延迟；刷新读取新配置',async()=>{
 const view=ui();await view.settle();const select=view.find(node=>node.props.label==='补全模型');assert.equal(select.type,'model-picker');assert.deepEqual(Array.from(select.props.models,model=>[model.agentId,model.channelId]),[['profile','channel']]);
 view.find(node=>node.props.label==='启用终端智能补全').props.onChange(true);view.render();
 view.find(node=>node.props.label==='AI 续写').props.onChange(true);view.render();
 view.find(node=>node.props.label==='补全模型').props.onChange('profile');view.render();view.find(node=>node.props.label==='补全触发延迟').props.onChange(800);view.render();
 assert.deepEqual({...view.prefs},{enabled:true,aiEnabled:true,sendDirectory:false,modelId:'profile',delayMs:800});
 view.find(node=>node.type==='button'&&node.props.children==='刷新模型').props.onClick();await view.settle();assert.equal(view.loads,2);
});

test('补全复用对话的渠道模型 ID，刷新后保留原选择；模型失效时提示重新选择',async()=>{
 const view=ui();await view.settle();view.find(n=>n.props.label==='补全模型').props.onChange('profile');view.render();
 view.setModels([{agentId:'second',agentName:'同名渠道',channelId:'other-channel',modelName:'deepseek-flash',agentDesc:''}]);view.find(n=>n.type==='button'&&n.props.children==='刷新模型').props.onClick();await view.settle();
 const picker=view.find(n=>n.props.label==='补全模型');assert.equal(view.prefs.modelId,'profile');assert.equal(picker.props.value,'profile');assert.match(picker.props.placeholder,/原补全模型暂不可用/);assert.equal(picker.props.models[0].channelId,'other-channel');
 picker.props.onChange('second');view.render();assert.equal(view.prefs.modelId,'second');
});
test('本机偏好保存失败时显示 Toast 并保留原设置',async()=>{
 const view=ui();await view.settle();view.setFail();view.find(node=>node.type==='toggle').props.onChange(true);view.render();assert.equal(view.prefs.enabled,false);assert.match(view.notices[0][0],/保存失败/);
});

test('AI 与目录开关独立，默认本地模式不发送目录',async()=>{
 const view=ui();await view.settle();
 assert.equal(view.find(n=>n.props.label==='AI 续写').props.disabled,true);
 assert.equal(view.find(n=>n.props.label==='向 AI 提供当前目录').props.disabled,true);
 view.find(n=>n.props.label==='启用终端智能补全').props.onChange(true);view.render();
 view.find(n=>n.props.label==='AI 续写').props.onChange(true);view.render();
 assert.equal(view.prefs.aiEnabled,true);assert.equal(view.prefs.sendDirectory,false);
 view.find(n=>n.props.label==='向 AI 提供当前目录').props.onChange(true);view.render();assert.equal(view.prefs.sendDirectory,true);
});

test('总开关关闭时明确提示且禁用子设置，重新开启保留之前的选择',async()=>{
 const view=ui();await view.settle();
 assert.match(view.find(n=>n.props.role==='status').props.children,/总开关已关闭/);
 assert.ok(view.find(n=>n.type==='strong'&&n.props.children==='AI 续写'));
 assert.ok(view.find(n=>n.type==='strong'&&n.props.children==='向 AI 提供当前目录'));
 view.find(n=>n.props.label==='启用终端智能补全').props.onChange(true);view.render();
 view.find(n=>n.props.label==='AI 续写').props.onChange(true);view.render();
 assert.match(view.find(n=>n.props.role==='status').props.children,/选择一个可用模型/);
 view.find(n=>n.props.label==='补全模型').props.onChange('profile');view.render();
 assert.match(view.find(n=>n.props.role==='status').props.children,/已开启路径、历史和 AI/);
 view.find(n=>n.props.label==='启用终端智能补全').props.onChange(false);view.render();
 for(const label of ['AI 续写','向 AI 提供当前目录','补全模型','补全触发延迟'])assert.equal(view.find(n=>n.props.label===label).props.disabled,true);
 assert.equal(view.prefs.aiEnabled,true);assert.equal(view.prefs.modelId,'profile');
 assert.match(view.find(n=>n.props.role==='status').props.children,/总开关已关闭/);
 view.find(n=>n.props.label==='启用终端智能补全').props.onChange(true);view.render();
 assert.equal(view.find(n=>n.props.label==='补全模型').props.disabled,false);
});
