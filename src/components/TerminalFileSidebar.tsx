import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {createPortal} from 'react-dom';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import {isTauriRuntime} from '../state/runtime';
import {handleTerminalFileDrop} from '../state/terminalFileDrop';
import { sftpApi } from '../api/sftp';
import { notify } from '../state/notifications';
import { createSidebarTransfer,createSidebarUpload,terminalUploadMatches } from '../state/terminalUpload';
import type { TerminalTransferRequest,TerminalUploadRequest } from '../state/terminalUpload';
import type { TerminalRuntime } from '../state/terminalRuntime';
import type { DirectoryListing, TerminalDirectory } from '../state/terminalDirectory';
import { directoryChild, directoryParent, readDirectoryFollow, saveDirectoryFollow } from '../state/terminalDirectory';
import { resourceBytes } from '../state/terminalResources';
import { fileOperationJobs, fileSelection, runSidebarFileOperation } from '../state/terminalFileOperations';
import { TerminalFileContextMenu, TerminalFileOperationDialog } from './TerminalFileActions';
import {TerminalUploadConfirm} from './TerminalUploadConfirm';
import type { FileMenuAction } from './TerminalFileActions';
import { Icon, IconButton } from './Ui';
import './TerminalFileSidebar.css';

const emptyDirectory: TerminalDirectory = { path: '', revision: 0 };
const noSubscribe = () => () => {};
const noDirectory = () => emptyDirectory;
type FileLocation = { owner: TerminalRuntime; path: string; requestedPath: string; scope: string };
type FileTarget = FileLocation & {names:string[]};

