import assert from 'node:assert/strict';
import test from 'node:test';
import {modelPickerPosition} from '../src/state/modelPickerPosition.ts';

const base={trigger:{left:740,right:900,top:650,bottom:682},panel:{left:100,right:1000,top:50,bottom:750},composer:{left:140,right:960,top:590,bottom:730},viewport:{width:1400,height:800},groupRows:3,modelRows:4,level:'model' as const};
test('大窗口菜单靠输入区左侧展开，不跟随靠右的模型按钮偏移',()=>{
 const position=modelPickerPosition(base);
 assert.equal(position.compact,false);assert.equal(position.width,520);
 assert.equal(position.left,base.composer.left+12);
 assert.ok(position.top+position.height<base.trigger.top);
});
test('宽窗口内的窄聊天分栏使用单面板，所有边界留在聊天区域内',()=>{
 const position=modelPickerPosition({...base,panel:{left:900,right:1300,top:30,bottom:750},composer:{left:930,right:1270,top:590,bottom:730},trigger:{left:1090,right:1250,top:650,bottom:682}});
 assert.equal(position.compact,true);assert.ok(position.left>=908);assert.ok(position.left+position.width<=1292);
});
test('窗口缩小、放大或触发器靠近顶部时重新计算宽度和上下方向',()=>{
 const narrow=modelPickerPosition({...base,panel:undefined,composer:undefined,trigger:{left:20,right:180,top:40,bottom:72},viewport:{width:320,height:300}});
 assert.equal(narrow.compact,true);assert.ok(narrow.left>=8);assert.ok(narrow.left+narrow.width<=312);assert.ok(narrow.top>=78);assert.ok(narrow.top+narrow.height<=292);
 const wide=modelPickerPosition({...base,panel:undefined,composer:undefined,viewport:{width:1600,height:900}});assert.equal(wide.compact,false);
});
