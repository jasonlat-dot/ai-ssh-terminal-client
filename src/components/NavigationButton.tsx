import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

export function NavigationButton({ collapsed, label, description, children, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  collapsed: boolean; label: string; description?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = () => { clearTimeout(timer.current); setOpen(false); setPosition(null); };
  const show = (delay: number) => {
    clearTimeout(timer.current);
    if (!collapsed) return;
    timer.current = setTimeout(() => { if (button.current?.isConnected) setOpen(true); }, delay);
  };
  useEffect(() => { close(); }, [collapsed]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !button.current || !tooltip.current) return;
    const anchor = button.current.getBoundingClientRect();
    const tip = tooltip.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(anchor.right + 10, window.innerWidth - tip.width - 8)),
      top: Math.max(8, Math.min(anchor.top + (anchor.height - tip.height) / 2, window.innerHeight - tip.height - 8)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);
  return <>
    <button {...props} ref={button} type="button" aria-label={label} aria-describedby={open && collapsed ? id : undefined}
      onPointerEnter={event => { if (event.pointerType !== 'touch') show(200); }} onPointerLeave={close}
      onFocus={() => show(0)} onBlur={close} onClick={event => { close(); onClick?.(event); }}>{children}</button>
    {open && collapsed && createPortal(<div id={id} ref={tooltip} role="tooltip" className="navigation-tooltip" style={position ?? { visibility: 'hidden' }}>
      <strong>{label}</strong>{description && <span>{description}</span>}
    </div>, document.body)}
  </>;
}
