import { useState } from 'react';

export function PanelDivider({ value, change }: { value: number; change: (value: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const update = (next: number) => change(Math.max(18, Math.min(50, next)));
  return <div className={`panel-divider ${dragging ? 'dragging' : ''}`} role="separator" aria-label="调整工作区与智能体宽度" aria-orientation="vertical" aria-valuemin={18} aria-valuemax={50} aria-valuenow={Math.round(value)} tabIndex={0} title="拖动调整宽度，双击恢复默认；方向键微调"
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
    onPointerMove={e => { if (!dragging) return; const rect = e.currentTarget.parentElement!.getBoundingClientRect(); update((rect.right - e.clientX) / rect.width * 100); }}
    onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false); }}
    onPointerCancel={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}
    onDoubleClick={() => update(22)} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); update(e.key === 'Home' ? 18 : e.key === 'End' ? 50 : value + (e.key === 'ArrowLeft' ? 1 : -1)); } }}><span /></div>;
}
