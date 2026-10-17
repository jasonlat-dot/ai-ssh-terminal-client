import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

const paths = {
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2z M7 8h10 M7 12h6',
  github: 'M9 19c-4.3 1.4-4.3-2.5-6-3 M15 22v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.2-1.5 6.2-6.9A5.4 5.4 0 0 0 18.8 5a5 5 0 0 0-.1-3.6S17.5 1 15 2.8a13.4 13.4 0 0 0-6 0C6.5 1 5.3 1.4 5.3 1.4A5 5 0 0 0 5.2 5a5.4 5.4 0 0 0-1.5 3.6c0 5.4 3.2 6.6 6.2 6.9A3.4 3.4 0 0 0 9 18.1V22',
  book: 'M12 5v16 M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1 M6 7h2 M16 7h2',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-8z',
  shield: 'm12 2 9 4v6c0 5-5 8-9 10-4-2-9-5-9-10V6z M7 12l3 3 7-7',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2z',
  key: 'M14 7a5 5 0 1 1-4 8L3 22H1v-4l7-7 M17 7h.01',
  alert: 'M12 3 22 20H2z M12 9v4 M12 17h.01',
  monitor: 'M3 4h18v13H3z M8 21h8 M12 17v4',
  palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.5H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9 M7 10h.01 M9 6.5h.01 M14 6.5h.01 M17 10h.01',
  type: 'M4 5h16 M12 5v15 M8 20h8 M4 5v3 M20 5v3',
  sun: 'M12 4V2 M12 22v-2 M4 12H2 M22 12h-2 M5.6 5.6 4.2 4.2 M18.4 18.4l-4.2-4.2 M18.4 5.6l-4.2 4.2 M5.6 18.4l4.2-4.2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5z',
  left: 'm15 6-6 6 6 6',
  sidebar: 'M4 5h16v14H4z M9 5v14 M12 9h5 M12 13h5',
  panelOpen: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 4v16 M13 9l3 3-3 3',
  panelClose: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 4v16 M16 9l-3 3 3 3',
  terminalWindow: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M3 8h18 M7 12l3 3-3 3 M13 17h4',
  workspace: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M3 9h18 M8 4v5 M7 13h4 M7 16h7',
  modelChip: 'M9 3v3 M15 3v3 M9 18v3 M15 18v3 M3 9h3 M3 15h3 M18 9h3 M18 15h3 M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M10 10h4v4h-4z',
  extensions: 'M9 3H5a2 2 0 0 0-2 2v4h2a3 3 0 1 1 0 6H3v4a2 2 0 0 0 2 2h4v-2a3 3 0 1 1 6 0v2h4a2 2 0 0 0 2-2v-4h-2a3 3 0 1 1 0-6h2V5a2 2 0 0 0-2-2h-4v2a3 3 0 1 1-6 0V3z',
  tabs: 'M3 8h14v12H3z M7 4h14v12 M7 12h6 M10 9v6',
  star: 'M7 5.5A2.5 2.5 0 0 1 9.5 3h5A2.5 2.5 0 0 1 17 5.5V21l-5-3.2L7 21z',
  edit: 'M13.5 5.5 18.5 10.5 M5 19l3.8-.8L20 6a2.1 2.1 0 0 0-3-3L5.8 15.2z M4 21h16',
  terminal: 'M4 5h16v14H4z M8 9l3 3-3 3 M13 15h3',
  folder: 'M3 7V5h6l2 3h10v12H3z',
  file: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h5',
  history: 'M3 11a9 9 0 1 1 2 7 M3 5v6h6 M12 7v6l4 2',
  settings: 'M4 7h4 M12 7h8 M10 4v6 M4 17h9 M17 17h3 M15 14v6',
  trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 14h8l1-14 M10 11v6 M14 11v6',
  power: 'M12 3v8 M6.3 6.8a8 8 0 1 0 11.4 0',
  plus: 'M12 4v16 M4 12h16',
  close: 'm6 6 12 12 M18 6 6 18',
  minimize: 'M5 12h14',
  maximize: 'M5 5h14v14H5z',
  aspectRatio: 'M8 5H3v5 M16 5h5v5 M3 14v5h5 M21 14v5h-5 M8 15l8-6 M8 11v4h4 M12 9h4v4',
  restore: 'M8 8h11v11H8z M5 16V5h11',
  down: 'm6 9 6 6 6-6',
  right: 'm9 6 6 6-6 6',
  up: 'm6 15 6-6 6 6',
  arrowUp: 'M12 20V4 M5 11l7-7 7 7',
  upRight: 'M7 17 17 7 M7 7h10v10',
  sparkles: 'm12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z M20 2v4 M18 4h4 M4 18v4 M2 20h4',
  fingerprint: 'M12 11a2 2 0 0 0-2 2c0 1-.1 2.5-.3 4 M14 13c0 3-.2 6-1 8 M8 16.5c-.2 1.2-.4 2.3-.6 3.5 M6 13a6 6 0 0 1 12 0c0 2-.2 5-1 7 M6 8a8 8 0 0 1 12 0 M4 16c.1-1 .1-2 .1-3a8 8 0 0 1 1-4 M20 16c.1-1 .1-2 .1-3a8 8 0 0 0-1-4',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6',
  refresh: 'M20 9a8 8 0 0 0-14-4L3 8 M3 3v5h5 M4 15a8 8 0 0 0 14 4l3-3 M16 16h5v5',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  image: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1 M3 16l5-5 5 5 3-3 5 5 M17 7a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
  copy: 'M8 8h12v13H8z M16 8V3H3v14h5',
  paste: 'M9 5H5v16h14V5h-4 M9 3h6v4H9z M8 12h8 M8 16h6',
  home: 'm3 10 9-7 9 7 M5 9v12h14V9 M9 21v-8h6v8',
  disk: 'm5 5-3 9v6h20v-6l-3-9z M2 14h20 M6 17h.01 M10 17h.01',
  box: 'm12 2 10 5v10l-10 5-10-5V7z M2 7l10 5 10-5 M12 12v10 M7 4.5l10 5',
  network: 'M8 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M22 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M22 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M8 6l8-1 M7 8l10 9',
  play: 'm7 4 14 8-14 8z',
  send: 'm3 3 18 9-18 9 3-9z M6 12h15',
  stop: 'M5 5h14v14H5z',
  bot: 'M5 7h14l2 3v9H3v-9z M12 3v4 M8 12v2 M16 12v2 M9 18h6',
  check: 'm5 12 4 4L19 6',
  bulb: 'M8 17c0-4-3-4-3-8a7 7 0 1 1 14 0c0 4-3 4-3 8z M9 21h6 M12 17v-5l3-3',
  attach: 'm8 14 8-8a3 3 0 0 1 4 4L9 21a5 5 0 0 1-7-7L14 2 M5 16 16 5',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  server: 'M3 4h18v6H3z M3 14h18v6H3z M6 7h.01 M6 17h.01',
  signal: 'M4 20v-4 M9 20v-8 M14 20V8 M19 20V3',
  database: 'M3 6c0-5 18-5 18 0s-18 5-18 0 M3 6v12c0 5 18 5 18 0V6 M3 12c0 5 18 5 18 0',
} as const;
export type IconName = keyof typeof paths;
export type AccentTone = 'blue' | 'violet' | 'cyan' | 'amber' | 'rose' | 'neutral' | 'success' | 'danger';

