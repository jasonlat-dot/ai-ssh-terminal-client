import assert from 'node:assert/strict';
import test from 'node:test';
import {historyPreviewPosition,historyPreviewTime} from '../src/state/historyPreview.ts';

test('History preview prefers the right of the row and flips left at the window edge',()=>{
 const card={width:352,height:124},viewport={width:1000,height:800};
 assert.deepEqual(historyPreviewPosition({left:70,right:300,top:100,bottom:134},card,viewport),{left:310,top:96});
 assert.deepEqual(historyPreviewPosition({left:700,right:950,top:100,bottom:134},card,viewport),{left:338,top:96});
});

test('Preview stays inside the viewport near the bottom and on narrow windows',()=>{
 const card={width:352,height:124};
 assert.deepEqual(historyPreviewPosition({left:70,right:300,top:760,bottom:794},card,{width:1000,height:800}),{left:310,top:664});
 assert.deepEqual(historyPreviewPosition({left:24,right:280,top:100,bottom:134},{width:336,height:124},{width:360,height:800}),{left:12,top:144});
 assert.deepEqual(historyPreviewPosition({left:24,right:280,top:700,bottom:734},{width:336,height:124},{width:360,height:800}),{left:12,top:566});
});

test('Preview time uses session creation seconds with explicit creation metadata',()=>{
 const now=Date.UTC(2026,9,16,12);
 for(const [seconds,label] of [[10,'刚刚'],[120,'2 分钟前'],[7200,'2 小时前'],[432000,'5 天前']] as const){
  const stamp=(now-seconds*1000)/1000;
  const time=historyPreviewTime(stamp,now)!;
  assert.equal(time.label,label);assert.equal(time.iso,new Date(stamp*1000).toISOString());assert.match(time.full,/^创建于 /);
 }
 assert.equal(historyPreviewTime(0,now),null);
 assert.equal(historyPreviewTime(Number.NaN,now),null);
 assert.equal(historyPreviewTime(Number.MAX_VALUE,now),null);
 assert.match(historyPreviewTime((now-40*86400000)/1000,now)!.label,/2026/);
});
