import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const paths = {
  book: 'M12 5v16 M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1 M6 7h2 M16 7h2',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-8z',
  shield: 'm12 2 9 4v6c0 5-5 8-9 10-4-2-9-5-9-10V6z M7 12l3 3 7-7',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2z',
  key: 'M14 7a5 5 0 1 1-4 8L3 22H1v-4l7-7 M17 7h.01',
  panelOpen: 'M4 4h16v16H4z M4 15h16 M9 10l3-3 3 3',
  panelClose: 'M4 4h16v16H4z M4 15h16 M9 7l3 3 3-3',
  tabs: 'M3 8h14v12H3z M7 4h14v12 M7 12h6 M10 9v6',
  restore: 'M8 3v5H3 M16 3v5h5 M3 16h5v5 M21 16h-5v5',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
  edit: 'm14 5 5 5 M4 20l5-1L21 7l-5-5L4 14z',
  terminal: 'M4 5h16v14H4z M8 9l3 3-3 3 M13 15h3',
  folder: 'M3 7V5h6l2 3h10v12H3z',
  file: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h5',
  history: 'M3 11a9 9 0 1 1 2 7 M3 5v6h6 M12 7v6l4 2',
  settings: 'm9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  plus: 'M12 4v16 M4 12h16',
  close: 'm6 6 12 12 M18 6 6 18',
  down: 'm6 9 6 6 6-6',
  right: 'm9 6 6 6-6 6',
  up: 'm6 15 6-6 6 6',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6',
  refresh: 'M20 9a8 8 0 0 0-14-4L3 8 M3 3v5h5 M4 15a8 8 0 0 0 14 4l3-3 M16 16h5v5',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  copy: 'M8 8h12v13H8z M16 8V3H3v14h5',
  home: 'm3 10 9-7 9 7 M5 9v12h14V9 M9 21v-8h6v8',
  disk: 'm5 5-3 9v6h20v-6l-3-9z M2 14h20 M6 17h.01 M10 17h.01',
  box: 'm12 2 10 5v10l-10 5-10-5V7z M2 7l10 5 10-5 M12 12v10 M7 4.5l10 5',
  network: 'M8 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M22 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M22 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M8 6l8-1 M7 8l10 9',
  play: 'm7 4 14 8-14 8z',
  send: 'm3 3 18 9-18 9 3-9z M6 12h15',
  bot: 'M5 7h14l2 3v9H3v-9z M12 3v4 M8 12v2 M16 12v2 M9 18h6',
  check: 'm5 12 4 4L19 6',
  bulb: 'M8 17c0-4-3-4-3-8a7 7 0 1 1 14 0c0 4-3 4-3 8z M9 21h6 M12 17v-5l3-3',
  attach: 'm8 14 8-8a3 3 0 0 1 4 4L9 21a5 5 0 0 1-7-7L14 2 M5 16 16 5',
  split: 'M3 4h18v16H3z M12 4v16',
  maximize: 'M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  server: 'M3 4h18v6H3z M3 14h18v6H3z M6 7h.01 M6 17h.01',
  signal: 'M4 20v-4 M9 20v-8 M14 20V8 M19 20V3',
  database: 'M3 6c0-5 18-5 18 0s-18 5-18 0 M3 6v12c0 5 18 5 18 0V6 M3 12c0 5 18 5 18 0',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function IconButton({ icon, label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon name={icon} /></button>;
}
export function Toggle({ value, onChange, label }: { value: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button>;
}
export function Modal({ title, onClose, children, wide = false, className = '', dismissDisabled = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string; dismissDisabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = () => { if (!dismissDisabled) onClose(); };
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
    (panel?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select') ?? focusable()[0])?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) { event.preventDefault(); panel?.focus(); return; }
        if (!items.includes(document.activeElement as HTMLElement)) { event.preventDefault(); items[0]?.focus(); return; }
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus(); }
        else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return <div className={`modal-backdrop ${className ? `${className}-backdrop` : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) closeRef.current(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className={`modal ${wide ? 'wide' : ''} ${className}`}><header><h2 id={id}>{title}</h2><IconButton icon="close" label="关闭弹窗" disabled={dismissDisabled} onClick={onClose} /></header>{children}</div></div>;
}
