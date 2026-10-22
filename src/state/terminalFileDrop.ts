import type { DragDropEvent } from '@tauri-apps/api/webview';

/** Native drag positions are physical pixels. DOM hit-testing uses CSS pixels. */
export function handleTerminalFileDrop(event: DragDropEvent, surface: HTMLElement, options: {
  hit: (x: number, y: number) => Element | null;
  scale: number;
  hover: (active: boolean) => void;
  drop: (paths: string[]) => void;
}) {
  if (event.type === 'leave') { options.hover(false); return; }
  const scale = options.scale > 0 ? options.scale : 1;
  const node = options.hit(event.position.x / scale, event.position.y / scale);
  const inside = !!node && surface.contains(node);
  options.hover(event.type !== 'drop' && inside);
  if (event.type === 'drop' && inside && event.paths.length) options.drop(event.paths);
}
