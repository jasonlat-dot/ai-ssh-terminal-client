import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Ui';

/** A history-style hint, including when the action is disabled before selection. */
export function TerminalSelectionHint({visible,disabled,description,onAdd}:{visible:boolean;disabled:boolean;description:string;onAdd:()=>void}) {
  const id=useId(),anchor=useRef<HTMLSpanElement>(null),card=useRef<HTMLDivElement>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState<{left:number;top:number;fontFamily:string}|null>(null);
  const cancel=()=>{clearTimeout(timer.current);timer.current=undefined;};
  const close=()=>{cancel();setOpen(false);setPosition(null);};
  const show=()=>{cancel();if(open)return;if(visible&&anchor.current?.isConnected){setPosition(null);setOpen(true);}};
  const leave=()=>{
    cancel();
    if(anchor.current?.contains(document.activeElement))return;
    timer.current=setTimeout(close,120);
  };
  useEffect(()=>{close();},[visible,disabled,description]);
  useEffect(()=>()=>{cancel();},[]);
  useLayoutEffect(()=>{
    if(!open||!anchor.current||!card.current)return;
    const rect=anchor.current.getBoundingClientRect(),box=card.current.getBoundingClientRect(),edge=12;
    const left=Math.max(edge,Math.min(rect.left,window.innerWidth-box.width-edge));
    const top=rect.bottom+8+box.height<=window.innerHeight-edge?rect.bottom+8:rect.top-box.height-8;
    setPosition({left,top:Math.max(edge,Math.min(top,window.innerHeight-box.height-edge)),fontFamily:window.getComputedStyle(anchor.current).fontFamily});
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};
    const outside=(event:PointerEvent)=>{if(!anchor.current?.contains(event.target as Node)&&!card.current?.contains(event.target as Node))close();};
    window.addEventListener('keydown',key);window.addEventListener('pointerdown',outside);
    window.addEventListener('resize',close);window.addEventListener('scroll',close,true);window.addEventListener('blur',close);
    return()=>{window.removeEventListener('keydown',key);window.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true);window.removeEventListener('blur',close);};
  },[open]);
  return <span ref={anchor} className="terminal-add-hint-anchor" tabIndex={disabled?0:undefined} aria-label={disabled?'添加到对话：暂不可用':undefined} aria-describedby={disabled&&open?id:undefined}
    onPointerEnter={event=>{if(event.pointerType==='touch')return;cancel();timer.current=setTimeout(show,400);}}
    onPointerLeave={leave} onFocusCapture={show} onBlurCapture={close}>
    <button type="button" className="terminal-add-to-agent" disabled={disabled} aria-describedby={open?id:undefined}
      onMouseDown={event=>event.preventDefault()} onClick={()=>{if(disabled)return;close();onAdd();}}><Icon name="bot" size={14}/>添加到对话</button>
    {open&&createPortal(<div ref={card} id={id} role="tooltip" className="terminal-selection-hint" style={position??{visibility:'hidden'}} onPointerEnter={cancel} onPointerLeave={leave}>
      <div className="terminal-selection-hint-heading"><Icon name="bot" size={16}/><strong>添加到对话</strong></div>
      <p>{description}</p><small>长文本会显示为文本卡片，由你确认后发送。</small>
    </div>,document.body)}
  </span>;
}
