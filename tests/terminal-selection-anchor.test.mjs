import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {terminalSelectionBounds} from '../src/state/terminalSelectionPosition.ts';

const source=ts.createSourceFile('RemoteTerminalView.tsx',readFileSync(new URL('../src/components/RemoteTerminalView.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler;
function visit(node){if(ts.isJsxAttribute(node)&&node.name.getText(source)==='onPointerUp')handler=node.initializer.expression;ts.forEachChild(node,visit);}
visit(source);assert.ok(handler);
const code=ts.transpileModule(`exports.select=${handler.getText(source)};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(){
 const calls=[],frames=[];const node={isConnected:true};
 const terminal={getSelection:()=> 'selected rows',getSelectionPosition:()=>({start:{x:5,y:102},end:{x:15,y:102}}),buffer:{active:{viewportY:100}},rows:10,cols:80,
  element:{querySelector:()=>({getBoundingClientRect:()=>({left:20,right:820,top:200,bottom:400})})}};
 const term={current:terminal};const context=vm.createContext({exports:{},term,visibleRef:{current:true},terminalSelectionBounds,requestAnimationFrame:callback=>frames.push(callback),setSelectionAction:value=>calls.push(value),setSelectionActionPosition:value=>assert.equal(value,null)});
 vm.runInContext(code,context);
 return{terminal,node,term,calls,select:(x,y,button=0)=>context.exports.select({button,currentTarget:node,clientX:x,clientY:y}),flush:()=>frames.splice(0).forEach(callback=>callback())};
}
test('Pointer release coordinates do not decide placement; the actual xterm range does',()=>{
 const ui=harness();ui.select(800,550);ui.flush();ui.select(30,210);ui.flush();
 assert.deepEqual(JSON.parse(JSON.stringify(ui.calls)),[{text:'selected rows',anchor:{left:70,right:170,top:240,bottom:260}},{text:'selected rows',anchor:{left:70,right:170,top:240,bottom:260}}]);
});
test('Right click, detached views and stale runtimes cannot create a selection toolbar',()=>{
 const ui=harness();ui.select(0,0,2);ui.flush();assert.equal(ui.calls.length,0);
 ui.select(0,0);ui.node.isConnected=false;ui.flush();assert.equal(ui.calls.length,0);
 ui.node.isConnected=true;ui.select(0,0);ui.term.current=null;ui.flush();assert.equal(ui.calls.length,0);
});
test('Empty or offscreen selections dismiss the old toolbar',()=>{
 const ui=harness();ui.terminal.getSelection=()=> ' ';ui.select(0,0);ui.flush();assert.equal(ui.calls.at(-1),null);
 ui.terminal.getSelection=()=> 'old text';ui.terminal.getSelectionPosition=()=>({start:{x:0,y:2},end:{x:5,y:3}});ui.select(0,0);ui.flush();assert.equal(ui.calls.at(-1),null);
});
