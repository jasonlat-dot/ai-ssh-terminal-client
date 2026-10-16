import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const output=ts.transpileModule(readFileSync(new URL('../src/components/ChatAttachments.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function all(n){return Array.isArray(n)?n.flatMap(all):n?.props?[n,...all(n.props.children)]:[];}
function harness(){const state=[],effects=[],calls=[];let cursor=0,tree;const hooks={useState(value){const i=cursor++;if(!(i in state))state[i]=value;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(fn);}}};
 const context=vm.createContext({exports:{},Error,JSON,require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='../state/chatAttachments')return{isImageAttachment:name=>/\.(png|jpe?g|webp)$/i.test(name),textExcerptLabel:()=>''};if(name==='../api/agent')return{agentApi:{attachment:(...args)=>new Promise((resolve,reject)=>calls.push({args,resolve,reject}))}};if(name==='./Ui')return{Icon:()=>null,Modal:()=>null};return new Proxy({},{get:()=>()=>null});}});vm.runInContext(output,context);
 const props={files:[{fileId:'file',fileName:'manual.pdf',contentType:'application/pdf',size:10}],attach(){},disabled:false,scope:{agentId:'model',sessionId:'chat-a'}};
 const render=()=>{cursor=0;tree=context.exports.MessageAttachments(props);while(effects.length)effects.shift()();return tree;};const find=pred=>all(tree).find(pred);render();render();return{props,calls,render,find};}

test('Attachment preview reads the exact model/session/file and renders extracted content as text',async()=>{
 const h=harness();h.find(n=>n.type==='button'&&n.props.children==='查看发送内容').props.onClick();h.render();assert.deepEqual(Array.from(h.calls[0].args),['model','chat-a','file']);assert.ok(h.find(n=>n.props.role==='status'));
 h.calls[0].resolve({text:'[第 1 页]\n<script>untrusted()</script>',imageUrl:null,reference:{kind:'pdfText'}});await new Promise(setImmediate);h.render();assert.equal(h.find(n=>n.type==='pre').props.children,'[第 1 页]\n<script>untrusted()</script>');assert.equal(h.find(n=>n.props.dangerouslySetInnerHTML),undefined);
});
test('Late previews cannot replace a newly opened attachment in another session',async()=>{
 const h=harness();h.find(n=>n.type==='button'&&n.props.children==='查看发送内容').props.onClick();h.render();h.props.scope={agentId:'model',sessionId:'chat-b'};h.render();h.render();h.find(n=>n.type==='button'&&n.props.children==='查看发送内容').props.onClick();h.render();
 h.calls[0].resolve({text:'old conversation',imageUrl:null});await new Promise(setImmediate);h.render();assert.equal(h.find(n=>n.type==='pre'),undefined);h.calls[1].resolve({text:null,imageUrl:'data:image/jpeg;base64,prepared'});await new Promise(setImmediate);h.render();assert.equal(h.find(n=>n.type==='img').props.src,'data:image/jpeg;base64,prepared');
});
test('Preview failures show an error without removing the attachment or claiming it was read',async()=>{
 const h=harness();h.find(n=>n.type==='button'&&n.props.children==='查看发送内容').props.onClick();h.calls[0].reject(new Error('附件不属于当前会话'));await new Promise(setImmediate);h.render();assert.equal(h.find(n=>n.props.role==='alert').props.children,'附件不属于当前会话');assert.ok(h.find(n=>n.type==='button'&&n.props.children==='查看发送内容'));
});

function imageHarness(props){
 const state=[],deps=[],cleanups=[],effects=[],calls=[];let cursor=0,tree;
 const hooks={useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useEffect(fn,next){const i=cursor++;if(!deps[i]||next.some((v,j)=>v!==deps[i][j])){deps[i]=next;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
 const request=(kind,args)=>new Promise((resolve,reject)=>calls.push({kind,args,resolve,reject}));
 const context=vm.createContext({exports:{},Error,JSON,require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='../api/agent')return{agentApi:{attachment:(...args)=>request('session',args)}};if(name==='../api/files')return{readNativeAttachmentPreview:(...args)=>request('file',args)};return new Proxy({},{get:()=>()=>null});}});
 vm.runInContext(output,context);const render=()=>{cursor=0;tree=context.exports.AttachmentImage(props);while(effects.length)effects.shift()();return tree;};const find=predicate=>all(tree).find(predicate);
 render();render();return{props,calls,render,find,all:()=>all(tree)};
}
test('Image drafts show their thumbnail directly and clicking opens a larger preview',()=>{
 const h=imageHarness({file:{fileId:'id',fileName:'shot.png',previewUrl:'data:image/jpeg;base64,draft'}});
 assert.equal(h.calls.length,0);assert.equal(h.find(n=>n.type==='img').props.src,'data:image/jpeg;base64,draft');
 h.find(n=>n.props['aria-label']==='预览图片 shot.png').props.onClick();h.render();assert.equal(h.all().filter(n=>n.type==='img').length,2);
});
test('History images automatically read the scoped snapshot and discard stale image responses',async()=>{
 const h=imageHarness({file:{fileId:'id',fileName:'shot.png'},scope:{agentId:'model',sessionId:'chat-a'}});
 assert.deepEqual(Array.from(h.calls[0].args),['model','chat-a','id']);assert.equal(h.calls[0].kind,'session');
 h.props.scope={agentId:'model',sessionId:'chat-b'};h.render();h.render();
 h.calls[0].resolve({imageUrl:'data:image/jpeg;base64,old'});await new Promise(setImmediate);h.render();assert.equal(h.find(n=>n.type==='img'),undefined);
 h.calls[1].resolve({imageUrl:'data:image/jpeg;base64,new'});await new Promise(setImmediate);h.render();assert.equal(h.find(n=>n.type==='img').props.src,'data:image/jpeg;base64,new');
});
test('Stored image references load native thumbnails and failed reads remain retryable',async()=>{
 const h=imageHarness({file:{fileId:'id',fileName:'shot.png'}});assert.equal(h.calls[0].kind,'file');
 h.calls[0].reject(new Error('读取失败'));await new Promise(setImmediate);h.render();assert.ok(h.find(n=>n.props.role==='alert'));
 h.find(n=>n.props['aria-label']==='重新加载 shot.png').props.onClick();h.render();h.calls[1].resolve('data:image/jpeg;base64,ok');await new Promise(setImmediate);h.render();assert.equal(h.find(n=>n.type==='img').props.src,'data:image/jpeg;base64,ok');
});

test('All native file placeholders show a circular indicator on their visual, and progress is indeterminate',()=>{
 const context=vm.createContext({exports:{},require(name){
  if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='../state/chatAttachments')return{isImageAttachment:name=>/\.(png|jpe?g|webp)$/i.test(name)};
  return new Proxy({},{get:()=>()=>null});
 }});vm.runInContext(output,context);
 const tree=context.exports.DraftAttachments({items:[],pending:[{id:'image',fileName:'shot.png',size:10},{id:'pdf',fileName:'manual.pdf',size:20},{id:'text',fileName:'notes.txt',size:30}],draft:{},locked:false,report(){}});
 const visuals=all(tree).filter(n=>n.props.className==='chat-attachment-visual');assert.equal(visuals.length,3);
 for(const visual of visuals)assert.equal(all(visual).filter(n=>n.type===context.exports.AttachmentProgress).length,1);
 const ring=context.exports.AttachmentProgress({name:'manual.pdf'});assert.equal(ring.props.role,'progressbar');assert.equal(ring.props['aria-valuenow'],undefined);
});
