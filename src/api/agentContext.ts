export type AgentContextUsage = {
  inputTokens:number; availableInputTokens:number; contextWindow:number; outputReserve:number;
  safetyReserve:number; compactPercent:number; source:'estimated'|'providerCount';
};
export type AgentContextStatus = {
  requestId:string; usage:AgentContextUsage|null;
  phase:'idle'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted';
  method:'summary'|'remote'|null; errorCode:string|null; fallback:boolean;
  checkpointId:string|null; compactionCount:number; updatedAt:number;
};
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
export function isAgentContextStatus(value:unknown):value is AgentContextStatus {
  if(!value||typeof value!=='object')return false;
  const v=value as AgentContextStatus;
  if(typeof v.requestId!=='string'||v.requestId.length>64||!['idle','running','succeeded','failed','cancelled','interrupted'].includes(v.phase)
    ||(v.method!==null&&!['summary','remote'].includes(v.method))||typeof v.fallback!=='boolean'
    ||(v.errorCode!==null&&(typeof v.errorCode!=='string'||!/^\w{1,64}$/.test(v.errorCode)))
    ||(v.checkpointId!==null&&(typeof v.checkpointId!=='string'||v.checkpointId.length>128))
    ||!integer(v.compactionCount)||!integer(v.updatedAt))return false;
  if(v.phase==='succeeded'&&(!v.checkpointId||v.compactionCount<1))return false;
  if(v.usage!==null){
    const u=v.usage;
    if(!u||typeof u!=='object'||![u.inputTokens,u.availableInputTokens,u.contextWindow,u.outputReserve,u.safetyReserve,u.compactPercent].every(integer)
      ||u.availableInputTokens<=0||u.availableInputTokens!==u.contextWindow-u.outputReserve-u.safetyReserve
      ||u.compactPercent<1||u.compactPercent>99||!['estimated','providerCount'].includes(u.source))return false;
  }
  return true;
}
