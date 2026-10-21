import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent } from 'react';
import { useTerminalActions } from './TerminalActionsContext';
import { Icon } from './Ui';
import './TerminalMenu.css';

export function TerminalMenu() {
  const store = useTerminalActions();
  const target = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const openedOwner = useRef<object | null>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const id = useId();
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const show = (last = false) => {
    openedOwner.current = target?.owner ?? null;
    initialFocus.current = last ? 'last' : 'first';
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(), box = menu.current?.getBoundingClientRect();
      if (!rect || !box) return;
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)),
        top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - box.height - 8)) });
    };
    place();
    const buttons = items();
    (initialFocus.current === 'last' ? buttons[buttons.length - 1] : buttons[0])?.focus();
    if (!buttons.length) menu.current?.focus();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (open && openedOwner.current !== (target?.owner ?? null)) close(true);
  }, [open, target?.owner]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const blur = () => close();
    window.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('blur', blur); };
  }, [open]);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = items(), index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <div className="terminal-app-menu" data-no-window-drag>
    <button ref={trigger} type="button" className="terminal-menu-trigger" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => open ? close(true) : show()}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); } }}>
      终端<Icon name="down" size={12} />
    </button>
    {open && createPortal(<div ref={menu} id={id} className="terminal-command-menu" role="menu" aria-label="终端操作" tabIndex={-1}
      style={position} onKeyDown={navigate} data-no-window-drag
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}>
      <div className="terminal-menu-caption" title={target?.title}>{target ? target.title : '未打开终端'}</div>
      {target ? (['clipboard', 'font', 'completion', 'connection'] as const).map(group => <div className="terminal-menu-group" role="group" key={group}
        aria-label={group === 'clipboard' ? '文本操作' : group === 'font' ? '字号' : group === 'completion' ? '智能补全' : '连接'}>
        {group === 'font' && <div className="terminal-menu-font"><span>终端字号 <small>{target.fontSize}px</small></span><kbd>Ctrl + 鼠标滚轮</kbd></div>}
        {target.commands.filter(command => command.group === group).map(command => <button type="button" role="menuitem" key={command.id}
          disabled={command.disabled} title={command.disabled ? command.reason : undefined} className={command.danger ? 'is-danger' : undefined}
          onClick={() => { close(); store.run(target.owner, command.id); }}>
          <span>{command.label}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}
        </button>)}
      </div>) : <p className="terminal-menu-empty">打开 SSH 或本地终端后可使用这些操作。</p>}
      <div className="terminal-menu-footnote">无选区时 Ctrl+C 中断</div>
    </div>, document.body)}
  </div>;
}
