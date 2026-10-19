import assert from 'node:assert/strict';
import test from 'node:test';
import {terminalSelectionBounds,terminalSelectionActionPosition} from '../src/state/terminalSelectionPosition.ts';

const screen={left:20,right:820,top:200,bottom:400};
test('A single selected row anchors to its actual buffer cells after scrollback',()=>{
 assert.deepEqual(terminalSelectionBounds({start:{x:5,y:102},end:{x:15,y:102}},100,10,80,screen),{left:70,right:170,top:240,bottom:260});
});
test('Multiline selection uses its first visible row and excludes an end at column zero',()=>{
 assert.deepEqual(terminalSelectionBounds({start:{x:5,y:102},end:{x:0,y:104}},100,10,80,screen),{left:20,right:820,top:240,bottom:280});
 assert.deepEqual(terminalSelectionBounds({start:{x:5,y:90},end:{x:3,y:102}},100,10,80,screen),{left:20,right:820,top:200,bottom:260});
});
test('Invisible or unavailable selections do not produce an overlay',()=>{
 assert.equal(terminalSelectionBounds(undefined,100,10,80,screen),null);
 assert.equal(terminalSelectionBounds({start:{x:1,y:90},end:{x:2,y:95}},100,10,80,screen),null);
 assert.equal(terminalSelectionBounds({start:{x:1,y:120},end:{x:2,y:125}},100,10,80,screen),null);
 assert.equal(terminalSelectionBounds({start:{x:1,y:100},end:{x:2,y:100}},100,0,80,screen),null);
});
test('Toolbar sits above the selection using its measured height, with a gap',()=>{
 const anchor={left:120,right:220,top:300,bottom:320},card={width:160,height:36};
 const position=terminalSelectionActionPosition(anchor,card,{width:1000,height:800});
 assert.deepEqual(position,{left:90,top:256});assert.ok(position.top+card.height<anchor.top);
});
test('Insufficient space above flips below; horizontal and vertical edges stay inside the viewport',()=>{
 const card={width:160,height:36};
 assert.deepEqual(terminalSelectionActionPosition({left:10,right:30,top:10,bottom:30},card,{width:1000,height:800}),{left:8,top:38});
 const position=terminalSelectionActionPosition({left:990,right:1010,top:790,bottom:810},card,{width:1000,height:800});
 assert.equal(position.left,832);assert.ok(position.top+card.height<=792);
});
