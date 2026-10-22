import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(new URL(`../src/components/${file}`,import.meta.url),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
function harness() {
  const slots=[],effects=[],listeners=new Map();let cursor=0,closed=0,confirmed=0,tree;
  const document={activeElement:{focus(){}},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const buttons=[0,1].map(()=>({focus(){document.activeElement=this;}}));
  const panel={querySelector:()=>null,querySelectorAll:()=>buttons,focus(){document.activeElement=this;}};
  const hooks={useRef(initial){return slots[cursor++]??={current:initial};},useId:()=> 'dialog-title',
    useEffect(effect,deps){const i=cursor++;if(!slots[i]||deps.some((v,index)=>v!==slots[i][index])){slots[i]=deps;effects.push(effect);}}};
  const jsx=(type,props)=>({type,props});
  const ui=vm.createContext({exports:{},document,require(name){
    if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};throw Error(name);
  }});
  vm.runInContext(compile('Ui.tsx'),ui);
  const upload=vm.createContext({exports:{},require(name){if(name==='./Ui')return ui.exports;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name.endsWith('.css'))return{};throw Error(name);}});
  vm.runInContext(compile('TerminalUploadConfirm.tsx'),upload);
  const close=()=>{closed++;},confirm=()=>{confirmed++;};
  function renderUpload() {
    const element=upload.exports.TerminalUploadConfirm({request:{title:'WSL',paths:['C:\\test.txt'],target:{path:'/root/project'}},onClose:close,onConfirm:confirm});
    return render(element.props);
  }
  function render(props={}) {
    cursor=0;tree=ui.exports.Modal({title:'普通弹窗',onClose:close,...props});
    tree.props.children.props.ref.current=panel;
    while(effects.length)effects.shift()();
    return tree;
  }
  function find(predicate,node=tree) {
    if(Array.isArray(node)){for(const child of node){const result=find(predicate,child);if(result)return result;}return;}
    if(!node?.props)return;if(predicate(node))return node;return find(predicate,node.props.children);
  }
  function backdrop(){const current={};tree.props.onMouseDown({target:current,currentTarget:current});}
  function key(key,shiftKey=false){let prevented=false;listeners.get('keydown')?.({key,shiftKey,preventDefault(){prevented=true;}});return prevented;}
  return{render,renderUpload,find,backdrop,key,document,buttons,get closed(){return closed;},get confirmed(){return confirmed;}};
}

test('拖入上传确认只允许取消或确认，遮罩和 Esc 均不关闭且保留键盘焦点循环',()=>{
  const ui=harness();ui.renderUpload();ui.backdrop();assert.equal(ui.key('Escape'),true);
  assert.equal(ui.closed,0);assert.equal(ui.confirmed,0);
  assert.equal(ui.find(node=>node.props.label==='关闭弹窗'),undefined);
  assert.equal(ui.document.activeElement,ui.buttons[0]);ui.key('Tab',true);assert.equal(ui.document.activeElement,ui.buttons[1]);
  ui.key('Tab');assert.equal(ui.document.activeElement,ui.buttons[0]);
  ui.find(node=>node.type==='button'&&node.props.children==='取消').props.onClick();assert.equal(ui.closed,1);assert.equal(ui.confirmed,0);
  ui.renderUpload();ui.find(node=>node.type==='button'&&node.props.children==='确认上传').props.onClick();assert.equal(ui.closed,1);assert.equal(ui.confirmed,1);
});

test('普通弹窗仍可点击遮罩、Esc 和关闭按钮退出，禁用关闭时保持打开',()=>{
  const ui=harness();ui.render();ui.backdrop();ui.key('Escape');ui.find(node=>node.props.label==='关闭弹窗').props.onClick();assert.equal(ui.closed,3);
  ui.render({dismissDisabled:true});ui.backdrop();ui.key('Escape');assert.equal(ui.closed,3);
  ui.renderUpload();ui.backdrop();ui.key('Escape');assert.equal(ui.closed,3,'原监听器使用最新的关闭策略');
});
