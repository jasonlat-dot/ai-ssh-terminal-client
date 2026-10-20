import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { modelEndpointOptions, sameModelEndpoint } from '../state/modelEndpoints';
import { Icon } from './Ui';
import './ModelEndpointInput.css';

export function ModelEndpointInput({ id, value, placeholder, onChange, savedAddresses, disabled = false }: {
  id: string; value: string; placeholder: string; onChange: (value: string) => void;
  savedAddresses: readonly string[]; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), menu = useRef<HTMLDivElement>(null);
  const listId = `${id}-suggestions`;
  const options = modelEndpointOptions(placeholder, savedAddresses, filtering ? value : '');
  const choose = (index: number) => {
    const option = options[index];
    if (disabled || !option) return;
    onChange(option.source === 'default' ? '' : option.url);
    input.current?.focus({preventScroll: true});
    setOpen(false); setFiltering(false); setActive(-1);
  };
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const field = input.current;
    if (!field) return;
    const rect = field.getBoundingClientRect();
    const height = Math.min(290, options.length * 36 + (options.length > 1 ? 62 : 34));
    const below = window.innerHeight - rect.bottom - 14, above = rect.top - 14;
    const upward = below < height && above > below;
    const maxHeight = Math.max(36, Math.min(height, upward ? above : below));
    const width = Math.min(rect.width, window.innerWidth - 16);
    setPosition({width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, upward ? rect.top - maxHeight - 6 : rect.bottom + 6), maxHeight});
  }, [open, options.length]);
  useLayoutEffect(() => {
    if (!open || !position || active < 0) return;
    const list = menu.current, item = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [open, active, !!position]);
  useEffect(() => { setOpen(false); setActive(-1); }, [placeholder, disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', scroll, true); window.addEventListener('resize', close); window.addEventListener('blur', close);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); window.removeEventListener('blur', close); };
  }, [open]);
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Enter' && open) { event.preventDefault(); if (active >= 0) choose(active); else setOpen(false); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const down = event.key === 'ArrowDown';
    setActive(!open || active < 0 ? down ? 0 : options.length - 1 : (active + (down ? 1 : -1) + options.length) % options.length);
    setOpen(true);
  };
  return <div ref={root} className="model-endpoint-input">
    <input ref={input} id={id} name="shellpilot-model-endpoint" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false}
      className="settings-control settings-control-mono" role="combobox" aria-label="API 基础地址" aria-autocomplete="list" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      value={value} placeholder={placeholder} disabled={disabled} onFocus={() => { setFiltering(false); setActive(-1); setOpen(true); }}
      onClick={() => setOpen(true)} onChange={event => { onChange(event.target.value); setFiltering(true); setActive(-1); setOpen(true); }} onKeyDown={keyDown}
      onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node) && !menu.current?.contains(event.relatedTarget as Node)) setOpen(false); }}/>
    <button type="button" className="model-endpoint-toggle" aria-label="显示地址建议" disabled={disabled} aria-expanded={open}
      onMouseDown={event => event.preventDefault()} onClick={() => { input.current?.focus({preventScroll:true}); setFiltering(false); setActive(-1); setOpen(!open); }}><Icon name="down" size={13}/></button>
    {open && createPortal(<div ref={menu} id={listId} role="listbox" aria-label="API 地址建议" className="model-endpoint-menu"
      style={position ?? {visibility:'hidden'}} onMouseDown={event => event.preventDefault()}>
      <div className="model-endpoint-group" role="presentation"><span>官方默认</span><small>留空时使用</small></div>
      {options.map((option,index) => <div role="presentation" key={option.key}>
        {index === 1 && <div className="model-endpoint-group is-saved" role="presentation">已保存地址</div>}
        <button type="button" role="option" tabIndex={-1} id={`${listId}-${index}`} data-index={index} data-active={active === index || undefined}
          aria-selected={option.source === 'default' ? !value.trim() || sameModelEndpoint(value, placeholder) : sameModelEndpoint(value,option.url)}
          title={option.url} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
          <Icon name={option.source === 'default' ? 'shield' : 'network'} size={14}/><span>{option.url}</span>
          {(option.source === 'default' ? !value.trim() || sameModelEndpoint(value,placeholder) : sameModelEndpoint(value,option.url)) && <Icon name="check" size={13}/>}
        </button>
      </div>)}
    </div>, document.body)}
  </div>;
}
