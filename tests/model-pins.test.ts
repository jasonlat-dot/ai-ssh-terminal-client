import assert from 'node:assert/strict';
import test from 'node:test';
import {loadModelPins,orderPinnedModels,saveModelPins} from '../src/state/modelPins.ts';

test('置顶顺序独立于名称、时钟和创建顺序，移除置顶恢复原位置且不改动源列表',()=>{
  const profiles=[{id:'z-first'},{id:'a-second'},{id:'m-third'}];
  const order=(pins:string[])=>orderPinnedModels(profiles,pins).map(profile=>profile.id);
  assert.deepEqual(order(['a-second']),['a-second','z-first','m-third']);
  assert.deepEqual(order(['m-third','a-second']),['m-third','a-second','z-first']);
  assert.deepEqual(order(['m-third']),['m-third','z-first','a-second']);
  assert.deepEqual(order([]),['z-first','a-second','m-third']);
  assert.deepEqual(order(['deleted','a-second']),['a-second','z-first','m-third']);
  assert.deepEqual(profiles.map(profile=>profile.id),['z-first','a-second','m-third']);
});

test('持久保存按用户隔离，加载去重和无效值过滤，不保存模型或密钥内容',()=>{
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  saveModelPins('one',['newest','older'],storage);
  assert.deepEqual(loadModelPins('one',storage),['newest','older']);
  assert.deepEqual(loadModelPins('two',storage),[]);
  storage.setItem('shellpilot-model-pins-v1:one',JSON.stringify(['newest',null,'',7,'newest','older','x'.repeat(129)]));
  assert.deepEqual(loadModelPins('one',storage),['newest','older']);
  storage.setItem('shellpilot-model-pins-v1:one','not json');
  assert.deepEqual(loadModelPins('one',storage),[]);
});

test('读取失败仍可展示列表，保存失败交由界面报告而非伪装成功',()=>{
  const storage={getItem(){throw new Error('unavailable');},setItem(){throw new Error('unavailable');}};
  assert.deepEqual(loadModelPins('one',storage),[]);
  assert.throws(()=>saveModelPins('one',['id'],storage),/unavailable/);
});
