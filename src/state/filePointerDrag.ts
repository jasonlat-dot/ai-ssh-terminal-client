/** Internal drags use pointer events: WebView2's native OLE handler consumes HTML5 drags. */
export function beginFilePointerDrag(start: PointerEvent, source: HTMLElement, options: {
  document: Document;
  target: () => HTMLElement | null;
  hover: (active: boolean) => void;
  drop: () => void;
}): () => void {
  if (start.button !== 0 || start.pointerType === 'touch' || start.isPrimary === false) return () => {};
  const doc = options.document;
  let active = false, ended = false;
  const inside = (event: PointerEvent) => {
    const node = doc.elementFromPoint(event.clientX, event.clientY), target = options.target();
    return !!node && !!target && target.contains(node);
  };
  const finish = (event?: PointerEvent) => {
    if (ended) return;
    const upload = active && !!event && inside(event);
    ended = true;
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', up, true);
    doc.removeEventListener('pointercancel', cancel, true);
    doc.removeEventListener('keydown', key, true);
    doc.defaultView?.removeEventListener('blur', cancel);
    if (active) {
      try { source.releasePointerCapture(start.pointerId); } catch { /* Capture may have been released by WebView2. */ }
      doc.documentElement.classList.remove('file-pointer-dragging');
    }
    options.hover(false);
    if (upload) options.drop();
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    if (!active && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6) return;
    if (!active) {
      active = true;
      try { source.setPointerCapture(start.pointerId); } catch { /* Document listeners remain active without capture. */ }
      doc.documentElement.classList.add('file-pointer-dragging');
    }
    event.preventDefault();
    options.hover(inside(event));
  };
  const up = (event: PointerEvent) => { if (event.pointerId === start.pointerId) finish(event); };
  const cancel = () => finish();
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); finish(); } };
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('pointercancel', cancel, true);
  doc.addEventListener('keydown', key, true);
  doc.defaultView?.addEventListener('blur', cancel);
  return cancel;
}
