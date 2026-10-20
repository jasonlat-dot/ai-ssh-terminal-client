import type { AgentConfig } from '../api/agent';

export function parseModelIds(text:string):string[] {
  const ids=text.split(/[\r\n,，]+/).map(id=>id.trim()).filter(Boolean);
  if(!ids.length)throw new Error('请至少填写一个模型 ID。');
  if(ids.length>64)throw new Error('每个渠道最多配置 64 个模型。');
  if(new Set(ids).size!==ids.length)throw new Error('模型 ID 重复，请检查后再保存。');
  if(ids.some(id=>new TextEncoder().encode(id).length>256||/[\x00-\x1f\x7f]/.test(id)))throw new Error('模型 ID 过长或包含无效字符。');
  return ids;
}

export function groupModels(models:AgentConfig[]) {
  const groups=new Map<string,{id:string;label:string;provider:AgentConfig['provider'];supplier:AgentConfig['supplier'];models:AgentConfig[]}>();
  for(const model of models) {
    const id=model.channelId??model.agentId;
    if(!groups.has(id))groups.set(id,{id,label:model.agentName||'未命名渠道',provider:model.provider,supplier:model.supplier,models:[]});
    groups.get(id)!.models.push(model);
  }
  return [...groups.values()].sort((a,b)=>a.label.localeCompare(b.label)).map(group=>({...group,models:group.models.sort((a,b)=>(a.modelName??a.agentId).localeCompare(b.modelName??b.agentId))}));
}
