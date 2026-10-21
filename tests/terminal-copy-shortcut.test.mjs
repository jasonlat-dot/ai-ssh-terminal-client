import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.createSourceFile('RemoteTerminalView.tsx',readFileSync(new URL('../src/components/RemoteTerminalView.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler,copy;
function visit(node){
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='copySelection')copy=node.initializer;
 if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='attachCustomKeyEventHandler')handler=node.arguments[0];
 ts.forEachChild(node,visit);
}
visit(source);assert.ok(handler);assert.ok(copy);
const code=ts.transpileModule(`const copySelection=${copy.getText(source)};exports.handle=${handler.getText(source)};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(selection='selected terminal text',native=true){
 const copied=[],feedback=[];let pastes=0;
 const terminal={hasSelection:()=>selection.length>0,getSelection:()=>selection};
 const context=vm.createContext({exports:{},completion:{current:null},terminal,term:{current:terminal},visibleRef:{current:true},isTauriRuntime:()=>native,
  copyText:async text=>copied.push(text),showFeedback:(...args)=>feedback.push(args),pasteClipboard:async()=>{pastes++;}});
 vm.runInContext(code,context);
 return{copied,feedback,get pastes(){return pastes;},key(patch={}){let prevented=0;const result=context.exports.handle({key:'c',type:'keydown',ctrlKey:true,shiftKey:false,altKey:false,metaKey:false,repeat:false,preventDefault(){prevented++;},...patch});return{result,prevented};}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('Ctrl+C copies the xterm selection verbatim and consumes the key instead of interrupting',async()=>{
 const ui=harness('line 1\r\n第二行 😀');assert.deepEqual(ui.key(),{result:false,prevented:1});await settle();
 assert.deepEqual(ui.copied,['line 1\r\n第二行 😀']);assert.equal(ui.feedback[0][0],'已复制选中文本');
});
test('Ctrl+C with no selection still reaches the terminal for its normal interrupt',()=>{
 const ui=harness('');assert.deepEqual(ui.key(),{result:true,prevented:0});assert.deepEqual(ui.copied,[]);assert.deepEqual(ui.feedback,[]);
});
test('Keyup and autorepeat do not duplicate the clipboard write or leak selected Ctrl+C to the shell',async()=>{
 const ui=harness();ui.key();assert.equal(ui.key({type:'keyup'}).result,false);assert.equal(ui.key({repeat:true}).result,false);await settle();assert.equal(ui.copied.length,1);
});
test('Existing Ctrl+Shift+C and macOS Command+C keep copying while unrelated keys remain unchanged',async()=>{
 const ui=harness();assert.equal(ui.key({shiftKey:true}).result,false);assert.equal(ui.key({ctrlKey:false,metaKey:true}).result,false);
 assert.equal(ui.key({ctrlKey:false}).result,true);assert.equal(ui.key({altKey:true}).result,true);assert.equal(ui.key({key:'x'}).result,true);
 await settle();assert.equal(ui.copied.length,2);
 const empty=harness('');assert.equal(empty.key({shiftKey:true}).result,false);assert.equal(empty.feedback[0][0],'请先选中要复制的终端文本');
});
test('Paste shortcuts preserve native paste routing and leave browser OS-paste handling intact',()=>{
 for(const patch of [{key:'v'},{key:'v',shiftKey:true},{key:'Insert',ctrlKey:false,shiftKey:true}]){
  const ui=harness();assert.deepEqual(ui.key(patch),{result:false,prevented:1});assert.equal(ui.pastes,1);
  const web=harness('',false);assert.deepEqual(web.key(patch),{result:false,prevented:0});assert.equal(web.pastes,0);
 }
});
