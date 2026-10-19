import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelSupplierIcon} from '../src/components/ModelSupplierIcon.tsx';
import {modelSupplierOptions} from '../src/api/modelProtocols.ts';

function selectHarness(renderIcon) {
  const slots=[];let cursor=0,value='openai',tree;
  const hooks={useState(initial){const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},useRef(){return {current:null};},useId(){return 'supplier-test';},useEffect(){},useLayoutEffect(){}};
  const source=readFileSync(new URL('../src/components/Select.tsx',import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({exports:{},document:{body:{}},require(name){
    if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;
    if(name==='react-dom')return {createPortal:node=>node};
    if(name==='./Ui')return {Icon:()=>null};if(name.endsWith('.css'))return {};
    throw new Error(name);
  }});vm.runInContext(output,context);
  function render(){cursor=0;tree=context.exports.Select({label:'供应商',value,options:modelSupplierOptions,renderIcon,onChange:next=>{value=next;}});}
  function find(role,node=tree){if(Array.isArray(node)){for(const item of node){const found=find(role,item);if(found)return found;}return;}if(!node?.props)return;return node.props.role===role?node:find(role,node.props.children??null);}
  render();return {render,find,html:()=>renderToStaticMarkup(tree),get value(){return value;}};
}

test('供应商品牌图标使用本地 SVG，Claude 显示暖橙色放射标志并作为装饰隐藏',()=>{
  const icons=['openai','anthropic'].map(supplier=>renderToStaticMarkup(React.createElement(ModelSupplierIcon,{supplier,size:22})));
  for(const html of icons){assert.match(html,/viewBox="0 0 24 24"/);assert.match(html,/aria-hidden="true"/);assert.match(html,/<path d="M/);assert.doesNotMatch(html,/<image|<script|https?:/);}
  assert.match(icons[0],/fill="currentColor"/);
  assert.match(icons[1],/fill="#D97757"/);assert.match(icons[1],/fill-rule="nonzero"/);
  assert.match(icons[1],/<path d="M4\.709 15\.955/);
  assert.notEqual(icons[0],icons[1]);
});

test('Select 在当前值和菜单选项展示图标，供应商菜单没有说明列',()=>{
  const ui=selectHarness(supplier=>React.createElement(ModelSupplierIcon,{supplier}));
  assert.match(ui.html(),/data-supplier="openai"/);
  ui.find('combobox').props.onClick();ui.render();
  assert.equal((ui.html().match(/class="model-supplier-icon"/g)||[]).length,3);
  assert.match(ui.html(),/Anthropic 兼容/);assert.doesNotMatch(ui.html(),/<small/);
  const option=ui.find('listbox').props.children[1];option.props.onClick();ui.render();
  assert.equal(ui.value,'anthropic');assert.match(ui.html(),/data-supplier="anthropic"/);assert.equal(ui.find('listbox'),undefined);
});

test('未传图标的 Select 保持文字展示、方向键选择和确认行为',()=>{
  const ui=selectHarness();assert.doesNotMatch(ui.html(),/ui-select-label-with-icon/);
  const key=key=>ui.find('combobox').props.onKeyDown({key,preventDefault(){},stopPropagation(){}});
  key('ArrowDown');ui.render();key('ArrowDown');ui.render();key('Enter');ui.render();
  assert.equal(ui.value,'anthropic');assert.equal(ui.find('listbox'),undefined);
  assert.doesNotMatch(ui.html(),/model-supplier-icon/);
});
