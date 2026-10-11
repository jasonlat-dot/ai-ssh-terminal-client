export type TerminalLayout = 'single' | 'columns' | 'rows' | 'grid';

export function layoutCapacity(layout: TerminalLayout) {
  return layout === 'single' ? 1 : layout === 'grid' ? 4 : 2;
}

/** Keep existing panes in place; close/new/tab selection never leaves stale or duplicate IDs. */
export function visibleTerminalIds(ids: readonly string[], activeId: string, layout: TerminalLayout, panes: readonly string[]) {
  if (layout === 'single') return ids.includes(activeId) ? [activeId] : ids.slice(0, 1);
  const capacity = layoutCapacity(layout);
  const visible = [...new Set(panes)].filter(id => ids.includes(id)).slice(0, capacity);
  if (ids.includes(activeId) && !visible.includes(activeId)) {
    if (visible.length >= capacity) visible[0] = activeId;
    else visible.unshift(activeId);
  }
  for (const id of ids) {
    if (visible.length >= capacity) break;
    if (!visible.includes(id)) visible.push(id);
  }
  return visible;
}

/** Selecting an already visible terminal focuses it; otherwise replace the focused pane. */
export function selectTerminalPane(panes: readonly string[], activeId: string, nextId: string) {
  if (panes.includes(nextId)) return [...panes];
  const index = panes.indexOf(activeId);
  if (index < 0) return [nextId, ...panes.slice(1)];
  return panes.map((id, i) => i === index ? nextId : id);
}

export function replaceTerminalPane(panes: readonly string[], targetId: string, nextId: string) {
  // Swapping is preferable to showing the same live terminal twice.
  return panes.map(id => id === targetId ? nextId : id === nextId ? targetId : id);
}

export function reorderTerminalSessions<T extends { id: string }>(sessions: T[], draggedId: string, targetId: string, after = false): T[] {
  if (draggedId === targetId) return sessions;
  const dragged = sessions.find(session => session.id === draggedId);
  if (!dragged || !sessions.some(session => session.id === targetId)) return sessions;
  const next = sessions.filter(session => session.id !== draggedId);
  next.splice(next.findIndex(session => session.id === targetId) + Number(after), 0, dragged);
  return next;
}
