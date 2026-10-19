import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Ui';
import './Select.css';

type SelectOption<T> = { value: T; label: string; description?: string };

/** 与表单输入框共用参数；弹层独立于滚动容器，支持键盘及屏幕阅读器。 */
export function Select<T extends string | number>({ id, value, options, onChange, disabled = false, className = '', label, displayValue, menuMinWidth = 0, menuClassName = '', menuAlign = 'start', renderIcon }: {
  id?: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
  displayValue?: string;
  menuMinWidth?: number;
  menuClassName?: string;
  menuAlign?: 'start' | 'end';
  renderIcon?: (value: T) => ReactNode;
}) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listId = `${triggerId}-options`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef({ text: '', at: 0 });
  const selectedIndex = options.findIndex(option => option.value === value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex));
  const [position, setPosition] = useState<CSSProperties | null>(null);

  const show = () => {
    if (disabled || !options.length) return;
    setActiveIndex(Math.max(0, selectedIndex));
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const desiredHeight = Math.min(280, options.length * 36 + 8);
      const placeAbove = below < desiredHeight && above > below;
      const maxHeight = Math.max(36, Math.min(280, placeAbove ? above : below));
      const width = Math.min(Math.max(rect.width, menuMinWidth), window.innerWidth - 16);
      setPosition({
        width,
        left: Math.max(8, Math.min(menuAlign === 'end' ? rect.right - width : rect.left, window.innerWidth - width - 8)),
        top: placeAbove ? rect.top - 6 - Math.min(desiredHeight, maxHeight) : rect.bottom + 6,
        maxHeight,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, options.length, menuMinWidth, menuAlign]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    const menu = menuRef.current;
    const option = menu?.children[activeIndex] as HTMLElement | undefined;
    if (!menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }, [open, activeIndex, !!position]);

  useEffect(() => {
    if (disabled || !options.length) setOpen(false);
  }, [disabled, options.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !options.length) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else show();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - searchRef.current.at < 800 ? searchRef.current.text : '') + event.key.toLowerCase();
      searchRef.current = { text, at: now };
      const index = options.findIndex(option => option.label.toLowerCase().startsWith(text));
      if (index >= 0) {
        event.preventDefault();
        show();
        setActiveIndex(index);
      }
    }
  };

  const optionLabel = (option: SelectOption<T> | undefined, override?: string) => {
    const text = override ?? option?.label ?? '请选择';
    return option && renderIcon ? <span className="ui-select-label-with-icon">{renderIcon(option.value)}<span>{text}</span></span> : text;
  };
  return <>
    <button ref={triggerRef} id={triggerId} type="button" role="combobox" className={`ui-select-trigger ${className}`}
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined} disabled={disabled || !options.length}
      onClick={() => open ? setOpen(false) : show()} onKeyDown={onKeyDown}
      onBlur={() => setOpen(false)}>
      <span>{optionLabel(options[selectedIndex], displayValue)}</span><Icon name="down" size={15} />
    </button>
    {open && createPortal(<div ref={menuRef} id={listId} className={`ui-select-menu ${menuClassName}`} role="listbox" aria-label={label}
      style={position ?? { visibility: 'hidden' }} onMouseDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option"
        aria-selected={option.value === value} className={`ui-select-option${index === activeIndex ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}`}
        onPointerMove={() => setActiveIndex(index)} onClick={() => choose(index)}>
        <span>{optionLabel(option)}</span>{option.description && <small className="ui-select-option-description">{option.description}</small>}{option.value === value && <Icon name="check" size={14} />}
      </div>)}
    </div>, document.body)}
  </>;
}
