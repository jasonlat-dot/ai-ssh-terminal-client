import { useEffect, useRef, useState } from 'react';
import { panelBounds, resizePanel, type PanelBounds } from '../state/panelResize';

type Props = {
  value: number; change: (value: number) => void; collapse: () => void; collapsed: boolean;
  unit?: 'percent' | 'pixels'; min?: number; max?: number; defaultValue?: number; minPixels?: number;
  reservePixels?: number; reserveSelector?: string; containerSelector?: string; className?: string; label?: string; controls?: string;
};
type Drag = { id: number; x: number; width: number; bounds: PanelBounds; node: HTMLDivElement };

export function PanelDivider({ value, change, collapse, collapsed, unit = 'percent', min = 18, max = 50,
  defaultValue = 22, minPixels = 0, reservePixels = 0, reserveSelector, containerSelector = '.app-shell',
  className = '', label = '调整工作区与智能体宽度', controls }: Props) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const boundsFor = (node: HTMLDivElement) => {
    const container = node.closest(containerSelector);
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const reserved = reserveSelector ? container.querySelector(reserveSelector)?.getBoundingClientRect() : null;
    return panelBounds(rect.width, unit, min, max, minPixels, reservePixels + (reserved ? Math.max(0, reserved.left - rect.left) : 0));
  };
  const release = () => {
    const active = drag.current; drag.current = null;
    if (active?.node.hasPointerCapture(active.id)) active.node.releasePointerCapture(active.id);
  };
  const finish = () => { release(); setDragging(false); };
  useEffect(() => () => release(), []);
  useEffect(() => { if (collapsed) finish(); }, [collapsed]);
  const update = (next: number, bounds: PanelBounds, allowCollapse = true) => {
    const result = resizePanel(next, bounds);
    if (!result) return;
    if (allowCollapse && result.collapsed) { finish(); collapse(); }
    else change(result.value);
  };
  return <div className={`panel-divider ${className} ${dragging ? 'dragging' : ''}`} role="separator" aria-label={label}
    aria-controls={controls} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={collapsed ? undefined : Math.round(value)}
    aria-hidden={collapsed} tabIndex={collapsed ? -1 : 0} title="拖动调整宽度，向右缩至最小宽度以下收起；双击恢复默认，方向键微调"
    onPointerDown={event => {
      if (collapsed || event.button !== 0 || drag.current) return;
      const bounds = boundsFor(event.currentTarget); if (!bounds) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width: Math.max(bounds.min, Math.min(bounds.max, value)), bounds, node: event.currentTarget };
      setDragging(true);
    }}
    onPointerMove={event => {
      const active = drag.current;
      if (active && active.id === event.pointerId) update(active.width + (active.x - event.clientX) / active.bounds.factor, active.bounds);
    }}
    onPointerUp={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onPointerCancel={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onDoubleClick={event => { if (!collapsed) { const bounds = boundsFor(event.currentTarget); if (bounds) update(defaultValue, bounds, false); } }}
    onKeyDown={event => {
      if (collapsed || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const bounds = boundsFor(event.currentTarget); if (!bounds) return;
      event.preventDefault();
      const current = Math.max(bounds.min, Math.min(bounds.max, value)), step = unit === 'pixels' ? 10 : 1;
      update(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : current + (event.key === 'ArrowLeft' ? step : -step), bounds);
    }}><span /></div>;
}
