import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {modelPickerPosition} from '../src/state/modelPickerPosition.ts';
import {modelProtocols,modelSupplier} from '../src/api/modelProtocols.ts';
import {groupModels} from '../src/state/modelChannels.ts';

function harness(width=1000){
 const slots=[],effects=[],listeners=new Map(),selected=[];let cursor=0,tree;
 const props={models:[{agentId:'a1',agentName:'Alpha',modelName:'first',channelId:'a',agentDesc:''},{agentId:'a2',agentName:'Alpha',modelName:'second',channelId:'a',agentDesc:''},{agentId:'b1',agentName:'Beta',modelName:'third',channelId:'b',agentDesc:''}],value:'a2',disabled:false,onChange:id=>selected.push(id)};
 const hooks={useId:()=> 'picker',useRef:initial=>{const i=cursor++;return slots[i]??(slots[i]={current:initial});},useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
  useEffect(effect,deps){const i=cursor++;const old=slots[i];if(!old||deps.some((value,j)=>value!==old.deps[j])){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});}}};hooks.useLayoutEffect=hooks.useEffect;
 const element={closest:()=>null,focus(){},scrollIntoView(){},contains:node=>node==='inside',getBoundingClientRect:()=>({left:500,right:700,top:600,bottom:630}),querySelector:()=>({focus(){},scrollIntoView(){}})};
 const win={innerWidth:width,innerHeight:800,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const leaf=()=>null;
 const context=vm.createContext({exports:{},Math,window:win,document:{body:{},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},require(name){
  if(name==='react')return hooks;if(name==='react-dom')return{createPortal:node=>node};if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='../state/modelChannels')return{groupModels};if(name==='../state/modelPickerPosition')return{modelPickerPosition};if(name==='../api/modelProtocols')return{modelProtocols,modelSupplier};if(name==='./ModelSupplierIcon')return{ModelSupplierIcon:leaf};if(name==='./Ui')return{Icon:leaf};if(name.endsWith('.css'))return{};throw new Error(name);
 }});
 vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/components/ModelPicker.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 function all(node=tree){if(Array.isArray(node))return node.flatMap(all);return node?.props?[node,...all(node.props.children??[])]:[];}
 function render(){cursor=0;tree=context.exports.ModelPicker(props);for(const node of all())if(node.props.ref)node.props.ref.current=element;while(effects.length)effects.shift()();}
 return {props,selected,listeners,render,find:fn=>all().find(fn),all,get trigger(){return all().find(node=>node.props['aria-label']==='对话模型');},key(key){const event={key,preventDefault(){},stopPropagation(){}};const panel=all().find(node=>node.props.id==='picker');(panel??this.trigger).props.onKeyDown(event);render();render();}};
}
test('两级选择按渠道显示数量并选中准确模型，切换只提交原模型配置 ID',()=>{
 const ui=harness();ui.render();ui.trigger.props.onClick();ui.render();ui.render();
 assert.equal(ui.all().filter(node=>node.props.role==='menuitem').length,2);
 assert.equal(ui.all().filter(node=>node.props.role==='menuitemradio').length,2);
 assert.equal(ui.find(node=>node.props.role==='menuitemradio'&&node.props['aria-checked']).props['data-model-index'],1);
 ui.find(node=>node.props['data-group-index']===1).props.onPointerMove();ui.render();ui.render();
 assert.equal(ui.all().filter(node=>node.props.role==='menuitemradio').length,1);
 ui.find(node=>node.props.role==='menuitemradio').props.onClick();ui.render();
 assert.deepEqual(ui.selected,['b1']);assert.equal(ui.trigger.props['aria-expanded'],false);
});
test('键盘左右进入和返回分组，方向键切换模型，Escape 与外部点击关闭，锁定时不选择',()=>{
 const ui=harness();ui.render();ui.key('ArrowDown');ui.key('ArrowLeft');ui.key('End');ui.key('ArrowRight');ui.key('Enter');assert.deepEqual(ui.selected,['b1']);
 ui.key('ArrowDown');ui.key('Escape');assert.equal(ui.trigger.props['aria-expanded'],false);
 ui.key('ArrowDown');ui.listeners.get('pointerdown')({target:'outside'});ui.render();assert.equal(ui.trigger.props['aria-expanded'],false);
 ui.props.disabled=true;ui.render();ui.key('ArrowDown');assert.equal(ui.trigger.props['aria-expanded'],false);
});
test('窄窗口使用单面板返回导航且菜单不超出窗口',()=>{
 const ui=harness(360);ui.render();ui.trigger.props.onClick();ui.render();ui.render();
 assert.equal(ui.all().filter(node=>node.props.role==='menu').length,1);
 const panel=ui.find(node=>node.props.id==='picker');assert.ok(panel.props.style.left>=8);assert.ok(panel.props.style.left+panel.props.style.width<=352);
 ui.find(node=>node.props['aria-label']==='返回供应商').props.onClick();ui.render();ui.render();assert.equal(ui.all().filter(node=>node.props.role==='menuitem').length,2);
});


