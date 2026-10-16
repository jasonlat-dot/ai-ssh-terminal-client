import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { agentApi } from '../api/agent';
import type { AgentProject, ProjectChat, ProjectChats } from '../api/agent';
import type { Host } from '../types';
import { Icon, Modal } from './Ui';
import { Select } from './Select';
import { historyPreviewPosition, historyPreviewTime } from '../state/historyPreview';

const PREVIEW_ROWS = 5;

function measureTitleOverflow(row:HTMLButtonElement) {
 const viewport=row.querySelector<HTMLElement>('.project-chat-title');
 const text=row.querySelector<HTMLElement>('.project-chat-title-text');
 if(!viewport||!text)return;
 const overflow=Math.max(0,text.scrollWidth-viewport.clientWidth);
 row.dataset.titleOverflow=overflow>1?'true':'false';
 row.style.setProperty('--history-title-shift',`${-overflow}px`);
 row.style.setProperty('--history-title-duration',`${Math.max(3,overflow/32+1.2)}s`);
}

export function ProjectChatHistory({hosts,project,sessionId,locked,revision,newChat,openChat,servers,projectsChanged,deleted,removed,approvalState,activeRunning,createRequest=0,creationFinished}:{
 hosts:Host[];project:AgentProject|null;sessionId:string;locked:boolean;revision:string;
 newChat:(project:AgentProject|null)=>void|Promise<void>;openChat:(chat:ProjectChat,project:AgentProject|null)=>void;servers:()=>void;
 projectsChanged?:(projects:AgentProject[])=>void;
 deleted?:(chat:ProjectChat)=>void;
 removed?:(project:AgentProject)=>void;
 approvalState?:{sessionId:string;pending:boolean};
 activeRunning?:boolean;
 createRequest?:number;creationFinished?:()=>void;
}) {
 const [projects,setProjects]=useState<AgentProject[]>([]);
 const [histories,setHistories]=useState<Record<string,ProjectChats>>({});
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(['']));
 const [visibleCounts,setVisibleCounts]=useState<Record<string,number>>({});
 const [renameTarget,setRenameTarget]=useState<ProjectChat|null>(null),[renameTitle,setRenameTitle]=useState(''),[renameError,setRenameError]=useState(''),[renaming,setRenaming]=useState(false);
 const renamePending=useRef(false);
 const [deleteTarget,setDeleteTarget]=useState<ProjectChat|null>(null);
 const [deleting,setDeleting]=useState(false);const [deleteError,setDeleteError]=useState('');
 const [removeTarget,setRemoveTarget]=useState<AgentProject|null>(null);
 const [removing,setRemoving]=useState(false);const [removeError,setRemoveError]=useState('');
 const [creating,setCreating]=useState(false);const [name,setName]=useState('');
 const [connection,setConnection]=useState('');const [saving,setSaving]=useState(false);
 const startCreate=()=>{if(locked)return;setConnection(hosts[0]?.id??'');setName('');setError('');setCreating(true);};
 const cancelCreate=()=>{if(saving)return;setCreating(false);creationFinished?.();};
 useEffect(()=>{if(createRequest)startCreate();},[createRequest]);
 const [reload,setReload]=useState(0);const version=useRef(0);const initialized=useRef(false);
 const previewId=useId();
 const [preview,setPreview]=useState<{chat:ProjectChat;project:AgentProject|null;anchor:HTMLElement;fontFamily:string}|null>(null);
 const [previewPosition,setPreviewPosition]=useState<{left:number;top:number}|null>(null);
 const previewCard=useRef<HTMLDivElement>(null);
 const previewTimers=useRef<{open?:number;close?:number}>({});
 const cancelPreviewTimers=()=>{
  window.clearTimeout(previewTimers.current.open);window.clearTimeout(previewTimers.current.close);
  previewTimers.current={};
 };
 const closePreview=()=>{cancelPreviewTimers();setPreview(null);setPreviewPosition(null);};
 const showPreview=(chat:ProjectChat,p:AgentProject|null,anchor:HTMLElement,immediate=false)=>{
  cancelPreviewTimers();
  if(preview?.anchor===anchor)return;
  const show=()=>{if(!anchor.isConnected)return;setPreviewPosition(null);setPreview({chat,project:p,anchor,fontFamily:window.getComputedStyle(anchor).fontFamily});};
  if(immediate||preview)show();else previewTimers.current.open=window.setTimeout(show,400);
 };
 const leavePreview=()=>{cancelPreviewTimers();previewTimers.current.close=window.setTimeout(closePreview,120);};
 useEffect(()=>{closePreview();},[revision,reload,creating,deleteTarget,removeTarget,renameTarget]);
 useEffect(()=>()=>cancelPreviewTimers(),[]);
 useLayoutEffect(()=>{
  if(!preview||!previewCard.current)return;
  const card=previewCard.current.getBoundingClientRect();
  setPreviewPosition(historyPreviewPosition(preview.anchor.getBoundingClientRect(),card,{width:window.innerWidth,height:window.innerHeight}));
 },[preview]);
 useEffect(()=>{
  const inside=(target:EventTarget|null)=>!!target&&'nodeType' in target&&!!previewCard.current?.contains(target as Node);
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')closePreview();};
  const pointer=(event:PointerEvent)=>{if(!inside(event.target))closePreview();};
  const scroll=(event:Event)=>{if(!inside(event.target))closePreview();};
  window.addEventListener('keydown',key);window.addEventListener('pointerdown',pointer);
  window.addEventListener('scroll',scroll,true);window.addEventListener('resize',closePreview);window.addEventListener('blur',closePreview);
  return()=>{window.removeEventListener('keydown',key);window.removeEventListener('pointerdown',pointer);
   window.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',closePreview);window.removeEventListener('blur',closePreview);};
 },[]);
 const previewTime=preview?historyPreviewTime(preview.chat.createdAt):null;
 const refresh=async()=>{
  const current=++version.current;setLoading(true);setError('');
  try {
   const list=await agentApi.projects();
   const keys=['',...list.map(item=>item.id)];
   const results=await Promise.all(keys.map(id=>agentApi.projectChats(id)));
   if(current!==version.current)return;
   if(!initialized.current){initialized.current=true;setExpanded(old=>new Set([...old,...list.map(p=>p.id)]));}
   setProjects(list);setHistories(Object.fromEntries(keys.map((id,index)=>[id,results[index]])));
   projectsChanged?.(list);
  }catch(cause){if(current===version.current)setError(cause instanceof Error?cause.message:'加载项目历史失败');}
  finally{if(current===version.current)setLoading(false);}
 };
 useEffect(()=>{void refresh();return()=>{version.current++;};},[revision,reload]);
 useEffect(()=>{if(project)setExpanded(previous=>new Set([...previous,project.id]));},[project?.id]);
 const more=async(id:string)=>{
  const page=histories[id];if(!page||loading)return;
  const count=visibleCounts[id]??PREVIEW_ROWS;
  if(count<page.items.length){setVisibleCounts(old=>({...old,[id]:count+PREVIEW_ROWS}));return;}
  if(!page.nextAfter)return;
  const current=version.current;setLoading(true);setError('');
  try{const next=await agentApi.projectChats(id,page.nextAfter);
   if(current===version.current){
    const items=[...new Map([...page.items,...next.items].map(chat=>[chat.sessionId,chat])).values()];
    setHistories(old=>({...old,[id]:{items,nextAfter:next.nextAfter}}));
    setVisibleCounts(old=>({...old,[id]:count+PREVIEW_ROWS}));
   }
  }catch(cause){if(current===version.current)setError(cause instanceof Error?cause.message:'加载历史失败');}
  finally{if(current===version.current)setLoading(false);}
 };
 const currentChats=new Map(Object.values(histories).flatMap(page=>page.items).map(chat=>[chat.sessionId,chat]));
 const isRunning=(chat:ProjectChat)=>chat.sessionId===sessionId&&activeRunning!==undefined?activeRunning:!!(currentChats.get(chat.sessionId)??chat).running;
 const rows=(p:AgentProject|null)=>{
  const id=p?.id??'',page=histories[id],items=page?.items??[],count=visibleCounts[id]??PREVIEW_ROWS;
  const activeIndex=items.findIndex(chat=>chat.sessionId===sessionId);
  // Keep a selected older conversation visible without expanding an entire project.
  const visible=activeIndex>=count
   ? [...items.slice(0,count-1),items[activeIndex]] : items.slice(0,count);
  return <div className="project-chat-list" id={'project-chats-'+(id||'general')}>
  {visible.map(chat=>{const awaiting=approvalState?.sessionId===chat.sessionId?approvalState.pending:!!chat.awaitingApproval;
   const running=isRunning(chat);
   return <div className="project-chat-entry" key={chat.sessionId}
    onPointerEnter={event=>{if(event.pointerType==='touch')return;const row=event.currentTarget.querySelector<HTMLButtonElement>('.project-chat-row');if(row)showPreview(chat,p,row);}}
    onPointerLeave={leavePreview}><button type="button"
   className={'project-chat-row '+(sessionId===chat.sessionId?'active':'')} disabled={locked}
   aria-current={sessionId===chat.sessionId?'page':undefined} aria-label={chat.title||'新对话'}
   aria-describedby={preview?.chat.sessionId===chat.sessionId?previewId:undefined}
   onPointerEnter={event=>measureTitleOverflow(event.currentTarget)} onFocus={event=>{measureTitleOverflow(event.currentTarget);showPreview(chat,p,event.currentTarget,true);}}
   onBlur={leavePreview} onClick={()=>{closePreview();openChat(chat,p);}}><span className="project-chat-title"><span className="project-chat-title-text">{chat.title||'新对话'}</span></span>{awaiting?<span className="project-chat-awaiting" role="status" aria-label="等待审批"><span>等待审批</span><i aria-hidden="true"/></span>:running?<span className="project-chat-running" role="status" aria-label="对话进行中"><i aria-hidden="true"/></span>:null}</button>
   <div className="project-chat-actions">
   <button type="button" className="project-chat-edit" aria-label={'修改对话标题：'+(chat.title||'新对话')} title="修改对话标题" disabled={locked||running||deleting||renaming}
    onClick={()=>{if(locked||isRunning(chat)||deleting||renaming)return;closePreview();setRenameError('');setRenameTitle(chat.title||'新对话');setRenameTarget(chat);}}><Icon name="edit" size={14}/></button>
   <button type="button" className="project-chat-delete" aria-label={'删除对话：'+(chat.title||'新对话')}
    title={locked||running?'对话进行中或正在切换，请稍后删除':'删除对话及聊天记录'} disabled={locked||running||deleting||renaming}
    onClick={()=>{if(locked||isRunning(chat)||deleting||renaming)return;setDeleteError('');setDeleteTarget(chat);}}><Icon name="trash" size={14}/></button>
   </div></div>;})}
  {!loading && !(histories[p?.id??'']?.items.length) && <p className="project-empty">暂无对话</p>}
  {(items.length>visible.length||page?.nextAfter||count>PREVIEW_ROWS)&&<div className="project-list-actions">
   {(items.length>visible.length||page?.nextAfter)&&<button type="button" className="project-more" disabled={loading}
    aria-label={'显示更多'+(p?.name??'未分组对话')+'记录'} aria-controls={'project-chats-'+(id||'general')} onClick={()=>void more(id)}><span>显示更多</span><Icon name="down" size={13}/></button>}
   {count>PREVIEW_ROWS&&<button type="button" className="project-more project-less"
    aria-label={'收起'+(p?.name??'未分组对话')+'记录'} aria-controls={'project-chats-'+(id||'general')} onClick={()=>setVisibleCounts(old=>({...old,[id]:PREVIEW_ROWS}))}><span>收起</span><Icon name="up" size={13}/></button>}
  </div>}
 </div>;};

 return <section className="agent-project-history" aria-label="项目聊天历史">
   {preview&&createPortal(<div ref={previewCard} id={previewId} role="tooltip" className="history-preview"
    style={{left:previewPosition?.left??0,top:previewPosition?.top??0,fontFamily:preview.fontFamily,visibility:previewPosition?'visible':'hidden'}}
    onPointerEnter={cancelPreviewTimers} onPointerLeave={leavePreview}>
    <div className="history-preview-heading"><strong>{preview.chat.title||'新对话'}</strong>
     {previewTime&&<time dateTime={previewTime.iso} title={previewTime.full} aria-label={previewTime.full}>{previewTime.label}</time>}</div>
    <div className="history-preview-project"><Icon name={preview.project?'folder':'history'} size={15}/><span>{preview.project?.name??'未分组对话'}</span></div>
   </div>,document.body)}
   <div className="project-history-toolbar">
    <button type="button" className="workspace-new-chat" disabled={locked} onClick={()=>newChat(null)}><Icon name="edit" size={16}/><span>新对话</span></button>
    <button type="button" className="project-toolbar-action" aria-label="新建项目" title="新建项目" disabled={locked} onClick={startCreate}><Icon name="folder" size={16}/><Icon name="plus" size={10}/></button>
    <button type="button" className="project-toolbar-action" aria-label="刷新项目与历史" title="刷新项目与历史" disabled={loading} onClick={()=>setReload(v=>v+1)}><Icon name="refresh" size={15}/></button>
   </div>
   <nav className="project-sidebar-scroll" aria-label="对话记录" aria-busy={loading}>
    {loading&&!projects.length&&<p className="project-empty">正在读取记录…</p>}
    {error&&<p role="alert" className="project-sidebar-error">{error}<button onClick={()=>setReload(v=>v+1)}>重试</button></p>}
    {projects.map(p=><section key={p.id} className={'agent-project '+(project?.id===p.id?'active':'')}>
     <div className="project-folder-row"><button type="button" className="project-disclosure" title={(expanded.has(p.id)?'收起':'展开')+p.name} aria-label={(expanded.has(p.id)?'收起':'展开')+p.name} aria-expanded={expanded.has(p.id)} aria-controls={'project-chats-'+p.id}
      onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(p.id))next.delete(p.id);else next.add(p.id);return next;})}><Icon name="folder" size={17} className="project-folder-icon"/><Icon name={expanded.has(p.id)?'down':'right'} size={13} className="project-folder-chevron"/></button>
      <button className="project-name" type="button" disabled={locked} title={p.name} onClick={()=>{const last=histories[p.id]?.items[0];if(last)openChat(last,p);else newChat(p);}}><span>{p.name}</span></button>
      <div className="project-folder-actions">
       <Select label={'项目选项：'+p.name} value="" displayValue="⋯" className="project-more-trigger" menuClassName="project-actions-menu" menuMinWidth={220} menuAlign="end"
        disabled={locked||deleting||removing||!!histories[p.id]?.items.some(chat=>chat.running)}
        options={[{value:'remove',label:'移除项目',description:'保留聊天记录，仅移除项目分组'}]}
        onChange={()=>{if(locked||deleting||removing||histories[p.id]?.items.some(chat=>chat.running))return;setRemoveError('');setRemoveTarget(p);}}/>
       <button type="button" className="project-add-chat" title={'在 '+p.name+' 新建对话'} aria-label={'在 '+p.name+' 新建对话'} disabled={locked||removing} onClick={()=>newChat(p)}><Icon name="chat" size={16}/></button>
      </div></div>
     {expanded.has(p.id)&&rows(p)}
    </section>)}
    <section className="agent-project project-general"><div className="project-folder-row">
     <button type="button" className="project-general-toggle" aria-expanded={expanded.has('')} aria-controls="project-chats-general" onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(''))next.delete('');else next.add('');return next;})}><Icon name="history" size={16}/><span>未分组对话</span><Icon name={expanded.has('')?'down':'right'} size={12}/></button>
    </div>{expanded.has('')&&rows(null)}</section>
   </nav>
  {removeTarget&&<Modal title="移除项目？" className="project-delete-dialog" dismissDisabled={removing} onClose={()=>setRemoveTarget(null)}>
   <p className="project-delete-title">{removeTarget.name}</p>
   <p>仅移除项目分组。已有聊天、命令记录和工具输出都会保留，可在“未分组对话”中继续查看。服务器配置和对话的服务器绑定不会改变。</p>
   {removeError&&<p role="alert" className="project-sidebar-error">{removeError}</p>}
   <footer><button type="button" disabled={removing} onClick={()=>setRemoveTarget(null)}>取消</button>
    <button type="button" className="project-confirm-delete" disabled={locked||removing||!!histories[removeTarget.id]?.items.some(chat=>chat.running)} onClick={()=>{
      if(locked||removing||histories[removeTarget.id]?.items.some(chat=>chat.running))return;
      const target=removeTarget;setRemoving(true);setRemoveError('');
      void agentApi.deleteProject(target.id).then(()=>{
        const next=projects.filter(item=>item.id!==target.id);
        setProjects(next);projectsChanged?.(next);setRemoveTarget(null);removed?.(target);setReload(value=>value+1);
      }).catch(cause=>setRemoveError(cause instanceof Error?cause.message:'移除项目失败，请重试。')).finally(()=>setRemoving(false));
    }}>{removing?'正在移除…':'移除项目'}</button></footer>
  </Modal>}
  {renameTarget&&<Modal title="修改对话标题" className="project-rename-dialog" dismissDisabled={renaming} onClose={()=>setRenameTarget(null)}>
   <form onSubmit={event=>{
    event.preventDefault();if(locked||isRunning(renameTarget)||renaming||renamePending.current)return;
    const title=renameTitle.trim();
    if(!title||[...title].length>80||/[\u0000-\u001f\u007f-\u009f]/.test(title)){setRenameError('标题需为 1–80 个字符，不能包含换行。');return;}
    const target=renameTarget;renamePending.current=true;setRenaming(true);setRenameError('');
    void agentApi.renameChat(target.agentId,target.sessionId,title).then(()=>{
      version.current++;setLoading(false);
      setHistories(old=>Object.fromEntries(Object.entries(old).map(([key,page])=>[key,{...page,items:page.items.map(chat=>chat.sessionId===target.sessionId?{...chat,title}:chat)}])));
      setRenameTarget(null);
    }).catch(cause=>setRenameError(cause instanceof Error?cause.message:'修改标题失败，请重试。')).finally(()=>{renamePending.current=false;setRenaming(false);});
   }}>
    <label>对话标题<input autoFocus aria-label="对话标题" value={renameTitle} maxLength={160} disabled={renaming} onChange={event=>setRenameTitle(event.target.value)}/></label>
    <p className="project-rename-hint">最多 80 个字符</p>
    {renameError&&<p role="alert" className="project-sidebar-error">{renameError}</p>}
    <footer><button type="button" className="outlined-button" disabled={renaming} onClick={()=>setRenameTarget(null)}>取消</button><button type="submit" className="primary-button" disabled={locked||isRunning(renameTarget)||renaming}>{renaming?'正在保存…':'保存'}</button></footer>
   </form>
  </Modal>}
  {deleteTarget&&<Modal title="删除对话？" className="project-delete-dialog" dismissDisabled={deleting} onClose={()=>setDeleteTarget(null)}>
   <p className="project-delete-title">{deleteTarget.title||'新对话'}</p>
   <p>这条对话的聊天内容、命令记录和工具输出将一并删除，无法恢复。</p>
   {deleteError&&<p role="alert" className="project-sidebar-error">{deleteError}</p>}
   <footer><button type="button" disabled={deleting} onClick={()=>setDeleteTarget(null)}>取消</button>
    <button type="button" className="project-confirm-delete" disabled={locked||isRunning(deleteTarget)||deleting} onClick={()=>{
      if(locked||isRunning(deleteTarget)||deleting)return;
      const target=deleteTarget;setDeleting(true);setDeleteError('');
      void agentApi.deleteChat(target.agentId,target.sessionId).then(()=>{
        setDeleteTarget(null);setReload(v=>v+1);deleted?.(target);
      }).catch(cause=>setDeleteError(cause instanceof Error?cause.message:'删除失败，请重试。')).finally(()=>setDeleting(false));
    }}>{deleting?'正在删除…':'删除对话'}</button></footer>
  </Modal>}
  {creating&&<Modal title="新建服务器项目" className="project-create-dialog" dismissDisabled={saving} onClose={cancelCreate}>
   <form className="project-create-form" onSubmit={event=>{event.preventDefault();if(saving||!connection||!name.trim())return;setSaving(true);setError('');
    void agentApi.createProject(name.trim(),connection).then(async p=>{setCreating(false);setReload(v=>v+1);await newChat(p);creationFinished?.();}).catch(cause=>setError(cause instanceof Error?cause.message:'新建项目失败')).finally(()=>setSaving(false));}}>
    <div className="project-create-fields">
     <label>项目名称<input autoFocus value={name} maxLength={100} onChange={event=>setName(event.target.value)} placeholder="例如：测试服务器"/></label>
     <label>已保存的服务器<Select label="项目服务器" value={connection} options={hosts.map(host=>({value:host.id,label:host.name+' · '+host.user+'@'+host.address}))} disabled={saving||!hosts.length} onChange={setConnection}/></label>
     <p className="project-create-hint">{!hosts.length?'请先在“管理服务器”中保存一台服务器。':'开始对话时自动连接此服务器，聊天记录按项目保存。'}</p>
    {error&&<p role="alert" className="project-sidebar-error">{error}</p>}
    </div>
    <footer className="project-create-footer"><button type="button" className="project-manage-servers" disabled={saving} onClick={()=>{cancelCreate();servers();}}><Icon name="server" size={15}/><span>管理服务器</span></button><button type="submit" className="project-create-submit" disabled={saving||!connection||!name.trim()}>{saving?'正在创建…':'创建并开始对话'}<Icon name="right" size={15}/></button></footer>
   </form>
  </Modal>}
 </section>;
}
