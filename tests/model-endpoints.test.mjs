import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {modelEndpointOptions, sameModelEndpoint} from '../src/state/modelEndpoints.ts';

const defaultUrl='https://api.deepseek.com/v1';
const savedUrl='https://proxy.example/v1/';
function harness(initial={}) {
  const slots=[], effects=[], refs=[], listeners=new Map(); let cursor=0, tree, dirty=false;
  const props={id:'endpoint', value:'', placeholder:defaultUrl, savedAddresses:[savedUrl], disabled:false,
    onChange(value){props.value=value;dirty=true;}, ...initial};
  const root={contains:node=>node===root||node===input};
  const input={contains:()=>false, getBoundingClientRect:()=>({left:40,top:450,bottom:486,width:400}),
    focus(){tree.props.children[0].props.onFocus();}};
  const menu={contains:node=>node===menu,scrollTop:0,clientHeight:70,
    querySelector(selector){const index=Number(selector.match(/\d+/)[0]);return {offsetTop:30+index*36,offsetHeight:36};}};
  const window={innerWidth:420,innerHeight:530,
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const document={body:{},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const effect=()=>(callback,deps)=>{const i=cursor++, old=slots[i];
    if(!old||deps.some((value,j)=>!Object.is(value,old.deps[j])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:callback()};});};
  const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;
    return [slots[i],value=>{const next=typeof value==='function'?value(slots[i]):value;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}];},
    useRef(){const i=cursor++;if(!(i in slots)){slots[i]={current:[root,input,menu][refs.length]};refs.push(slots[i]);}return slots[i];},
    useEffect:effect(),useLayoutEffect:effect()};
  const jsx=(type,props)=>({type,props});
  const source=readFileSync(new URL('../src/components/ModelEndpointInput.tsx',import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({exports:{},window,document,require(name){
    if(name==='react')return hooks;if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='react-dom')return {createPortal:node=>node};
    if(name==='../state/modelEndpoints')return {modelEndpointOptions,sameModelEndpoint};
    if(name==='./Ui')return {Icon:'icon'};if(name.endsWith('.css'))return {};throw new Error(name);
  }});vm.runInContext(output,context);
  function render(){let iterations=0;do{dirty=false;cursor=0;tree=context.exports.ModelEndpointInput(props);
    while(effects.length)effects.shift()();assert.ok(++iterations<12,'render settles');}while(dirty);}
  function findAll(role,node=tree){if(Array.isArray(node))return node.flatMap(item=>findAll(role,item));
    if(!node?.props)return [];return [...(node.props.role===role?[node]:[]),...findAll(role,node.props.children??null)];}
  const field=()=>findAll('combobox')[0];
  render();return {props,render,field,findAll,menu,listeners,
    focus(){field().props.onFocus();render();},
    key(key,composing=false){const event={key,nativeEvent:{isComposing:composing},preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};
      field().props.onKeyDown(event);render();return event;},
    click(index){findAll('option')[index].props.onClick();render();}};
}

test('地址建议仅来自默认值和现有配置，去重并跳过无效或含凭据信息的地址',()=>{
  const options=modelEndpointOptions(defaultUrl,[defaultUrl+'/',savedUrl,savedUrl.slice(0,-1),'invalid','file:///tmp/a','https://user:password@proxy.example/v1','https://proxy.example/v1?key=secret','https://proxy.example/v1#key']);
  assert.deepEqual(options.map(x=>x.url),[defaultUrl,savedUrl]);
  assert.deepEqual(options.map(x=>x.source),['default','saved']);
  assert.equal(sameModelEndpoint('https://API.DeepSeek.com/v1/',defaultUrl),true);
  assert.equal(sameModelEndpoint(defaultUrl,defaultUrl.toUpperCase()),false);
  assert.equal(modelEndpointOptions(defaultUrl,Array.from({length:20},(_,i)=>`https://proxy${i}.example/v1`)).length,9);
});

test('搜索保留官方默认，已保存地址大小写不敏感过滤',()=>{
  assert.deepEqual(modelEndpointOptions(defaultUrl,[savedUrl,'https://other.example/v1'],'PROXY').map(x=>x.url),[defaultUrl,savedUrl]);
  assert.deepEqual(modelEndpointOptions(defaultUrl,[savedUrl],'missing').map(x=>x.url),[defaultUrl]);
});

test('自定义建议禁用原生补全，选择保存地址或恢复留空默认值',()=>{
  const ui=harness();assert.equal(ui.field().props.autoComplete,'off');assert.equal(ui.findAll('listbox').length,0);
  ui.focus();assert.equal(ui.findAll('option').length,2);assert.equal(ui.findAll('option')[0].props['aria-selected'],true);
  ui.click(1);assert.equal(ui.props.value,savedUrl);assert.equal(ui.findAll('listbox').length,0);
  ui.focus();assert.equal(ui.findAll('option')[1].props['aria-selected'],true);
  ui.click(0);assert.equal(ui.props.value,'');assert.equal(ui.field().props.placeholder,defaultUrl);assert.equal(ui.findAll('listbox').length,0);
});

test('手动输入保留原文，过滤候选且不自动填入',()=>{
  const ui=harness();ui.focus();ui.field().props.onChange({target:{value:'https://custom.example/v1'}});ui.render();
  assert.equal(ui.props.value,'https://custom.example/v1');assert.equal(ui.findAll('option').length,1);
  ui.key('Enter');assert.equal(ui.props.value,'https://custom.example/v1');assert.equal(ui.findAll('listbox').length,0);
  ui.focus();assert.equal(ui.findAll('option').length,2);
});

test('方向键循环选择，Enter 确认，Esc 不关闭外层弹窗，Tab 和输入法不拦截',()=>{
  const ui=harness();ui.key('ArrowUp');assert.equal(ui.field().props['aria-activedescendant'],'endpoint-suggestions-1');
  assert.ok(ui.menu.scrollTop>0);ui.key('Enter');assert.equal(ui.props.value,savedUrl);
  ui.key('ArrowDown');ui.key('ArrowDown');ui.key('ArrowDown');assert.equal(ui.field().props['aria-activedescendant'],'endpoint-suggestions-0');
  const esc=ui.key('Escape');assert.equal(esc.stopped,true);assert.equal(ui.findAll('listbox').length,0);
  ui.focus();assert.equal(ui.key('Tab').prevented,undefined);assert.equal(ui.findAll('listbox').length,0);
  ui.focus();assert.equal(ui.key('Enter',true).prevented,undefined);assert.equal(ui.findAll('listbox').length,1);
});

test('菜单避让视口，外部点击或滚动关闭，内部滚动不关闭；供应商变化和禁用清理菜单',()=>{
  const ui=harness();ui.focus();const position=ui.findAll('listbox')[0].props.style;
  assert.ok(position.top<450);assert.equal(position.width,400);assert.equal(position.left,12);
  ui.listeners.get('scroll')({target:ui.menu});ui.render();assert.equal(ui.findAll('listbox').length,1);
  ui.listeners.get('pointerdown')({target:{}});ui.render();assert.equal(ui.findAll('listbox').length,0);assert.equal(ui.listeners.size,0);
  ui.focus();ui.listeners.get('scroll')({target:{}});ui.render();assert.equal(ui.findAll('listbox').length,0);
  ui.focus();ui.props.placeholder='https://api.anthropic.com/v1';ui.render();assert.equal(ui.findAll('listbox').length,0);
  ui.focus();ui.props.disabled=true;ui.render();assert.equal(ui.findAll('listbox').length,0);ui.key('ArrowDown');assert.equal(ui.findAll('listbox').length,0);
});
