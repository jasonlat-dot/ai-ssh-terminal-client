import { useEffect, useRef, useState } from 'react';
import { agentApi } from '../api/agent';
import type { AgentProject, ProjectChat, ProjectChats } from '../api/agent';
import type { Host } from '../types';
import { Icon, Modal } from './Ui';
import { Select } from './Select';

export function ProjectChatHistory({hosts,project,sessionId,locked,revision,newChat,openChat,servers}:{
 hosts:Host[];project:AgentProject|null;sessionId:string;locked:boolean;revision:string;
 newChat:(project:AgentProject|null)=>void;openChat:(chat:ProjectChat,project:AgentProject|null)=>void;servers:()=>void;
}) {
 const [projects,setProjects]=useState<AgentProject[]>([]);
 const [histories,setHistories]=useState<Record<string,ProjectChats>>({});
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(['']));
 const [creating,setCreating]=useState(false);const [name,setName]=useState('');
 const [connection,setConnection]=useState('');const [saving,setSaving]=useState(false);
 const [reload,setReload]=useState(0);const version=useRef(0);const initialized=useRef(false);
 const refresh=async()=>{
  const current=++version.current;setLoading(true);setError('');
  try {
   const list=await agentApi.projects();
   const keys=['',...list.map(item=>item.id)];
   const results=await Promise.all(keys.map(id=>agentApi.projectChats(id)));
   if(current!==version.current)return;
   if(!initialized.current){initialized.current=true;setExpanded(old=>new Set([...old,...list.map(p=>p.id)]));}
   setProjects(list);setHistories(Object.fromEntries(keys.map((id,index)=>[id,results[index]])));
  }catch(cause){if(current===version.current)setError(cause instanceof Error?cause.message:'加载项目历史失败');}
  finally{if(current===version.current)setLoading(false);}
 };
 useEffect(()=>{void refresh();return()=>{version.current++;};},[revision,reload]);
 useEffect(()=>{if(project)setExpanded(previous=>new Set([...previous,project.id]));},[project?.id]);
 const more=async(id:string)=>{
  const page=histories[id];if(!page?.nextAfter||loading)return;
  const current=version.current;setLoading(true);
  try{const next=await agentApi.projectChats(id,page.nextAfter);
   if(current===version.current)setHistories(old=>({...old,[id]:{items:[...page.items,...next.items],nextAfter:next.nextAfter}}));
  }catch(cause){setError(cause instanceof Error?cause.message:'加载历史失败');}
  finally{if(current===version.current)setLoading(false);}
 };
 const rows=(p:AgentProject|null)=><div className="project-chat-list">
  {(histories[p?.id??'']?.items??[]).map(chat=><button type="button" key={chat.sessionId}
   className={'agent-history-item project-chat-row '+(sessionId===chat.sessionId?'active':'')} disabled={locked}
   aria-current={sessionId===chat.sessionId?'page':undefined} title={chat.title}
   onClick={()=>openChat(chat,p)}><Icon name="history" size={13}/><span>{chat.title||'新对话'}</span></button>)}
  {!loading && !(histories[p?.id??'']?.items.length) && <p className="project-empty">暂无对话</p>}
  {histories[p?.id??'']?.nextAfter && <button className="project-more" disabled={loading} onClick={()=>void more(p?.id??'')}>加载更多</button>}
 </div>;

 return <section className="agent-project-history" aria-label="项目聊天历史">
   <button type="button" className="workspace-new-chat" disabled={locked} onClick={()=>newChat(null)}><Icon name="edit" size={17}/>新对话</button>
   <div className="project-section-heading"><span>项目</span><button type="button" aria-label="新建项目" disabled={locked} onClick={()=>{setConnection(hosts[0]?.id??'');setName('');setCreating(true);}}><Icon name="plus" size={16}/></button><button type="button" aria-label="刷新项目与历史" disabled={loading} onClick={()=>setReload(v=>v+1)}><Icon name="refresh" size={14}/></button></div>
   <div className="project-sidebar-scroll">
    {loading&&!projects.length&&<p className="project-empty">正在读取记录…</p>}
    {error&&<p role="alert" className="project-sidebar-error">{error}<button onClick={()=>setReload(v=>v+1)}>重试</button></p>}
    {projects.map(p=><section key={p.id} className={'agent-project '+(project?.id===p.id?'active':'')}>
     <div className="project-folder-row"><button type="button" className="project-disclosure" aria-label={(expanded.has(p.id)?'收起':'展开')+p.name} aria-expanded={expanded.has(p.id)}
      onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(p.id))next.delete(p.id);else next.add(p.id);return next;})}><Icon name={expanded.has(p.id)?'down':'right'} size={12}/></button>
      <button className="project-name" type="button" disabled={locked} title={p.name} onClick={()=>{const last=histories[p.id]?.items[0];if(last)openChat(last,p);else newChat(p);}}><Icon name="folder" size={16}/><span>{p.name}</span></button>
      <button type="button" aria-label={'在 '+p.name+' 新建对话'} disabled={locked} onClick={()=>newChat(p)}><Icon name="plus" size={14}/></button></div>
     {expanded.has(p.id)&&rows(p)}
    </section>)}
    <div className="project-section-heading"><button type="button" aria-expanded={expanded.has('')} onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(''))next.delete('');else next.add('');return next;})}><Icon name={expanded.has('')?'down':'right'} size={12}/>普通对话</button></div>
    {expanded.has('')&&rows(null)}
   </div>
  {creating&&<Modal title="新建服务器项目" className="project-create-dialog" dismissDisabled={saving} onClose={()=>setCreating(false)}>
   <form onSubmit={event=>{event.preventDefault();if(saving||!connection||!name.trim())return;setSaving(true);setError('');
    void agentApi.createProject(name.trim(),connection).then(p=>{setCreating(false);setReload(v=>v+1);newChat(p);}).catch(cause=>setError(cause instanceof Error?cause.message:'新建项目失败')).finally(()=>setSaving(false));}}>
    <label>项目名称<input autoFocus value={name} maxLength={100} onChange={event=>setName(event.target.value)} placeholder="例如：测试服务器"/></label>
    <label>已保存的服务器<Select label="项目服务器" value={connection} options={hosts.map(host=>({value:host.id,label:host.name+' · '+host.user+'@'+host.address}))} disabled={saving||!hosts.length} onChange={setConnection}/></label>
    {!hosts.length&&<p>请先在“管理服务器”中保存一台服务器。</p>}
    <p>对话按项目保存。开始对话或打开历史时，自动连接该服务器并打开终端。</p>
    {error&&<p role="alert" className="project-sidebar-error">{error}</p>}
    <footer><button type="button" disabled={saving} onClick={()=>{setCreating(false);servers();}}>管理服务器</button><button type="submit" disabled={saving||!connection||!name.trim()}>{saving?'正在创建…':'创建并开始对话'}</button></footer>
   </form>
  </Modal>}
 </section>;
}
