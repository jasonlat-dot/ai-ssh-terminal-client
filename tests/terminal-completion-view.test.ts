import assert from 'node:assert/strict';
import test from 'node:test';
import {attachTerminalCompletion} from '../src/state/terminalCompletionView';
import {saveCompletionPreferences} from '../src/state/terminalCompletionPreferences';

test('灰色建议使用独立 DOM 并跟随公开光标坐标，按键仅填入后缀，滚动与清理移除浮层',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const listeners=new Map<string,Function>(),events=new Map<string,Function>(),writes:string[]=[],renderWrites:string[]=[],ghosts:any[]=[],values=new Map<string,string>();
  const textarea={};const document:any={activeElement:textarea,hasFocus:()=>true,body:{appendChild(node:any){ghosts.push(node);}},
    createElement(){return {hidden:true,textContent:'',style:{},setAttribute(){},remove(){ghosts.splice(0);}};}};
  const window:any={addEventListener:(name:string,fn:Function)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name),dispatchEvent:(event:Event)=>listeners.get(event.type)?.()};
  Object.assign(globalThis,{document,window,localStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)}});
  saveCompletionPreferences({enabled:true,aiEnabled:true,sendDirectory:false,modelId:'fake',delayMs:500});
  const buffer={type:'normal',viewportY:0,baseY:0,cursorX:16,cursorY:1,getLine:()=>({isWrapped:false})};
  const subscribe=(name:string)=>(callback:Function)=>{events.set(name,callback);return {dispose:()=>events.delete(name)};};
  const terminal:any={element:{contains:(node:any)=>node===textarea,querySelector:()=>({getBoundingClientRect:()=>({left:4,top:20,width:900,height:264})}),addEventListener(){},removeEventListener(){}},
    buffer:{active:buffer},cols:90,rows:12,hasSelection:()=>false,options:{fontFamily:'Consolas',fontSize:14,fontWeight:500},
    parser:{registerOscHandler:(_id:number,callback:Function)=>{events.set('osc',callback);return {dispose:()=>events.delete('osc')};}},
    onScroll:subscribe('scroll'),onResize:subscribe('resize'),onSelectionChange:subscribe('selection'),onWriteParsed:subscribe('parsed'),
    write(data:string){renderWrites.push(data);assert.match(data,/^\x1b\[\?2026[hl]$/);}};
  const view=attachTerminalCompletion(terminal,async text=>{writes.push(text);},()=>true,()=>{},async()=>({suffix:' logs -f'}));
  await view.controller.initialize();const nonce=writes[0].match(/spc;([a-f0-9]{32});R/)![1];
  const osc=(value:string)=>events.get('osc')!(`spc;${nonce};${value}`);
  osc('R');await Promise.resolve();osc('I');osc('P;1');view.controller.input('e');t.mock.timers.tick(500);
  osc(`S;1;1;14;${Buffer.from('docker compose').toString('hex')};2f6f7074`);t.mock.timers.tick(0);await Promise.resolve();await Promise.resolve();
  assert.equal(renderWrites[0],'\x1b[?2026h');t.mock.timers.tick(50);assert.equal(renderWrites.at(-1),'\x1b[?2026l');
  const ghost=ghosts[0];assert.equal(ghost.hidden,false);assert.equal(ghost.textContent,' logs -f');assert.equal(ghost.style.left,'164px');assert.equal(ghost.style.top,'42px');assert.equal(ghost.style.lineHeight,'22px');events.get('parsed')!();assert.equal(ghost.hidden,false);
  assert.equal(view.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent),true);assert.equal(writes.at(-1),' logs -f');assert.equal(ghost.hidden,true);
  events.get('scroll')!();view.dispose();assert.equal(ghosts.length,0);assert.equal(events.size,0);assert.equal(listeners.size,0);
});
