import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Ui';
import './TerminalMenu.css';

type Target = { id: string; x: number; y: number; trigger: HTMLElement };
export type TerminalTabMenuTarget = Target;

export function TerminalTabContextMenu({ target, title, remote, close, create }: {
  target: Target; title: string; remote: boolean; close: () => void; create: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (box) setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - box.height - 8)) });
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [target]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [close]);
  return createPortal(<div ref={menu} className="terminal-command-menu terminal-tab-context-menu" role="menu"
    aria-label={`${title} 的终端操作`} style={position} data-no-window-drag
    onContextMenu={event => event.preventDefault()}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); if (target.trigger.isConnected) target.trigger.focus({ preventScroll: true }); }
      else if (event.key === 'Tab') close();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
    }}>
    <div className="terminal-menu-caption" title={title}>{title}</div>
    <button type="button" role="menuitem" title={remote ? '连接同一主机，打开独立的 SSH 会话' : '打开新的本地 CMD'}
      onClick={() => { close(); create(); }}><span><Icon name="plus" size={15} />新建终端</span></button>
  </div>, document.body);
}
