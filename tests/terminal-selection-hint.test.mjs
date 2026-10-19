import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code=ts.transpileModule(readFileSync(new URL('../src/components/TerminalSelectionHint.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness(){
 const slots=[],effects=[],layouts=[],timers=new Map(),listeners=new Map();let cursor=0,sequence=0,tree,added=0;
 const props={visible:true,disabled:true,description:'先用鼠标选中终端里的文字。',onAdd:()=>{added++;}};
 const document={body:{},activeElement:null};
 const anchor={isConnected:true,getBoundingClientRect:()=>({left:950,right:1050,top:740,bottom:770}),contains:node=>node===anchor};
 const card={getBoundingClientRect:()=>({width:304,height:112}),contains:node=>node===card};
 const schedule=(callback,delay)=>{const id=++sequence;timers.set(id,{callback,delay});return id;},cancel=id=>timers.delete(id);
 function effect(queue,callback,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){const slot={deps,cleanup:null};slots[i]=slot;queue.push(()=>{old?.cleanup?.();slot.cleanup=callback();});}}
 const hooks={useId:()=> 'terminal-hint-id',useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
  useEffect:(callback,deps)=>effect(effects,callback,deps),useLayoutEffect:(callback,deps)=>effect(layouts,callback,deps)};
 const context=vm.createContext({exports:{},document,setTimeout:schedule,clearTimeout:cancel,window:{innerWidth:1024,innerHeight:800,getComputedStyle:()=>({fontFamily:'Custom UI Font'}),
  addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},removeEventListener(name,callback){listeners.get(name)?.delete(callback);}},require(name){
  if(name==='react')return hooks;if(name==='react-dom')return{createPortal:content=>content};if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='./Ui')return{Icon:()=>null};throw Error(name);
 }});vm.runInContext(code,context);
 function nodes(node){if(arguments.length===0)node=tree;return Array.isArray(node)?node.flatMap(n=>nodes(n)):node?.props?[node,...nodes(node.props.children)]:[];}
 function render(){cursor=0;tree=context.exports.TerminalSelectionHint(props);tree.props.ref.current=anchor;const tip=nodes().find(n=>n.props.role==='tooltip');if(tip)tip.props.ref.current=card;layouts.splice(0).forEach(f=>f());effects.splice(0).forEach(f=>f());}
 render();render();
 return{props,document,anchor,card,timers,listeners,get added(){return added;},render,
  wrapper:()=>tree,button:()=>nodes().find(n=>n.type==='button'),tip:()=>nodes().find(n=>n.props.role==='tooltip'),
  flush(){const pending=[...timers.values()];timers.clear();pending.forEach(t=>t.callback());render();render();},
  emit(name,event){for(const callback of [...(listeners.get(name)??[])])callback(event);render();render();},
  unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
test('Disabled action gets a delayed custom hint with no native title; the card fits at the viewport edge',()=>{
 const ui=harness();assert.equal(ui.button().props.title,undefined);assert.equal(ui.wrapper().props.tabIndex,0);
 ui.wrapper().props.onPointerEnter({pointerType:'mouse'});assert.equal(ui.tip(),undefined);assert.equal([...ui.timers.values()][0].delay,400);ui.flush();
 assert.equal(ui.tip().props.className,'terminal-selection-hint');assert.equal(ui.tip().props.style.left,708);assert.equal(ui.tip().props.style.top,620);assert.equal(ui.tip().props.style.fontFamily,'Custom UI Font');
 assert.equal(ui.button().props['aria-describedby'],ui.tip().props.id);assert.equal(ui.wrapper().props['aria-describedby'],ui.tip().props.id);
 ui.button().props.onClick();assert.equal(ui.added,0);
});
test('Pointer can enter the hint to read it; quick departure and touch leave no stale popup',()=>{
 const ui=harness();ui.wrapper().props.onPointerEnter({pointerType:'mouse'});ui.wrapper().props.onPointerLeave();ui.flush();assert.equal(ui.tip(),undefined);
 ui.wrapper().props.onPointerEnter({pointerType:'touch'});assert.equal(ui.timers.size,0);
 ui.wrapper().props.onPointerEnter({pointerType:'mouse'});ui.flush();ui.wrapper().props.onPointerLeave();ui.tip().props.onPointerEnter();ui.flush();assert.ok(ui.tip());
 ui.tip().props.onPointerLeave();ui.flush();assert.equal(ui.tip(),undefined);
});
test('Keyboard focus opens immediately and never resets an existing hint to hidden; Esc and blur dismiss',()=>{
 const ui=harness();ui.document.activeElement=ui.anchor;ui.wrapper().props.onFocusCapture();ui.render();ui.render();assert.ok(ui.tip());
 ui.wrapper().props.onFocusCapture();ui.render();assert.equal(ui.tip().props.style.visibility,undefined);
 ui.emit('keydown',{key:'Escape'});assert.equal(ui.tip(),undefined);
 ui.wrapper().props.onFocusCapture();ui.render();ui.render();ui.wrapper().props.onBlurCapture();ui.render();assert.equal(ui.tip(),undefined);
});
test('Selection remains intact on mouse down and activation only invokes the explicit add action',()=>{
 const ui=harness();ui.props.disabled=false;ui.render();ui.render();assert.equal(ui.added,0);
 ui.wrapper().props.onFocusCapture();ui.render();ui.render();let prevented=0;ui.button().props.onMouseDown({preventDefault(){prevented++;}});assert.equal(prevented,1);
 ui.button().props.onClick();ui.render();assert.equal(ui.added,1);assert.equal(ui.tip(),undefined);
});
test('Resize, scroll, outside click, visibility changes and unmount clean up hints and timers',()=>{
 for(const event of ['resize','scroll','blur','pointerdown']){
  const ui=harness();ui.wrapper().props.onFocusCapture();ui.render();ui.render();ui.emit(event,{target:{}});assert.equal(ui.tip(),undefined);assert.ok([...ui.listeners.values()].every(list=>list.size===0));
 }
 const ui=harness();ui.wrapper().props.onPointerEnter({pointerType:'mouse'});ui.props.visible=false;ui.render();ui.flush();assert.equal(ui.tip(),undefined);
 ui.props.visible=true;ui.render();ui.wrapper().props.onPointerEnter({pointerType:'mouse'});ui.unmount();assert.equal(ui.timers.size,0);
});
