import { useEffect, useId, useRef, useState } from 'react';
import type { AgentContextStatus as Status } from '../api/agentContext';
import { Icon } from './Ui';
import './AgentContextStatus.css';

const number = (value: number) => value.toLocaleString('zh-CN');
export type ManualCompactionControl = { run: () => void; cancel?: () => void; busy: boolean; disabled: boolean; reason?: string };
export function AgentContextStatus({ status, error, retry, manual }: { status: Status | null; error?: string; retry?: () => void; manual?: ManualCompactionControl }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const usage = status?.usage;
  const stale = !!usage && !!status?.usageStale;
  const percent = usage ? Math.round(usage.inputTokens / usage.availableInputTokens * 100) : null;
  const phase = status?.phase ?? 'idle';
  const label = phase === 'running' ? '正在压缩上下文' : phase === 'succeeded' ? '本次整理已保存'
    : phase === 'failed' ? (status?.fallback ? '整理失败 · 已回退原上下文' : '整理失败 · 原历史已保留')
      : phase === 'cancelled' ? '整理已取消' : phase === 'interrupted' ? '整理已中断' : '';
  const source = usage?.source === 'estimated' ? '估算' : '供应商计数';
  const valueLabel = percent === null ? '尚未测量' : `${percent}%${stale ? ' · 待更新' : percent > 100 ? ' · 超出容量' : ''}`;
  const level = error || !stale && percent !== null && percent > 100 ? 'error'
    : stale ? 'normal'
    : usage && percent !== null && percent >= usage.compactPercent ? 'warning' : 'normal';
  return <div ref={root} className={`agent-context-indicator level-${level}${percent === null ? ' is-unknown' : ''}${stale ? ' is-stale' : ''}`}
    onMouseEnter={() => setOpen(true)} onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); root.current?.querySelector('button')?.focus(); setOpen(false); } }}>
    <button type="button" className="agent-context-ring" aria-label={`上下文占用：${valueLabel}${usage ? `（${source}）` : ''}${stale ? '，上次统计，待重新计算' : ''}${error ? '，点击重试' : ''}`}
      aria-controls={open ? tooltipId : undefined} aria-haspopup="dialog" aria-expanded={open} onFocus={() => setOpen(true)}
      onClick={() => { setOpen(true); if (error) retry?.(); }}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle className="agent-context-ring-track" cx="12" cy="12" r="8" />
        {percent !== null && <circle className="agent-context-ring-value" cx="12" cy="12" r="8" pathLength="100"
          strokeDasharray="100" strokeDashoffset={100 - Math.max(0, Math.min(100, percent))} transform="rotate(-90 12 12)" />}
      </svg>
    </button>
    {open && <div id={tooltipId} className="agent-context-tooltip" role="dialog" aria-label="上下文详情">
      <div className="agent-context-tooltip-heading"><strong>上下文占用</strong><span>{valueLabel}</span></div>
      {usage ? <>
        {stale && <p className="agent-context-tooltip-stale" role="status">保留上次统计供参考，当前用量待重新计算；发送消息后更新。</p>}
        <p className="agent-context-tooltip-usage">{number(usage.inputTokens)} / {number(usage.availableInputTokens)} tokens · {source}</p>
        <p>{stale ? '上次模型窗口' : '模型窗口'} {number(usage.contextWindow)}，输出预留 {number(usage.outputReserve)}，安全预留 {number(usage.safetyReserve)}。</p>
        <p>整理触发比例 {usage.compactPercent}%。{usage.source === 'estimated' && '实际用量可能与估算不同。'}</p>
      </> : <p>发送消息后显示测量结果；尚未测量不代表占用为 0%。</p>}
      <div className="agent-context-tooltip-state"><span>{status ? `已整理 ${status.compactionCount} 次` : '尚无整理记录'}</span>{label && <span>{label}</span>}</div>
      {error && <p className="agent-context-tooltip-error">占用状态暂不可用，点击圆环重试。</p>}
      <p className="agent-context-tooltip-note">最近一次请求的输入快照，不包含未发送草稿或回复后的新增内容，也不是累计消耗。</p>
      {status?.updatedAt ? <small>记录时间：{new Date(status.updatedAt).toLocaleString()}</small> : null}
      {manual && <div className="agent-context-manual">
        <button type="button" className="agent-context-compact" disabled={manual.disabled || manual.busy || phase === 'running'} onClick={manual.run}>
          <Icon name="file" size={14}/><span>{manual.busy || phase === 'running' ? '正在压缩上下文…' : '立即压缩上下文'}</span>
        </button>
        {manual.busy && manual.cancel && <button type="button" className="agent-context-cancel" onClick={manual.cancel}>取消压缩</button>}
        <p>{manual.busy ? '正在整理已保存的历史，原始消息会保留。' : manual.reason || '生成历史检查点，保留原始消息；此操作会调用模型。'}</p>
      </div>}
    </div>}
  </div>;
}
