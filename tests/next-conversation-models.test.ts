import assert from 'node:assert/strict';
import test from 'node:test';
import {NextConversationModels} from '../src/state/nextConversationModels';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};

test('Latest next-turn choice wins; choosing the running model cancels an unapplied choice',async()=>{
 const models=new NextConversationModels();models.select('A','original','next');models.select('A','original','last');
 const calls:string[][]=[];await models.apply('A',async(previous,next)=>{calls.push([previous,next]);});
 assert.deepEqual(calls,[['original','last']]);assert.equal(models.get('A'),undefined);assert.equal(models.currentId('A','stale-sidebar'),'last');
 models.select('B','original','next');models.select('B','original','original');assert.equal(models.get('B'),undefined);
});

test('An in-flight native change serializes further choices, including changing back to the original model',async()=>{
 const models=new NextConversationModels(),first=deferred(),calls:string[][]=[];
 models.select('A','original','next');
 const change=async(previous:string,next:string)=>{calls.push([previous,next]);if(calls.length===1)await first.promise;};
 const applying=models.apply('A',change);await Promise.resolve();assert.equal(models.get('A')?.saving,true);
 models.select('A','original','original');assert.equal(models.apply('A',change),applying);
 first.resolve();assert.equal(await applying,true);assert.deepEqual(calls,[['original','next'],['next','original']]);assert.equal(models.get('A'),undefined);
});

test('Failed transitions preserve the pending preference and current identity until explicit retry',async()=>{
 const models=new NextConversationModels();models.select('A','original','next');let attempts=0;
 const change=async()=>{if(++attempts===1)throw Error('模型已删除');};
 assert.equal(await models.apply('A',change),false);assert.equal(models.get('A')?.error,'模型已删除');assert.equal(models.currentId('A','other'),'original');
 models.select('A','original','next');assert.equal(models.get('A')?.error,undefined);
 assert.equal(await models.apply('A',change),true);assert.equal(models.currentId('A','original'),'next');
});

test('Background choices are independent and disposing prevents an awaited result from creating new state',async()=>{
 const models=new NextConversationModels(),wait=deferred();models.select('A','old-A','new-A');models.select('B','old-B','new-B');
 const a=models.apply('A',async()=>wait.promise);await Promise.resolve();
 await models.apply('B',async()=>{});assert.equal(models.get('A')?.saving,true);assert.equal(models.get('B'),undefined);
 models.dispose();wait.resolve();assert.equal(await a,false);assert.equal(models.get('A'),undefined);assert.equal(models.currentId('B','fallback'),'fallback');
});

test('StrictMode effect cleanup and setup reactivates the registry without resurrecting an old job',async()=>{
 const models=new NextConversationModels(),wait=deferred();models.select('A','old','stale');
 const stale=models.apply('A',async()=>wait.promise);await Promise.resolve();models.dispose();models.activate();
 models.select('A','old','new');await models.apply('A',async()=>{});wait.resolve();
 assert.equal(await stale,false);assert.equal(models.currentId('A','old'),'new');assert.equal(models.get('A'),undefined);
});

test('Cancelling an unconfirmed transition reconciles its attempted model before allowing another send',async()=>{
 const models=new NextConversationModels();models.select('A','original','next');
 await models.apply('A',async()=>{throw Error('receipt lost');});
 models.select('A','original','original');assert.equal(models.get('A')?.attemptedId,'next');
 const wait=deferred(),calls:unknown[]=[];
 const applying=models.apply('A',async(...args)=>{calls.push(args);await wait.promise;});await Promise.resolve();
 assert.equal(models.saving,true);wait.resolve();assert.equal(await applying,true);
 assert.deepEqual(calls,[['original','original','next']]);assert.equal(models.currentId('A','stale'),'original');assert.equal(models.saving,false);
});
