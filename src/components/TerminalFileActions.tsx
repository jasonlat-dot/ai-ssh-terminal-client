import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Icon,Modal} from './Ui';
import type {IconName} from './Ui';
import './TerminalMenu.css';

export type FileMenuAction={label:string;icon:IconName;run:()=>void;disabled?:boolean;danger?:boolean};
export function TerminalFileContextMenu({x,y,caption,actions,close}:{x:number;y:number;caption:string;actions:FileMenuAction[];close:()=>void}){
  const ref=useRef<HTMLDivElement>(null),[position,setPosition]=useState({left:x,top:y});
  useLayoutEffect(()=>{
    const box=ref.current?.getBoundingClientRect();
    if(box)setPosition({left:Math.max(8,Math.min(x,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(y,window.innerHeight-box.height-8))});
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  },[x,y]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node))close();};
    const scroll=(event:Event)=>{if(!ref.current?.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',outside);window.addEventListener('blur',close);window.addEventListener('resize',close);window.addEventListener('scroll',scroll,true);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('blur',close);window.removeEventListener('resize',close);window.removeEventListener('scroll',scroll,true);};
  },[close]);
  return createPortal(<div ref={ref} role="menu" aria-label="文件操作" className="terminal-command-menu terminal-file-context-menu" style={position}
    onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
      if(event.key==='Escape'||event.key==='Tab'){event.stopPropagation();close();return;}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();
      const buttons=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();
    }}>
    <div className="terminal-menu-caption" title={caption}>{caption}</div>
    {actions.map(action=><button key={action.label} type="button" role="menuitem" className={action.danger?'is-danger':''} disabled={action.disabled} onClick={()=>{close();action.run();}}><span><Icon name={action.icon} size={14}/>{action.label}</span></button>)}
  </div>,document.body);
}

export function TerminalFileOperationDialog({kind,names,path,busy,error,close,confirm}:{kind:'rename'|'move'|'delete';names:string[];path:string;busy:boolean;error:string;close:()=>void;confirm:(value:string)=>void}){
  const [value,setValue]=useState(kind==='rename'?names[0]:path);
  const title=kind==='delete'?'删除选中项':kind==='rename'?'重命名':'移动到其他目录';
  return createPortal(<Modal title={title} icon={kind==='delete'?'trash':kind==='rename'?'edit':'folder'} onClose={close} dismissDisabled={busy} className="terminal-file-operation-dialog">
    <form onSubmit={event=>{event.preventDefault();confirm(value);}}>
      <p>服务器目录：<span className="terminal-file-operation-path">{path}</span></p>
      <ul>{names.map(name=><li key={name}>{name}</li>)}</ul>
      {kind==='delete'?<p className="terminal-file-delete-warning">将永久删除这 {names.length} 项，目录及其内部内容会一并删除，无法撤销。</p>:<label>{kind==='rename'?'新名称':'目标目录（绝对路径）'}<input autoFocus aria-label={kind==='rename'?'新名称':'目标目录'} value={value} onChange={event=>setValue(event.target.value)} disabled={busy} spellCheck={false}/><small>{kind==='move'?'保留原名称，目标目录必须已存在。同名条目不会被覆盖。':'同名条目不会被覆盖。'}</small></label>}
      {error&&<p role="alert" className="terminal-file-operation-error">{error}</p>}
      <footer><button type="button" data-autofocus={kind==='delete'||undefined} className="outlined-button" disabled={busy} onClick={close}>取消</button><button type="submit" className={kind==='delete'?'danger-button':'primary-button'} disabled={busy||(kind!=='delete'&&!value)}>{busy?'正在处理…':kind==='delete'?'确认删除':kind==='rename'?'保存名称':'确认移动'}</button></footer>
    </form>
  </Modal>,document.body);
}
