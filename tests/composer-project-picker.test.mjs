import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const output=ts.transpileModule(readFileSync(new URL('../src/components/ComposerProjectPicker.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n?.props?[n,...nodes(n.props.children)]:[];
function harness(){
 const state=[],effects=[],listeners=new Map(),actions=[];let cursor=0,tree,focused=0;
 const hooks={useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=cursor++;return state[i]??(state[i]={current:initial});},useId(){return 'picker';},useEffect(fn,deps){const i=cursor++,old=state[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){state[i]={deps};effects.push(()=>{old?.cleanup?.();state[i].cleanup=fn();});}},useLayoutEffect(fn,deps){hooks.useEffect(fn,deps);}};
 const document={body:{},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key,fn)=>{if(listeners.get(key)===fn)listeners.delete(key);}};
 const window={innerWidth:1000,innerHeight:800,addEventListener(){},removeEventListener(){}};
 const context=vm.createContext({exports:{},document,window,Math,require(name){if(name==='react')return hooks;if(name==='react-dom')return{createPortal:node=>node};if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='./Ui')return{Icon:()=>null};if(name.endsWith('.css'))return{};throw Error(name);}});
 vm.runInContext(output,context);
 const props={project:null,projects:[{id:'a',name:'已有项目 A',identity:null},{id:'b',name:'日志项目',identity:{host:'b.test'}}],disabled:false,onChange:id=>actions.push(id),onCreate:()=>actions.push('create')};
 const render=()=>{cursor=0;tree=context.exports.ComposerProjectPicker(props);for(const n of nodes(tree)){if(n.props.ref)n.props.ref.current=n.type==='button'?{focus(){focused++;},contains:()=>false,getBoundingClientRect:()=>({left:100,top:600,bottom:630})}:{contains:()=>false,querySelector:()=>({scrollIntoView(){}})};}while(effects.length)effects.shift()();};
 const find=fn=>nodes(tree).find(fn),all=fn=>nodes(tree).filter(fn);
 render();const open=()=>{find(n=>n.props['aria-label']==='选择项目'&&n.type==='button').props.onClick();render();render();};
 return{props,actions,find,all,render,open,listeners,focused:()=>focused};
}
test('Text chat prompts to choose a project and opens an anchored searchable popup with a creation action',()=>{
 const h=harness();assert.equal(h.find(n=>n.type==='button').props.children[1].props.children,'选择项目');assert.equal(h.find(n=>n.props.role==='dialog'),undefined);
 h.open();assert.equal(h.find(n=>n.type==='input').props.placeholder,'搜索项目');assert.equal(h.all(n=>n.props.role==='option').length,2);
 assert.equal(h.find(n=>n.props.role==='dialog').props.style.bottom,206);
 h.find(n=>n.type==='button'&&n.props.children?.[1]?.props?.children==='新建项目').props.onClick();h.render();assert.deepEqual(h.actions,['create']);assert.equal(h.find(n=>n.props.role==='dialog'),undefined);
});
test('Search filters existing projects by name and host, Enter selects the result, and no matches never select anything',()=>{
 const h=harness();h.open();h.find(n=>n.type==='input').props.onChange({target:{value:'B.TEST'}});h.render();h.render();assert.equal(h.all(n=>n.props.role==='option').length,1);
 h.find(n=>n.props.role==='dialog').props.onKeyDown({key:'Enter',preventDefault(){}});h.render();assert.deepEqual(h.actions,['b']);assert.ok(h.focused());
 h.open();h.find(n=>n.type==='input').props.onChange({target:{value:'不存在'}});h.render();h.render();assert.equal(h.find(n=>n.props.className==='composer-project-empty').props.children,'没有匹配的项目');
 h.find(n=>n.props.role==='dialog').props.onKeyDown({key:'Enter',preventDefault(){}});assert.deepEqual(h.actions,['b']);
});
test('Arrow keys choose existing projects while Escape, outside click and running-state lock close without selecting',()=>{
 const h=harness();h.open();h.find(n=>n.props.role==='dialog').props.onKeyDown({key:'ArrowDown',preventDefault(){}});h.render();h.find(n=>n.props.role==='dialog').props.onKeyDown({key:'Enter',preventDefault(){}});h.render();assert.deepEqual(h.actions,['b']);
 h.open();h.find(n=>n.props.role==='dialog').props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});h.render();assert.equal(h.find(n=>n.props.role==='dialog'),undefined);
 h.open();h.listeners.get('pointerdown')({target:{}});h.render();assert.equal(h.find(n=>n.props.role==='dialog'),undefined);
 h.open();h.props.disabled=true;h.render();h.render();assert.equal(h.find(n=>n.props.role==='dialog'),undefined);assert.deepEqual(h.actions,['b']);
});
