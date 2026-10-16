import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProject } from '../api/agent';
import { Icon } from './Ui';
import './ComposerProjectPicker.css';

export function ComposerProjectPicker({project,projects,disabled,onChange,onCreate}:{
  project:AgentProject|null;projects:AgentProject[];disabled:boolean;onChange:(id:string)=>void;onCreate?:()=>void;
}) {
  const id=useId(), trigger=useRef<HTMLButtonElement>(null), menu=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false), [query,setQuery]=useState(''), [active,setActive]=useState(0);
  const [position,setPosition]=useState<CSSProperties>({visibility:'hidden'});
  const filtered=projects.filter(item=>`${item.name} ${item.identity?.host??item.profile?.host??''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close=(focus=false)=>{setOpen(false);if(focus)trigger.current?.focus({preventScroll:true});};
  const choose=(value:string)=>{if(disabled)return;onChange(value);close(true);};
  useEffect(()=>{if(disabled)close();},[disabled]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!trigger.current?.contains(event.target as Node)&&!menu.current?.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{
      const rect=trigger.current?.getBoundingClientRect();if(!rect)return;
      const above=rect.top-12,below=window.innerHeight-rect.bottom-12;
      const height=Math.min(320,88+Math.min(filtered.length,6)*36+(project?36:0));
      const up=below<height&&above>below,width=Math.min(280,window.innerWidth-16);
      setPosition({width,left:Math.max(8,Math.min(rect.left,window.innerWidth-width-8)),maxHeight:Math.max(80,Math.min(320,up?above:below)),...(up?{bottom:window.innerHeight-rect.top+6}:{top:rect.bottom+6})});
    };
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open,filtered.length,!!project]);
  useLayoutEffect(()=>{if(open)menu.current?.querySelector<HTMLElement>(`[data-project-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[open,active]);
  const keys=(event:KeyboardEvent)=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
    else if((event.key==='ArrowDown'||event.key==='ArrowUp')&&filtered.length){event.preventDefault();setActive(index=>(index+(event.key==='ArrowDown'?1:-1)+filtered.length)%filtered.length);}
    else if(event.key==='Enter'){event.preventDefault();if(filtered[active])choose(filtered[active].id);}
  };
  return <>
    <button ref={trigger} type="button" className={`composer-project-picker${project?'':' is-placeholder'}`} aria-label="选择项目" aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} disabled={disabled}
      onClick={()=>{if(open)close();else{setQuery('');setActive(Math.max(0,projects.findIndex(item=>item.id===project?.id)));setOpen(true);}}}
      onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setQuery('');setActive(0);setOpen(true);}}}>
      <Icon name="folder" size={15}/><span>{project?.name??'选择项目'}</span>
    </button>
    {open&&createPortal(<div ref={menu} id={id} className="composer-project-popover" role="dialog" aria-label="选择项目" style={position} onKeyDown={keys}
      onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node)&&!trigger.current?.contains(event.relatedTarget as Node))close();}}>
      <div className="composer-project-search"><Icon name="search" size={14}/><input autoFocus aria-label="搜索项目" placeholder="搜索项目" value={query} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={filtered[active]?`${id}-${active}`:undefined}
        onChange={event=>{setQuery(event.target.value);setActive(0);}}/></div>
      <div id={`${id}-list`} className="composer-project-results" role="listbox" aria-label="项目">
        {filtered.map((item,index)=><button type="button" key={item.id} id={`${id}-${index}`} data-project-index={index} role="option" aria-selected={item.id===project?.id} tabIndex={-1}
          className={`composer-project-option${index===active?' is-active':''}`} title={item.name} onPointerMove={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item.id)}>
          <Icon name="folder" size={15}/><span>{item.name}</span>{item.id===project?.id&&<Icon name="check" size={13}/>}</button>)}
        {!filtered.length&&<p className="composer-project-empty">{query.trim()?'没有匹配的项目':'暂无项目'}</p>}
      </div>
      {(project||onCreate)&&<div className="composer-project-footer">
        {project&&<button type="button" onClick={()=>choose('')}><Icon name="edit" size={15}/><span>不选择项目，继续文字对话</span></button>}
        {onCreate&&<button type="button" disabled={disabled} onClick={()=>{close(true);onCreate();}}><Icon name="plus" size={16}/><span>新建项目</span></button>}
      </div>}
    </div>,document.body)}
  </>;
}
