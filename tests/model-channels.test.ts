import assert from 'node:assert/strict';
import test from 'node:test';
import {parseModelIds,groupModels} from '../src/state/modelChannels.ts';

test('渠道模型列表支持换行和中英文逗号，拒绝重复、空列表、过量和无效字符',()=>{
  assert.deepEqual(parseModelIds(' model-one\nmodel-two，model-three, vendor/model:variant\r\n'),['model-one','model-two','model-three','vendor/model:variant']);
  for(const input of ['', 'one\none','one, one','a\tb','x'.repeat(257),Array.from({length:65},(_,i)=>`m-${i}`).join('\n')])assert.throws(()=>parseModelIds(input));
});

test('选择器按稳定渠道 ID 分组，同名渠道和多个代理不串组，旧配置仍为独立渠道',()=>{
  const models=[{agentId:'one',agentName:'Proxy',modelName:'model-b',channelId:'proxy-1',agentDesc:''},{agentId:'two',agentName:'Proxy',modelName:'model-a',channelId:'proxy-1',agentDesc:''},
    {agentId:'three',agentName:'Proxy',modelName:'model-a',channelId:'proxy-2',agentDesc:''},{agentId:'legacy',agentName:'Legacy',agentDesc:''}];
  const groups=groupModels(models);assert.equal(groups.length,3);
  assert.deepEqual(groups.find(group=>group.id==='proxy-1')?.models.map(model=>model.agentId),['two','one']);
  assert.equal(groups.find(group=>group.id==='proxy-2')?.models.length,1);
  assert.equal(groups.find(group=>group.id==='legacy')?.models[0].agentId,'legacy');
  assert.equal(models[0].agentId,'one');
});