test('渠道图标使用兼容协议品牌，不再显示渠道首字母',()=>{
 const ui=harness();ui.props.models=ui.props.models.map(model=>({...model,provider:model.channelId==='a'?'openAiCompatible':'anthropicMessages'}));
 ui.render();ui.trigger.props.onClick();ui.render();ui.render();
 const groups=ui.all().filter(node=>node.props.role==='menuitem');
 assert.deepEqual(groups.map(group=>ui.all(group).find(node=>node.props.supplier).props.supplier),['openai','anthropic']);
 const rows=ui.all().filter(node=>node.props.role==='menuitemradio');
 assert.deepEqual(rows.map(row=>ui.all(row).find(node=>node.props.supplier).props.supplier),['openai','openai']);
 assert.equal(ui.all(ui.trigger).find(node=>node.props.supplier).props.supplier,'openai');
 assert.equal(ui.trigger.props.children[0].props.children[1].props.children,'second');
 ui.find(node=>node.props['data-group-index']===1).props.onPointerMove();ui.render();ui.render();
 assert.equal(ui.all(ui.find(node=>node.props.role==='menuitemradio')).find(node=>node.props.supplier).props.supplier,'anthropic');
 ui.props.value='b1';ui.render();
 assert.equal(ui.all(ui.trigger).find(node=>node.props.supplier).props.supplier,'anthropic');
 assert.equal(ui.trigger.props.children[0].props.children[1].props.children,'third');
});


test('Google 原生渠道在当前值、分组与模型行复用品牌图标，窄窗口仍可选择',()=>{
 const ui=harness(360);ui.props.models=ui.props.models.map(model=>({...model,provider:model.channelId==='b'?'googleGemini':'openAiCompatible'}));ui.props.value='b1';
 ui.render();assert.equal(ui.all(ui.trigger).find(node=>node.props.supplier).props.supplier,'google');assert.equal(ui.all(ui.trigger).find(node=>node.props.supplier).props.variant,undefined);
 ui.trigger.props.onClick();ui.render();ui.render();
 const row=ui.find(node=>node.props.role==='menuitemradio');assert.equal(ui.all(row).find(node=>node.props.supplier).props.supplier,'google');assert.equal(ui.all(row).find(node=>node.props.supplier).props.variant,'model');
 ui.find(node=>node.props['aria-label']==='返回供应商').props.onClick();ui.render();ui.render();
 const group=ui.find(node=>node.props['data-group-index']===1);assert.equal(ui.all(group).find(node=>node.props.supplier).props.variant,undefined);
 group.props.onClick();ui.render();ui.render();ui.find(node=>node.props.role==='menuitemradio').props.onClick();ui.render();assert.deepEqual(ui.selected,['b1']);assert.equal(ui.trigger.props['aria-expanded'],false);
});


test('DeepSeek 身份独立于 OpenAI 协议，在渠道、模型和当前值均使用鲸鱼图标',()=>{
 const ui=harness();ui.props.models=ui.props.models.map(model=>({...model,provider:'openAiCompatible',supplier:model.channelId==='a'?'deepseek':undefined}));
 ui.render();assert.equal(ui.all(ui.trigger).find(node=>node.props.supplier).props.supplier,'deepseek');
 ui.trigger.props.onClick();ui.render();ui.render();
 const groups=ui.all().filter(node=>node.props.role==='menuitem');
 assert.deepEqual(groups.map(group=>ui.all(group).find(node=>node.props.supplier).props.supplier),['deepseek','openai']);
 assert.ok(ui.all().filter(node=>node.props.role==='menuitemradio').every(row=>ui.all(row).find(node=>node.props.supplier).props.supplier==='deepseek'));
});