/** A terminal owns its directory signal. The browser never writes commands into its shell. */
export function TerminalFileSidebar({ runtime, terminalId, title, local, connected, visible, openFiles, transfer, copy }: {
  runtime?: TerminalRuntime; terminalId: string; title?: string; local: boolean; connected: boolean; visible: boolean;
  transfer: (request: TerminalTransferRequest) => void;
  openFiles: () => void; copy: (path: string) => Promise<void>;
}) {
  const directory = useSyncExternalStore(runtime?.subscribeDirectory ?? noSubscribe, runtime?.directorySnapshot ?? noDirectory);
  const [follow, setFollow] = useState(readDirectoryFollow);
  const [manualPath, setManualPath] = useState('');
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef('');
  const surface=useRef<HTMLElement>(null);
  const [dragActive,setDragActive]=useState(false);
  const [pendingUpload,setPendingUpload]=useState<(FileLocation&{request:TerminalUploadRequest})|null>(null);
  const confirmedUpload=useRef('');
  const [menu, setMenu] = useState<(FileTarget & {x:number;y:number}) | null>(null);
  const [operation, setOperation] = useState<(FileTarget & {kind:'rename'|'move'|'delete'}) | null>(null);
  const [mutating, setMutating] = useState(false);
  const mutationLock = useRef(false);
  const [operationError, setOperationError] = useState('');
  const [showHidden, setShowHidden] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [revision, refresh] = useState(0);
  const [page, setPage] = useState<{ listing: DirectoryListing | null; loading: boolean; error: string; scope?: string; requestedPath?:string }>({ listing: null, loading: false, error: '' });
  const enabled = !!runtime?.directoryList && !local && connected && visible && pageVisible;
  const path = follow ? directory.path : manualPath;
  const promptRevision = follow ? directory.revision : 0;
  const scope = directory.accessKey || '';
  const [choosing, setChoosing] = useState(false);
  const alive = useRef(false), choosingLock = useRef(false);
  const transferState = useRef({ runtime, path, scope, selected, enabled,listingPath:page.listing?.path,listingRequestedPath:page.requestedPath,listingScope:page.scope });
  transferState.current = { runtime, path, scope, selected, enabled,listingPath:page.listing?.path,listingRequestedPath:page.requestedPath,listingScope:page.scope };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelected([]); anchor.current=''; setMenu(null); setOperation(null); setOperationError(''); }, [runtime, enabled, path, scope]);
  useEffect(()=>{setDragActive(false);},[runtime,enabled,path,scope]);
  useEffect(()=>{if(!visible||!connected||local)setPendingUpload(null);},[visible,connected,local]);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!enabled || !runtime?.directoryList) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    let busy = false;
    const cancel = () => { clearTimeout(timer); controller?.abort(); };
    const load = async () => {
      if (disposed || document.hidden || busy) return;
      busy = true; controller = new AbortController();
      setPage(previous => ({ ...previous, loading: true, error: '' }));
      try {
        const listing = await runtime.directoryList!(path, controller.signal);
        if (!disposed && !controller.signal.aborted) {
          setPage({ listing, loading: false, error: '', scope,requestedPath:path });
          const names=new Set(listing.entries.map(entry=>entry.name));
          setSelected(current=>current.filter(name=>names.has(name)));
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setPage({ listing: null, loading: false,
          error: error instanceof Error ? error.message : '无法读取目录，请检查连接和权限。', scope,requestedPath:path });
      } finally {
        busy = false;
        if (!disposed && !document.hidden) timer = setTimeout(load, 5000);
      }
    };
    setPage(previous => ({ listing: previous.scope === scope && previous.requestedPath === path ? previous.listing : null, loading: true, error: '', scope,requestedPath:path }));
    // Merge successive prompt notifications before requesting an SFTP channel.
    timer = setTimeout(load, 150);
    return () => { disposed = true; cancel(); };
  }, [enabled, runtime, path, follow, promptRevision, revision, scope]);
  useEffect(() => { setInput(page.listing?.path || path); }, [page.listing?.path, path]);

  const changeFollow = (value: boolean) => {
    if (!value) setManualPath(page.listing?.path || directory.path);
    setFollow(value); saveDirectoryFollow(value); setSelected([]); setMenu(null); setOperation(null);
  };
  const browse = (target: string) => {
    if (!target.startsWith('/') || /[\x00-\x1f\x7f]/.test(target)) return;
    setFollow(false); saveDirectoryFollow(false); setManualPath(target); setSelected([]); setMenu(null); setOperation(null); refresh(value => value + 1);
  };
  const entries = page.listing?.entries.filter(entry => showHidden || !entry.name.startsWith('.')) ?? [];
  const unavailable = !runtime || local;
  const selectedEntries = entries.filter(entry => selected.includes(entry.name));
  const downloadEntries = selectedEntries.filter(entry => !entry.symlink);
  const listingCurrent=!!page.listing&&page.scope===scope&&page.requestedPath===path;
  const canTransfer = enabled && !page.loading && !page.error && listingCurrent
    && directory.access !== 'unavailable' && !choosing && !mutating && !pendingUpload;
  const canDownload = downloadEntries.length>0 && downloadEntries.length===selectedEntries.length;
  const targetValid = (target:FileLocation) => {
    const current=transferState.current;
    return alive.current && current.runtime===target.owner && current.enabled && current.scope===target.scope
      && current.path===target.requestedPath && (target.owner.directorySnapshot?.().accessKey||'')===target.scope
      && target.owner.directorySnapshot?.().access!=='unavailable';
  };
  const canDrop=enabled&&listingCurrent&&!page.error&&directory.access!=='unavailable'&&!choosing&&!mutating&&!menu&&!operation&&!pendingUpload;
  const dropState=useRef({canDrop,drop:(_paths:string[])=>{}});
  dropState.current={canDrop,drop:paths=>{
    if(!canDrop||!runtime||!page.listing)return;
    try{
      const request=createSidebarUpload(runtime,terminalId,title||'终端文件',page.listing.path,paths);
      setPendingUpload({owner:runtime,path:page.listing.path,requestedPath:path,scope,request});setMenu(null);setDragActive(false);
    }catch(error){notify(error instanceof Error?error.message:'无法读取上传目标。','error');}
  }};
  useEffect(()=>{
    if(!enabled||!isTauriRuntime())return;
    let disposed=false,unlisten:(()=>void)|undefined;
    void getCurrentWebview().onDragDropEvent(event=>{
      if(disposed||!surface.current)return;
      if(!dropState.current.canDrop){setDragActive(false);return;}
      handleTerminalFileDrop(event.payload,surface.current,{hit:(x,y)=>document.elementFromPoint(x,y),scale:window.devicePixelRatio,
        hover:setDragActive,drop:paths=>dropState.current.drop(paths)});
    }).then(stop=>{if(disposed)stop();else unlisten=stop;}).catch(()=>{if(!disposed)setDragActive(false);});
    return()=>{disposed=true;unlisten?.();setDragActive(false);};
  },[enabled,runtime]);
  const confirmDroppedUpload=()=>{
    if(!pendingUpload||confirmedUpload.current===pendingUpload.request.id)return;
    const pending=pendingUpload;confirmedUpload.current=pending.request.id;setPendingUpload(null);
    const current=transferState.current;
    if(!targetValid(pending)||current.listingPath!==pending.path||current.listingScope!==pending.scope||current.listingRequestedPath!==pending.requestedPath
      ||!terminalUploadMatches(current.runtime,pending.request)){
      notify('侧栏目录、终端连接或访问身份已变化，请重新拖入文件确认上传位置。','error');return;
    }
    transfer(pending.request);
  };
  const startOperation=(target:FileTarget,kind:'rename'|'move'|'delete')=>{setOperation({...target,kind});setOperationError('');};
  const confirmOperation=async(value:string)=>{
    if(!operation||mutationLock.current)return;
    const target=operation, request={kind:target.kind,names:target.names,path:target.path,value};
    try{fileOperationJobs(request);}catch(error){setOperationError(error instanceof Error?error.message:'输入无效');return;}
    mutationLock.current=true;setMutating(true);setOperationError('');
    try{
      const count=await runSidebarFileOperation(target.owner,request,()=>targetValid(target));
      if(alive.current){setOperation(null);setSelected([]);notify(`已${target.kind==='delete'?'删除':target.kind==='rename'?'重命名':'移动'} ${count} 项。`,'success');}
    }catch(error){if(alive.current){const message=error instanceof Error?error.message:'文件操作失败。';setOperationError(message);notify(message,'error');}}
    finally{mutationLock.current=false;if(alive.current){setMutating(false);refresh(value=>value+1);}}
  };
  const chooseTransfer = async (download: boolean) => {
    if (!canTransfer || !runtime || !page.listing || choosingLock.current || (download && !canDownload)) return;
    choosingLock.current = true; setChoosing(true);
    const source = transferState.current, owner = runtime, destination = page.listing.path;
    const remoteName = download ? downloadEntries.map(entry=>entry.name) : undefined;
    const snapshot = owner.directorySnapshot?.();
    try {
      const paths = await sftpApi.pickLocal(download);
      if (!paths.length || !alive.current) return;
      const current = transferState.current;
      if (current.runtime !== owner || !current.enabled || current.scope !== source.scope || current.path !== source.path
        || (download && JSON.stringify(current.selected) !== JSON.stringify(source.selected)) || owner.directorySnapshot?.().accessKey !== snapshot?.accessKey) {
        notify('目录、选中文件或终端身份已变化，请重新选择后传输。', 'error'); return;
      }
      transfer(createSidebarTransfer(owner, terminalId, title || '终端文件', destination, paths, remoteName));
    } catch (error) { if (alive.current) notify(error instanceof Error ? error.message : '无法开始文件传输。', 'error'); }
    finally { choosingLock.current = false; if (alive.current) setChoosing(false); }
  };
  const menuActions:FileMenuAction[] = menu ? [
    ...(menu.names.length===1 && entries.some(entry=>entry.name===menu.names[0]&&entry.directory) ? [{label:'打开目录',icon:'folder' as const,run:()=>{if(targetValid(menu))browse(directoryChild(menu.path,menu.names[0]));}}] : []),
    {label:`下载${menu.names.length>1?` ${menu.names.length} 项`:''}`,icon:'download',disabled:!canTransfer||!canDownload,run:()=>{if(targetValid(menu))void chooseTransfer(true);}},
    {label:'复制路径',icon:'copy',run:()=>{if(targetValid(menu))void copy(menu.names.map(name=>directoryChild(menu.path,name)).join('\n'));}},
    {label:'重命名',icon:'edit',disabled:!canTransfer||menu.names.length!==1,run:()=>startOperation(menu,'rename')},
    {label:'移动到…',icon:'folder',disabled:!canTransfer,run:()=>startOperation(menu,'move')},
    {label:`删除${menu.names.length>1?` ${menu.names.length} 项`:''}`,icon:'trash',danger:true,disabled:!canTransfer,run:()=>startOperation(menu,'delete')},
  ]:[];
  return <section ref={surface} className={`terminal-file-sidebar${dragActive?' drop-target':''}`} aria-label="当前终端文件" hidden={!visible}>
    <header className="terminal-file-heading"><span><Icon name="server" size={14} /><strong title={title}>{title || '终端文件'}</strong></span>
      <div className="terminal-file-actions" aria-label="文件传输操作" aria-busy={choosing}>
        <IconButton icon="upload" className="terminal-file-transfer upload" label="上传文件到当前目录" disabled={!canTransfer} onClick={() => void chooseTransfer(false)} />
        <IconButton icon="download" className="terminal-file-transfer download" label="下载选中文件" title={canDownload ? `下载选中的 ${downloadEntries.length} 项（文件或目录）` : selectedEntries.some(entry=>entry.symlink) ? '暂不支持下载符号链接，请选择普通文件或目录' : 'Ctrl + 点击选择文件或目录，支持多选下载'} disabled={!canTransfer || !canDownload} onClick={() => void chooseTransfer(true)} />
        <IconButton icon="refresh" label="刷新文件列表" disabled={!enabled || page.loading} onClick={() => refresh(value => value + 1)} />
      </div>
    </header>
    {unavailable ? <div className="terminal-file-empty"><Icon name="folder" size={30} /><strong>{local ? '当前是本地终端' : '尚未选择 SSH 终端'}</strong><p>连接并激活一个 SSH 终端后，在这里浏览服务器文件。</p></div> : <>
      <form className="terminal-file-path" onSubmit={event => { event.preventDefault(); browse(input.trim()); }}>
        <IconButton icon="up" label="文件上一级目录" disabled={!enabled || !(page.listing?.path || path) || (page.listing?.path || path) === '/'} onClick={() => browse(directoryParent(page.listing?.path || path))} />
        <input aria-label="服务器目录路径" value={input} onChange={event => setInput(event.target.value)} placeholder="输入绝对路径" disabled={!enabled} spellCheck={false} />
        <button type="submit" disabled={!enabled || !input.startsWith('/')} aria-label="前往服务器目录"><Icon name="right" size={14} /></button>
      </form>
      <div className="terminal-file-options"><label><input type="checkbox" checked={follow} onChange={event => changeFollow(event.target.checked)} />跟随终端目录</label>
        <button type="button" aria-pressed={showHidden} title={showHidden ? '隐藏点开头的文件' : '显示隐藏文件'} onClick={() => {setShowHidden(value => !value);setSelected([]);setMenu(null);}}>隐藏文件</button>
      </div>
      <p className="terminal-file-note" role="status">{!connected ? '连接已断开，重新连接后恢复浏览。' : directory.access === 'unavailable' ? 'root 目录通道未就绪 · 请退出 root 后重新 sudo -i' : directory.access === 'root' ? `已复用终端 root 认证 · ${follow ? '跟随终端目录' : '自由浏览'}` : follow && !directory.path ? '暂显示登录目录。目录跟随在新建或重连的 Bash 终端生效；其他 Shell 可手动浏览。' : follow && directory.running ? '命令运行中 · 显示上次同步的目录' : follow ? '已跟随终端 · 目录变化时同步' : '自由浏览 · 不改变终端目录'}</p>
      {page.error && <div className="terminal-file-error" role="alert"><Icon name="alert" size={14} /><span>{page.error}<small>目录浏览跟随当前终端的访问身份，无需重复输入 sudo 密码。独立的“管理与传输”使用自己的文件会话。</small></span><button type="button" disabled={!enabled} onClick={() => refresh(value => value + 1)}>重试</button></div>}
      <div className="terminal-file-list" role="listbox" aria-multiselectable="true" aria-label="目录内容" aria-busy={page.loading} onKeyDown={event=>{
        if(mutating||choosing)return;
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();event.stopPropagation();setSelected(entries.map(entry=>entry.name));}
        else if(event.key==='Escape'){setSelected([]);setMenu(null);}
      }}>
        {page.loading && !page.listing ? <p className="terminal-file-placeholder">正在读取目录…</p> : !page.error && page.listing && !entries.length ? <p className="terminal-file-placeholder">{page.listing.entries.length ? '没有可见文件' : '此目录为空'}</p> : entries.map(entry => <button key={entry.name} type="button" role="option"
          className={`terminal-file-entry${selected.includes(entry.name) ? ' selected' : ''}`} aria-selected={selected.includes(entry.name)} disabled={!enabled||mutating||choosing} title={`${entry.name}${entry.symlink ? ' · 符号链接' : ''}`}
          onClick={event => {
            if(!event?.ctrlKey&&!event?.metaKey&&!event?.shiftKey&&(entry.directory||entry.symlink)){browse(directoryChild(page.listing!.path,entry.name));return;}
            setSelected(current=>fileSelection(current,entries.map(item=>item.name),entry.name,anchor.current,event));
            if(!event?.shiftKey)anchor.current=entry.name;
          }} onContextMenu={event=>{
            event.preventDefault();if(!canTransfer||!runtime||!page.listing)return;
            const names=selected.includes(entry.name)?selectedEntries.map(item=>item.name):[entry.name];
            setSelected(names);anchor.current=entry.name;
            setMenu({owner:runtime,path:page.listing.path,requestedPath:path,scope,names,x:event.clientX,y:event.clientY});
          }}>
          <Icon name={entry.directory ? 'folder' : 'file'} size={16} className={entry.directory ? 'is-folder' : ''} /><span>{entry.name}{entry.symlink && <small> ↗</small>}</span>
          {entry.directory ? <Icon name="right" size={12} /> : <small>{entry.symlink ? '链接' : resourceBytes(entry.size)}</small>}
        </button>)}
      </div>
      <p className="terminal-file-selection-hint">Ctrl + 点击多选 · Shift + 点击连选 · 右键更多操作</p>
      <footer className="terminal-file-footer"><span>{page.listing ? `${entries.length} 项${selectedEntries.length?` · 已选 ${selectedEntries.length} 项`:''}${page.listing.truncated ? ' · 仅展示部分' : ''}` : '目录浏览'}</span>
        <IconButton icon="copy" label={selectedEntries.length ? '复制选中文件路径' : '复制当前目录路径'} disabled={!page.listing} onClick={() => { if (page.listing) void copy(selectedEntries.length ? selectedEntries.map(entry=>directoryChild(page.listing!.path,entry.name)).join('\n') : page.listing.path); }} />
        <button type="button" disabled={!connected} onClick={openFiles}><Icon name="folder" size={13} />管理与传输<Icon name="upRight" size={12} /></button>
      </footer>
    </>}
    {dragActive&&canDrop&&<div className="terminal-file-drop-hint" aria-hidden="true"><Icon name="upload" size={28}/><strong>在此区域松开鼠标即可上传</strong><span>{page.listing?.path}</span><small>上传前会确认目标目录</small></div>}
    {pendingUpload&&createPortal(<TerminalUploadConfirm request={pendingUpload.request} onClose={()=>setPendingUpload(null)} onConfirm={confirmDroppedUpload}/>,document.body)}
    {menu&&<TerminalFileContextMenu x={menu.x} y={menu.y} caption={menu.names.length===1?menu.names[0]:`已选 ${menu.names.length} 项`} actions={menuActions} close={()=>setMenu(null)}/>}
    {operation&&<TerminalFileOperationDialog key={`${operation.kind}:${operation.path}:${operation.names.join('/')}`} kind={operation.kind} names={operation.names} path={operation.path} busy={mutating} error={operationError} close={()=>{if(!mutationLock.current)setOperation(null);}} confirm={value=>void confirmOperation(value)}/>}
  </section>;
}
