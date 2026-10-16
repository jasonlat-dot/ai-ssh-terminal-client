import { useEffect, useRef, useState } from 'react';
import { panelBounds, resizePanel, type PanelBounds } from '../state/panelResize';

type Props = {
  value: number; change: (value: number) => void; collapse: () => void; collapsed: boolean;
  unit?: 'percent' | 'pixels'; min?: number; max?: number; defaultValue?: number; minPixels?: number;
  reservePixels?: number; reserveSelector?: string; containerSelector?: string; className?: string; label?: string; controls?: string; collapseLabel?: string;
  side?: 'left' | 'right'; reserveWidthSelectors?: string;
  collapseOpposite?: () => void; oppositeCollapseLabel?: string;
};
type CollapseEdge = 'min' | 'max' | null;
type Drag = { id: number; x: number; width: number; bounds: PanelBounds; node: HTMLDivElement; pendingCollapse: CollapseEdge };

export function PanelDivider({ value, change, collapse, collapsed, unit = 'percent', min = 18, max = 50,
  defaultValue = 22, minPixels = 0, reservePixels = 0, reserveSelector, containerSelector = '.app-shell',
  className = '', label = '调整工作区与智能体宽度', controls, collapseLabel = '智能体对话', side = 'right', reserveWidthSelectors,
  collapseOpposite, oppositeCollapseLabel = '另一侧面板' }: Props) {
  const [dragging, setDragging] = useState(false);
  const [collapsePending, setCollapsePending] = useState<CollapseEdge>(null);
  const drag = useRef<Drag | null>(null);
  const direction = side === 'left' ? 1 : -1;
  const collapseDirection = side === 'left' ? '左' : '右';
  const cancelDirection = side === 'left' ? '右' : '左';
  const pendingLabel = collapsePending === 'max' ? oppositeCollapseLabel : collapseLabel;
  const pendingCancelDirection = collapsePending === 'max' ? collapseDirection : cancelDirection;
  const boundsFor = (node: HTMLDivElement) => {
    const container = node.closest(containerSelector);
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const reserved = reserveSelector ? container.querySelector(reserveSelector)?.getBoundingClientRect() : null;
    const reservedWidths = reserveWidthSelectors ? Array.from(container.querySelectorAll(reserveWidthSelectors))
      .reduce((sum, panel) => sum + panel.getBoundingClientRect().width, 0) : 0;
    return panelBounds(rect.width, unit, min, max, minPixels, reservePixels + reservedWidths + (reserved ? Math.max(0, reserved.left - rect.left) : 0));
  };
  const release = () => {
    const active = drag.current; drag.current = null;
    if (active?.node.hasPointerCapture(active.id)) active.node.releasePointerCapture(active.id);
  };
  const finish = () => { release(); setDragging(false); setCollapsePending(null); };
  useEffect(() => () => release(), []);
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => window.removeEventListener('blur', finish);
  }, []);
  useEffect(() => { if (collapsed) finish(); }, [collapsed]);
  const update = (next: number, bounds: PanelBounds, allowCollapse = true) => {
    const result = resizePanel(next, bounds);
    if (!result) return;
    if (allowCollapse && result.collapsed) { finish(); collapse(); }
    else change(result.value);
  };
  const preview = (active: Drag, x: number) => {
    const next = active.width + (x - active.x) * direction / active.bounds.factor;
    const result = resizePanel(next, active.bounds);
    if (!result) return;
    // Keep the panel at its minimum width while the pointer is in the collapse zone.
    // Commit collapse only on pointer-up; moving back, Escape or cancellation discards it.
    // A 32px overdrag beyond the maximum makes collapsing the other side deliberate.
    active.pendingCollapse = result.collapsed ? 'min'
      : collapseOpposite && (next - active.bounds.max) * active.bounds.factor > 32 ? 'max' : null;
    setCollapsePending(active.pendingCollapse);
    change(result.value);
  };
  return <div className={`panel-divider ${className} ${dragging ? 'dragging' : ''} ${collapsePending ? 'collapse-pending' : ''}`} role="separator" aria-label={label}
    data-side={side}
    aria-controls={controls} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={collapsed ? undefined : Math.round(value)}
    aria-valuetext={collapsePending ? `松开鼠标收起${pendingLabel}，向${pendingCancelDirection}拖回可取消` : undefined}
    aria-hidden={collapsed} tabIndex={collapsed ? -1 : 0} title={`拖动调整宽度，向${collapseDirection}缩至最小宽度以下后松开收起${collapseLabel}${collapseOpposite ? `；向${cancelDirection}继续拖过最大宽度后松开收起${oppositeCollapseLabel}` : ''}；双击恢复默认，方向键微调`}
    onPointerDown={event => {
      if (collapsed || event.button !== 0 || event.isPrimary === false || drag.current) return;
      const bounds = boundsFor(event.currentTarget); if (!bounds) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width: Math.max(bounds.min, Math.min(bounds.max, value)), bounds, node: event.currentTarget, pendingCollapse: null };
      setDragging(true);
    }}
    onPointerMove={event => {
      const active = drag.current;
      if (active && active.id === event.pointerId) preview(active, event.clientX);
    }}
    onPointerUp={event => {
      const active = drag.current;
      if (!active || active.id !== event.pointerId) return;
      preview(active, event.clientX);
      const shouldCollapse = active.pendingCollapse;
      finish();
      if (shouldCollapse === 'min') collapse();
      else if (shouldCollapse === 'max') collapseOpposite?.();
    }}
    onPointerCancel={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onDoubleClick={event => { if (!collapsed) { const bounds = boundsFor(event.currentTarget); if (bounds) update(defaultValue, bounds, false); } }}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); finish(); return; }
      if (collapsed || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const bounds = boundsFor(event.currentTarget); if (!bounds) return;
      event.preventDefault();
      finish();
      const current = Math.max(bounds.min, Math.min(bounds.max, value)), step = unit === 'pixels' ? 10 : 1;
      update(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : current + (event.key === 'ArrowRight' ? step : -step) * direction, bounds);
    }}><span />{collapsePending && <div className="panel-collapse-hint" role="status">
      <strong>松开鼠标收起{pendingLabel}</strong><small>向{pendingCancelDirection}拖回可取消 · Esc 取消</small>
    </div>}</div>;
}
