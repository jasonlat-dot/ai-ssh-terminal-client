import assert from 'node:assert/strict';
import test from 'node:test';
import {messageTime} from '../src/state/messageTime.ts';
const local=(year:number,month:number,day:number,hour=0,minute=0)=>new Date(year,month-1,day,hour,minute).getTime();
test('Only the same local calendar day uses a bare clock; yesterday within 24 hours includes its date',()=>{
 const now=local(2026,10,16,0,5);
 assert.equal(messageTime(local(2026,10,16,0,2),now)?.label,'00:02');
 assert.equal(messageTime(local(2026,10,15,23,59),now)?.label,'10-15 23:59');
});
test('Older days retain their date, and a different calendar year includes the year',()=>{
 assert.equal(messageTime(local(2026,1,2,9,7),local(2026,10,16))?.label,'01-02 09:07');
 assert.equal(messageTime(local(2025,12,31,23,59),local(2026,1,1,0,1))?.label,'2025-12-31 23:59');
});
test('The same message changes format at midnight without changing its original timestamp',()=>{
 const stamp=local(2026,10,15,22,30);
 assert.equal(messageTime(stamp,local(2026,10,15,23,59))?.label,'22:30');
 const after=messageTime(stamp,local(2026,10,16,0,0));
 assert.equal(after?.label,'10-15 22:30');assert.equal(after?.iso,new Date(stamp).toISOString());
});
test('Absent or invalid native timestamps render no misleading clock',()=>{
 for(const value of [undefined,0,-1,NaN,Infinity,Number.MAX_VALUE])assert.equal(messageTime(value),null);
});
