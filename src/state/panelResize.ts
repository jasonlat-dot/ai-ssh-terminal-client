export type PanelBounds = { min: number; max: number; factor: number };

/** Widths stay nonzero when collapsed, so reopening restores the last usable width. */
export function panelBounds(containerWidth: number, unit: 'percent' | 'pixels', min: number, max: number,
  minPixels = 0, reservePixels = 0): PanelBounds | null {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return null;
  const factor = unit === 'percent' ? containerWidth / 100 : 1;
  const lower = Math.max(min, minPixels / factor);
  return { min: lower, max: Math.max(lower, Math.min(max, (containerWidth - reservePixels) / factor)), factor };
}
export function resizePanel(next: number, bounds: PanelBounds) {
  if (!Number.isFinite(next)) return null;
  return { collapsed: next < bounds.min, value: Math.max(bounds.min, Math.min(bounds.max, next)) };
}
