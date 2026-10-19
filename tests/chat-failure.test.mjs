import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../src/components/ChatFailure.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness({desktop=true, reveal=async()=>{}}={}) {
 const slots=[];let cursor=0;
 const context=vm.createContext({exports:{},Error,require(name){
  if(name==='react')return {
   useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=value;}];},
   useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  };
  if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='../api/chatErrors')return{chatErrorGuidance:()=> '检查接口后手动发送。'};
  if(name==='../api/requestLogs')return{revealRequestLog:reveal};
  if(name==='../state/runtime')return{isTauriRuntime:()=>desktop};
  if(name==='./CopyTextButton')return{CopyTextButton:()=>null};
  if(name==='./Ui')return{Icon:()=>null};if(name.endsWith('.css'))return{};throw Error(name);
 }});vm.runInContext(code,context);
 return props=>{cursor=0;return context.exports.ChatFailure(props);};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function nodes(node){if(Array.isArray(node))return node.flatMap(nodes);return node?.props?[node,...nodes(node.props.children)]:[];}
function text(node){if(Array.isArray(node))return node.map(text).join('');if(node?.props)return text(node.props.children);return typeof node==='string'?node:'';}
test('Failure remains inline with diagnostic detail, trace and a manual restore action',()=>{
 let restored=0;const trace='3165db87-b00c-4242-ae66-ad1fd23ec3ed';
 const tree=harness()({message:{errorMessage:'Model provider returned HTTP 400'},traceId:trace,disabled:false,restore:()=>{restored++;}});
 assert.match(text(tree),/本次回复未完成/);assert.match(text(tree),/HTTP 400/);assert.match(text(tree),/工具记录已保留在对话中/);assert.match(text(tree),/不会自动重发/);assert.ok(text(tree).includes(trace));
 const action=nodes(tree).find(n=>n.props.className==='chat-failure-restore');assert.equal(action.props.disabled,false);action.props.onClick();assert.equal(restored,1);
 const copy=nodes(tree).find(n=>n.props.label==='复制 Trace ID');assert.equal(copy.props.getText(),trace);
});
test('Unadmitted failures explain page-only retention and restoration locks during generation',()=>{
 const tree=harness()({message:{errorLocalOnly:true,errorMessage:'<script>unsafe text</script>'},disabled:true,restore(){assert.fail('disabled');}});
 assert.match(text(tree),/尚未保存到工作区/);assert.doesNotMatch(text(tree),/已保留在对话中/);assert.equal(nodes(tree).find(n=>n.props.className==='chat-failure-restore').props.disabled,true);
 assert.ok(nodes(tree).every(n=>n.props.dangerouslySetInnerHTML===undefined));
 assert.equal(nodes(tree).find(n=>n.props.className==='chat-failure-trace'),undefined);
});


test('Locate reveals the exact trace once and disables repeated clicks while native lookup is pending',async()=>{
 let finish;const calls=[];const pending=new Promise(resolve=>{finish=resolve;});
 const render=harness({reveal:trace=>{calls.push(trace);return pending;}});
 const props={message:{},traceId:'trace-123',disabled:true,restore(){assert.fail('never restore');}};
 const button=tree=>nodes(tree).find(n=>n.props.className==='chat-failure-locate');
 const tree=render(props);assert.equal(button(tree).props.disabled,false,'reading logs does not resend or edit a busy chat');
 button(tree).props.onClick();button(tree).props.onClick();assert.deepEqual(calls,['trace-123']);
 const busy=button(render(props));assert.equal(busy.props.disabled,true);assert.match(text(busy),/正在定位/);
 finish();await settle();assert.equal(button(render(props)).props.disabled,false);
});

test('Missing logs remain explained inline and explicit retry clears the previous lookup error',async()=>{
 let attempts=0;
 const render=harness({reveal:async()=>{if(++attempts===1)throw Error('日志已过期清理');}});
 const props={message:{},traceId:'trace-123',disabled:false,restore(){}};
 const click=()=>nodes(render(props)).find(n=>n.props.className==='chat-failure-locate').props.onClick();
 click();await settle();assert.match(text(render(props)),/日志已过期清理/);
 assert.ok(nodes(render(props)).some(n=>n.props.role==='status'));
 click();assert.doesNotMatch(text(render(props)),/日志已过期清理/);await settle();assert.equal(attempts,2);
});

test('Locate is absent without a trace or outside the desktop runtime',()=>{
 const props={message:{},traceId:'trace-123',disabled:false,restore(){}};
 assert.ok(!nodes(harness({desktop:false})(props)).some(n=>n.props.className==='chat-failure-locate'));
 assert.ok(!nodes(harness()({...props,traceId:undefined})).some(n=>n.props.className==='chat-failure-locate'));
});