export function toneForIcon(icon: IconName): AccentTone {
  if (icon === 'bot' || icon === 'book') return 'violet';
  if (icon === 'network' || icon === 'server' || icon === 'database' || icon === 'disk') return 'cyan';
  if (icon === 'key' || icon === 'shield' || icon === 'folder' || icon === 'box' || icon === 'bolt' || icon === 'power') return 'amber';
  if (icon === 'file' || icon === 'attach') return 'rose';
  return 'blue';
}

export function fileTone(name: string): AccentTone {
  const type = name.toLowerCase();
  const isMime = type.includes('/');
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(type) || type.startsWith('image/')) return 'violet';
  if (/\.(mp[34]|wav|ogg|webm|mov)$/.test(type) || /^(audio|video)\//.test(type)) return 'rose';
  if (/\.(pdf|zip|gz|tar|7z|docx?)$/.test(type) || (isMime && /pdf|zip|word|compressed|x-tar/.test(type))) return 'amber';
  if (/\.(txt|md|json|csv|ya?ml|log|xlsx?)$/.test(type) || type.startsWith('text/') || (isMime && /json|sheet|excel|yaml/.test(type))) return 'cyan';
  return 'neutral';
}

export function Badge({ tone = 'neutral', icon, className = '', children, ...props }: HTMLAttributes<HTMLSpanElement> & {
  tone?: AccentTone;
  icon?: IconName;
}) {
  return <span className={`ui-badge ${className}`} data-accent={tone} {...props}>
    {icon && <Icon name={icon} size={11} />}{children}
  </span>;
}

export function AccentIcon({ icon, tone = toneForIcon(icon), size = 17, className = '' }: {
  icon: IconName;
  tone?: AccentTone;
  size?: number;
  className?: string;
}) {
  return <span className={`ui-accent-icon ${className}`} data-accent={tone} aria-hidden="true"><Icon name={icon} size={size} /></span>;
}
export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function IconButton({ icon, label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon name={icon} /></button>;
}
export function Toggle({ value, onChange, label, disabled, 'aria-describedby': describedBy }: {
  value: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; 'aria-describedby'?: string;
}) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} aria-describedby={describedBy} disabled={disabled}
    className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button>;
}
export function Modal({ title, onClose, children, wide = false, className = '', dismissDisabled = false, active = true }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string; dismissDisabled?: boolean; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = () => { if (active && !dismissDisabled) onClose(); };
  const id = useId();
  useEffect(() => {
    if (!active) return;
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
  }, [active]);
  return <div className={`modal-backdrop ${className ? `${className}-backdrop` : ''}`} inert={!active} aria-hidden={!active || undefined} onMouseDown={e => { if (e.target === e.currentTarget) closeRef.current(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal={active} aria-labelledby={id} className={`modal ${wide ? 'wide' : ''} ${className}`}><header><h2 id={id}>{title}</h2><IconButton icon="close" label="关闭弹窗" disabled={dismissDisabled} onClick={() => closeRef.current()} /></header>{children}</div></div>;
}
