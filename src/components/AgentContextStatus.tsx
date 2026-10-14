import type { AgentContextStatus as Status } from '../api/agentContext';
import { Icon } from './Ui';
import './AgentContextStatus.css';

const number=(value:number)=>value.toLocaleString('zh-CN');
export function AgentContextStatus({status,error,retry}:{status:Status|null;error?:string;retry?:()=>void}) {
  const usage=status?.usage;
  const percent=usage?Math.round(usage.inputTokens/usage.availableInputTokens*100):null;
  const phase=status?.phase??'idle';
  const label=phase==='running'?'正在整理上下文':phase==='succeeded'?'本次整理已保存'
    :phase==='failed'?(status?.fallback?'整理失败 · 已回退原上下文':'整理失败 · 原历史已保留')
    :phase==='cancelled'?'整理已取消':phase==='interrupted'?'整理已中断':'';
  return <div className={'agent-context-status phase-'+phase} aria-label="上下文状态">
    <details className="agent-context-details">
      <summary><Icon name="signal" size={13}/><span>最近输入</span><strong>{percent===null?'未测量':percent>100?'超出容量':percent+'%'}</strong>
        {usage&&<span className="agent-context-source">{usage.source==='estimated'?'估算':'供应商计数'}</span>}</summary>
      <div className="agent-context-explanation">
        {usage?<><strong>{number(usage.inputTokens)} / {number(usage.availableInputTokens)} tokens</strong>
          <p>模型窗口 {number(usage.contextWindow)}，输出预留 {number(usage.outputReserve)}，安全预留 {number(usage.safetyReserve)}。</p>
          <p>整理触发比例 {usage.compactPercent}%。这是最近一次准备发送的输入快照，不包含当前草稿或回复后的新增内容，也不是累计 token 消耗。</p>
          {usage.source==='estimated'&&<p>按完整请求进行启发式估算，实际用量可能不同。</p>}
          {status?.updatedAt? <small>记录时间：{new Date(status.updatedAt).toLocaleString()}</small>:null}</>:<p>发送后显示测量结果；尚未测量时不显示为 0%。</p>}
      </div>
    </details>
    {usage&&<span className="agent-context-meter" role="progressbar" aria-label="最近输入占用可用容量" aria-valuenow={Math.min(100,percent!)} aria-valuemin={0} aria-valuemax={100}><i style={{width:Math.min(100,percent!)+'%'}}/></span>}
    <span className="agent-context-count">{status?'已整理 '+status.compactionCount+' 次':'发送后记录整理状态'}</span>
    {label&&<span className="agent-context-phase" role="status"><Icon name={phase==='running'?'refresh':phase==='succeeded'?'check':'alert'} size={12}/>{label}</span>}
    {error&&<span className="agent-context-error" role="status">占用暂不可用<button type="button" onClick={retry}>重试</button></span>}
  </div>;
}
