import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { beginFilePointerDrag } from '../state/filePointerDrag';
import { handleTerminalFileDrop } from '../state/terminalFileDrop';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { SftpAccessMode, SftpEntry } from '../api/sftp';
import { sftpApi } from '../api/sftp';
import { useSftp } from '../state/useSftp';
import { runTerminalTransfer } from '../state/terminalUpload';
import type { TerminalTransferRequest } from '../state/terminalUpload';
import { isTauriRuntime } from '../state/runtime';
import { formatBytes, remoteParent } from '../state/sftp';
import { AccentIcon, Badge, Icon, IconButton, Modal, fileTone } from './Ui';
import { Select } from './Select';
import { SftpTransferTask } from './SftpTransferTask';
import './SftpFileManager.css';

/**
 * 注册一个“应用关闭前”清理器：当用户关掉整个客户端时，
 * 父组件会调用所有注册回调，逐个把后端 SFTP 会话释放掉，
 * 避免 Rust 侧留下一堆无人回收的 Channel / 任务。
 *
 * 回调会在组件卸载时自动反注册，调用方拿到的是 async 函数。
 */
export type SftpCloseHandler = () => Promise<void>;

function FileSource({ side, title, path, parent, roots = [], entries, loading, enabled, selected, select, browse, create, requestDelete, copy, dragStart, dropSurface, dropActive }: {
  side: 'local' | 'remote'; title: string; path: string; parent: string | null; roots?: string[]; entries: SftpEntry[];
  loading: boolean; enabled: boolean; selected: string; select: (value: string) => void;
  browse: (path: string) => void; create: (kind: 'file' | 'directory', name: string) => Promise<boolean>;
  requestDelete: (entry: SftpEntry) => void; copy: (path: string) => void;
  dragStart?: (path: string, event: PointerEvent, source: HTMLElement) => void;
  dropSurface?: RefObject<HTMLElement | null>; dropActive?: boolean;
}) {
  const [input, setInput] = useState(path);
  const [creating, setCreating] = useState<'file' | 'directory' | null>(null);
  const [entryName, setEntryName] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ entry: SftpEntry; x: number; y: number } | null>(null);
  const [rootMenuOpen, setRootMenuOpen] = useState(false);
  const rootMenuRef = useRef<HTMLDivElement>(null);
  const selectedEntry = entries.find(entry => entry.path === selected);
  const currentRoot = roots.find(root => path.toLowerCase().startsWith(root.toLowerCase())) ?? '';
  useEffect(() => {
    setInput(path);
    select('');
    setCreating(null);
    setEntryName('');
    setContextMenu(null);
    setRootMenuOpen(false);
  }, [path, select]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [contextMenu]);
  useEffect(() => {
    if (!rootMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootMenuRef.current?.contains(event.target as Node)) setRootMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRootMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [rootMenuOpen]);
  const beginCreate = (kind: 'file' | 'directory') => {
    setCreating(kind);
    setEntryName('');
  };
  const askDelete = (entry: SftpEntry) => {
    setCreating(null);
    setContextMenu(null);
    select(entry.path);
    requestDelete(entry);
  };
  return <section ref={dropSurface} className={`file-source-card ${side} ${dropActive ? 'drop-target' : ''}`} aria-label={title}>
    <header className="file-source-heading"><AccentIcon className="file-source-icon" icon={side === 'local' ? 'monitor' : 'server'} tone={side === 'local' ? 'violet' : 'cyan'} size={16} /><span><strong>{title}</strong><Badge tone={side === 'local' ? 'violet' : 'cyan'}>{side === 'local' ? '当前设备' : '远程服务器'}</Badge></span></header>
    <form className="path-bar" onSubmit={event => { event.preventDefault(); if (input.trim()) browse(input.trim()); }}>
      <IconButton icon="up" label={`${title}上一级`} disabled={!enabled || !parent || loading} onClick={() => parent && browse(parent)} />
      {side === 'local' && roots.length > 0 && <div ref={rootMenuRef} className={`local-root-picker ${rootMenuOpen ? 'open' : ''}`}>
        <button type="button" className="local-root-trigger" aria-label="选择本地磁盘" aria-haspopup="listbox" aria-expanded={rootMenuOpen} disabled={!enabled || loading} onClick={() => setRootMenuOpen(open => !open)}>
          <Icon name="disk" size={12} /><strong>{currentRoot.slice(0, 2) || '磁盘'}</strong><Icon name="down" size={11} className="local-root-chevron" />
        </button>
        {rootMenuOpen && <div className="local-root-menu" role="listbox" aria-label="本地磁盘">
          {roots.map(root => {
            const selectedRoot = root === currentRoot;
            return <button key={root} type="button" role="option" aria-selected={selectedRoot} className={selectedRoot ? 'selected' : ''} onClick={() => { setRootMenuOpen(false); browse(root); }}>
              <span className="local-root-drive"><Icon name="disk" size={14} /><strong>{root.slice(0, 2)}</strong></span>
              <small>本地磁盘</small><i aria-hidden="true" />
            </button>;
          })}
        </div>}
      </div>}
      <input aria-label={`${title}目录路径`} value={input} onChange={event => setInput(event.target.value)} placeholder={side === 'local' ? '输入本地绝对路径' : '远程目录路径'} disabled={!enabled || loading} />
      <button type="submit" className="file-mini-action" disabled={!enabled || loading || !input.trim()}>前往</button>
      <IconButton icon="copy" label={`复制${title}路径`} disabled={!path} onClick={() => copy(path)} />
    </form>
    <div className={`file-source-actions ${creating ? 'creating' : ''}`}>
      {creating ? <form className="file-source-create" onSubmit={async event => {
        event.preventDefault();
        if (!entryName.trim() || savingEntry) return;
        setSavingEntry(true);
        if (await create(creating, entryName.trim())) {
          setCreating(null);
          setEntryName('');
        }
        setSavingEntry(false);
      }}>
        <Icon name={creating === 'directory' ? 'folder' : 'file'} size={14} />
        <input autoFocus aria-label={`${title}新${creating === 'directory' ? '目录' : '文件'}名称`} value={entryName} onChange={event => setEntryName(event.target.value)} placeholder={`输入新${creating === 'directory' ? '目录' : '文件'}名称`} disabled={savingEntry} />
        <button className="file-mini-action" type="submit" disabled={!entryName.trim() || savingEntry}>{savingEntry ? '创建中…' : '创建'}</button>
        <IconButton icon="close" label="取消创建" disabled={savingEntry} onClick={() => { setCreating(null); setEntryName(''); }} />
      </form> : <>
        <button className="file-mini-action" disabled={!enabled || loading || !path} onClick={() => beginCreate('file')}><Icon name="file" size={14} />新建文件</button>
        <button className="file-mini-action" disabled={!enabled || loading || !path} onClick={() => beginCreate('directory')}><Icon name="folder" size={14} />新建目录</button>
        {selectedEntry && <button type="button" className="file-mini-action danger" aria-label={`删除 ${selectedEntry.name}`} disabled={loading} onClick={() => askDelete(selectedEntry)}>删除</button>}
        <IconButton icon="refresh" label={`刷新${title}`} disabled={!enabled || loading} onClick={() => browse(path)} />
      </>}
    </div>
    <div className="file-list-heading"><span>名称</span><small>大小 / 修改时间</small></div>
    <div className="file-tree-scroll" aria-busy={loading}>
      {loading ? <p className="sftp-empty">正在读取目录…</p> : !enabled ? <p className="sftp-empty">连接后浏览服务器文件</p> : !entries.length ? <p className="sftp-empty">空目录</p> : <ul className="sftp-entry-list" aria-label={`${title}文件列表`}>
        {entries.map(entry => <li key={entry.path}><button className={`file-row ${selected === entry.path ? 'selected' : ''}`} aria-pressed={selected === entry.path} title={`${entry.path}\n${entry.permissions}`} disabled={entry.kind !== 'FILE' && entry.kind !== 'DIRECTORY'} draggable={false} onPointerDown={event => { if (enabled && !loading) dragStart?.(entry.path, event.nativeEvent, event.currentTarget); }} onClick={() => select(entry.path)} onContextMenu={event => { event.preventDefault(); select(entry.path); setContextMenu({ entry, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 174)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 142)) }); }} onDoubleClick={() => { if (entry.kind === 'DIRECTORY') browse(entry.path); }} onKeyDown={event => { if (event.key === 'Enter' && entry.kind === 'DIRECTORY') { event.preventDefault(); browse(entry.path); } }}>
          <AccentIcon icon={entry.kind === 'DIRECTORY' ? 'folder' : 'file'} size={15} tone={entry.kind === 'DIRECTORY' ? 'amber' : fileTone(entry.name)} className="sftp-entry-icon" /><span className="sftp-entry-name">{entry.name}</span><span className="sftp-entry-meta"><small>{entry.kind === 'DIRECTORY' ? '目录' : entry.kind === 'FILE' ? formatBytes(entry.size) : '不支持'}</small><time>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}</time></span>
        </button></li>)}
      </ul>}
    </div>
    {dropActive && <div className="sftp-pane-drop" role="status"><Icon name={side === 'remote' ? 'upload' : 'down'} size={28} /><strong>在此区域松开鼠标即可{side === 'remote' ? '上传' : '下载'}</strong><small title={path}>{path}</small></div>}
    {contextMenu && <>
      <button type="button" className="file-context-backdrop" aria-label="关闭文件操作菜单" onClick={() => setContextMenu(null)} />
      <div className="file-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
        {contextMenu.entry.kind === 'DIRECTORY' && <button role="menuitem" onClick={() => { setContextMenu(null); browse(contextMenu.entry.path); }}><Icon name="folder" size={14} />打开目录</button>}
        <button role="menuitem" onClick={() => { copy(contextMenu.entry.path); setContextMenu(null); }}><Icon name="copy" size={14} />复制路径</button>
        <i />
        <button role="menuitem" className="danger" onClick={() => askDelete(contextMenu.entry)}><Icon name="trash" size={14} />删除{contextMenu.entry.kind === 'DIRECTORY' ? '空目录' : '文件'}</button>
      </div>
    </>}
  </section>;
}

export function SessionFiles({ connectionId, title, target, uploadRequest, validateUpload, uploadHandled, visible, minimize, copy, notify, registerAppCloseCleanup }: {
  uploadRequest?: TerminalTransferRequest;
  validateUpload?: (request: TerminalTransferRequest) => boolean;
  uploadHandled?: (id: string) => void;
  target?: import('../state/terminalFileTarget').TerminalFileTarget;
  connectionId: string; title: string; visible: boolean; minimize: () => void;
  copy: (text: string) => void; notify: (message: string, type?: 'info' | 'error' | 'success') => void;
  registerAppCloseCleanup?: (id: string, handler: SftpCloseHandler) => () => void;
}) {
  // This controller remains mounted while minimized, independently of terminal tabs.
  const files = useSftp(connectionId);
  const [root, setRoot] = useState('');
  const [accessMode, setAccessMode] = useState<SftpAccessMode>('login');
  const [terminalAccess, setTerminalAccess] = useState(!!target);
  const openedTarget = useRef<import('../state/terminalFileTarget').TerminalFileTarget | undefined>(undefined);
  const handledTarget = useRef(0);
  const claimedUpload = useRef('');
  const waitingTransfer = useRef('');
  const uploadMounted = useRef(true);
  const uploadCallbacks = useRef({ validateUpload, uploadHandled, notify });
  uploadCallbacks.current = { validateUpload, uploadHandled, notify };
  useEffect(() => { uploadMounted.current = true; return () => { uploadMounted.current = false; }; }, []);
  const [sudoPassword, setSudoPassword] = useState('');
  const [accessEditing, setAccessEditing] = useState(false);
  const [localSelected, setLocalSelected] = useState('');
  const [remoteSelected, setRemoteSelected] = useState('');
  const [conflict, setConflict] = useState<'FAIL' | 'SKIP' | 'REPLACE'>('FAIL');
  const [nativeDragActive, setNativeDragActive] = useState(false);
  const [pointerDropSide, setPointerDropSide] = useState<'local' | 'remote' | null>(null);
  const localDropSurface = useRef<HTMLElement | null>(null);
  const remoteDropSurface = useRef<HTMLElement | null>(null);
  const pointerDragCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => pointerDragCleanup.current?.(), []);
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ side: 'local' | 'remote'; entry: SftpEntry } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const ready = files.phase === 'ready';
  useEffect(() => { pointerDragCleanup.current?.(); }, [visible, ready, files.working, files.local?.path, files.remotePath, files.session?.sftpSessionId]);

  useEffect(() => { if (!visible) setSudoPassword(''); }, [visible]);

  // 注册到父组件的“应用关闭前”清理队列。
  // - 仅在可见时（文件窗口还存在）注册；最小化也算存在，只有真正关闭才走 files.close()
  // - 拿到的 handler 会调用 useSftp 内部的 sessionRef.current 里的 sftpSessionId，
  //   后端拿到这个 ID 就能释放 Channel 和后台任务。
  useEffect(() => {
    if (!registerAppCloseCleanup) return;
    const handler: SftpCloseHandler = async () => {
      // 取快照：身份变化或断线可能已清空 sftpSessionId。
      const session = files.session;
      if (!session?.sftpSessionId) return;
      try { await sftpApi.close(session.sftpSessionId); }
      catch (error) { console.warn('应用关闭时释放 SFTP 会话失败', error); }
    };
    return registerAppCloseCleanup(target?.terminalSessionId || connectionId, handler);
  }, [registerAppCloseCleanup, connectionId, target?.terminalSessionId, files.session]);
  const activeTransfers = files.tasks.filter(task => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.progress.status)).length;
  useEffect(() => {
    if (!uploadRequest || claimedUpload.current === uploadRequest.id || files.phase === 'opening' || files.phase === 'closing' || files.working) return;
    const previous = openedTarget.current;
    const destination = uploadRequest.target;
    const root = files.session?.rootPath;
    const reuse = ready && previous?.terminalSessionId === destination.terminalSessionId && previous.accessKey === destination.accessKey
      && !!root && (root === '/' || destination.path === root || destination.path.startsWith(`${root}/`));
    // Never replace a busy independent identity just to start a terminal upload.
    if (activeTransfers > 0 && !reuse) {
      if (waitingTransfer.current !== uploadRequest.id) {
        waitingTransfer.current = uploadRequest.id;
        uploadCallbacks.current.notify('已等待当前文件操作结束，可在传输队列查看进度。');
      }
      return;
    }
    claimedUpload.current = uploadRequest.id;
    if (target) handledTarget.current = target.revision;
    setAccessEditing(false); setTerminalAccess(true); setRoot('/'); setSudoPassword(''); setConflict('FAIL');
    const valid = () => uploadMounted.current && uploadCallbacks.current.validateUpload?.(uploadRequest) === true;
    void runTerminalTransfer(uploadRequest, {
      valid,
      connect: async () => {
        if (reuse) { await files.loadRemote(destination.path); return true; }
        openedTarget.current = destination;
        return files.open('/', 'login', undefined, destination.terminalSessionId, destination.path);
      },
      transfer: (direction, path, remote) => files.transfer(direction, path, remote, 'FAIL'),
    }).then(({ submitted, total }) => {
      if (!uploadMounted.current) return;
      const action = uploadRequest.direction === 'DOWNLOAD' ? '下载' : '上传';
      if (submitted === total) uploadCallbacks.current.notify(`已创建 ${submitted} 个${action}任务，可在传输队列查看进度。`, 'success');
      else if (!valid()) uploadCallbacks.current.notify(`终端连接或访问身份已变化，未提交的文件已停止${action}，请重新选择。`, 'error');
      else uploadCallbacks.current.notify(`已创建 ${submitted}/${total} 个${action}任务，请检查连接或传输队列中的错误。`, 'error');
    }).catch(error => { if (uploadMounted.current) uploadCallbacks.current.notify(error instanceof Error ? error.message : '无法开始终端传输。', 'error'); })
      .finally(() => uploadCallbacks.current.uploadHandled?.(uploadRequest.id));
  }, [uploadRequest, files.phase, files.working, activeTransfers]);
  useEffect(() => {
    if (uploadRequest || !visible || !target || handledTarget.current === target.revision || files.phase === 'opening' || files.phase === 'closing') return;
    handledTarget.current = target.revision;
    if (files.working || activeTransfers > 0) { notify('文件传输正在进行，保留当前目录；完成后重新打开可定位到终端目录。'); return; }
    setRoot(target.path ? '/' : ''); setTerminalAccess(true); setAccessEditing(false); setSudoPassword(''); setRemoteSelected('');
    const previous = openedTarget.current;
    const reuse = ready && previous?.terminalSessionId === target.terminalSessionId && previous.accessKey === target.accessKey
      && (!target.path || files.session?.rootPath === '/' || target.path === files.session?.rootPath || target.path.startsWith(`${files.session?.rootPath}/`));
    openedTarget.current = target;
    if (reuse) { if (target.path) void files.loadRemote(target.path); }
    else void files.open(target.path ? '/' : '', 'login', undefined, target.terminalSessionId, target.path);
  }, [visible, target, uploadRequest, files.phase, files.working, activeTransfers]);
  const localEntry = files.local?.entries.find(entry => entry.path === localSelected);
  const remoteEntry = files.entries.find(entry => entry.path === remoteSelected);
  const fileError = files.error;
  const clearFileError = files.setError;
  useEffect(() => {
    if (deleteTarget) deleteConfirmRef.current?.focus();
  }, [deleteTarget]);
  useEffect(() => {
    if (!fileError) return;
    // 文件管理中的操作错误统一使用应用级 Toast，避免临时提示挤压双栏文件区域。
    notify(fileError, 'error');
    clearFileError('');
  }, [fileError, clearFileError, notify]);
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    files.setError('');
    const succeeded = await files.deleteEntry(deleteTarget.side, deleteTarget.entry.path);
    if (succeeded) {
      if (deleteTarget.side === 'local') setLocalSelected('');
      else setRemoteSelected('');
      notify(`已删除${deleteTarget.entry.kind === 'DIRECTORY' ? '空目录' : '文件'}：${deleteTarget.entry.name}`, 'success');
      setDeleteTarget(null);
    }
    setDeleting(false);
  };
  const uploadPaths = async (paths: string[]) => {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (!ready) { notify('请先连接文件管理，再拖入文件。', 'error'); return; }
    if (!uniquePaths.length) return;
    let succeeded = 0;
    for (const localPath of uniquePaths) {
      if (await files.transfer('UPLOAD', localPath, files.remotePath, conflict)) succeeded++;
    }
    notify(
      succeeded === uniquePaths.length
        ? `已创建 ${succeeded} 个上传任务，可在传输队列查看进度。`
        : `已创建 ${succeeded}/${uniquePaths.length} 个上传任务，请打开传输队列查看详情。`,
      succeeded === uniquePaths.length ? 'success' : 'error',
    );
  };
  const uploadPathsRef = useRef(uploadPaths);
  uploadPathsRef.current = uploadPaths;
  const downloadPaths = async (paths: string[]) => {
    if (!ready || !files.local || files.working) return;
    const destination = files.local.path;
    let succeeded = 0;
    for (const path of [...new Set(paths)]) {
      if (await files.transfer('DOWNLOAD', destination, path, 'FAIL')) succeeded++;
    }
    if (succeeded) {
      notify(`已创建 ${succeeded} 个下载任务，可在传输队列查看进度。`, 'success');
    }
  };
  const downloadPathsRef = useRef(downloadPaths);
  downloadPathsRef.current = downloadPaths;
  const startFileDrag = (side: 'local' | 'remote', path: string, event: PointerEvent, source: HTMLElement) => {
    pointerDragCleanup.current?.();
    if (!ready || files.working || files.localLoading || files.remoteLoading || !files.local) return;
    const destination = side === 'local' ? 'remote' : 'local';
    pointerDragCleanup.current = beginFilePointerDrag(event, source, {
      document, target: () => destination === 'remote' ? remoteDropSurface.current : localDropSurface.current,
      hover: active => setPointerDropSide(active ? destination : null),
      drop: () => { void (side === 'local' ? uploadPathsRef.current : downloadPathsRef.current)([path]); },
    });
  };
  const uploadSelected = async () => {
    if (!localEntry) return;
    await uploadPaths([localEntry.path]);
  };
  useEffect(() => {
    if (!visible || !isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed || !remoteDropSurface.current) return;
      handleTerminalFileDrop(event.payload, remoteDropSurface.current, {
        hit: (x, y) => document.elementFromPoint(x, y), scale: window.devicePixelRatio,
        hover: setNativeDragActive, drop: paths => { void uploadPathsRef.current(paths); },
      });
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => { if (!disposed) setNativeDragActive(false); });
    return () => { disposed = true; unlisten?.(); setNativeDragActive(false); };
  }, [visible, ready, files.remotePath, conflict]);
  if (!visible) return null;
  return <Modal icon="folder" iconTone="amber" title={`文件管理 · ${title}`} onClose={() => { if (deleteTarget && !deleting) setDeleteTarget(null); else if (transfersOpen) setTransfersOpen(false); else minimize(); }} className="sftp-modal" dismissDisabled={deleting}>
    <div className="session-file-panel sftp-manager">
      <div className="sftp-session-bar"><span><i className={`status-dot ${ready ? '' : 'offline'}`} />{ready ? `${files.connection} · 访问账号 ${files.session?.accessUsername} ${files.session?.accessMode === 'sudoRoot' ? `（${files.session.loginUsername} 经 sudo）` : ''} · 目标 ${files.remotePath}` : files.phase === 'opening' ? '正在建立文件管理连接…' : files.phase === 'closed' ? '文件管理会话已结束' : '使用已保存的 SSH 配置连接'}</span><div className="inline-actions">{ready && <button className="file-mini-action" disabled={files.working || activeTransfers > 0} title={activeTransfers > 0 ? '请先完成或取消传输，再切换访问账号' : '重新连接文件管理，选择普通账号或 root 访问'} onClick={() => { setAccessEditing(value => !value); setSudoPassword(''); }}>切换访问账号</button>}</div></div>
      {(!ready || accessEditing) && files.phase !== 'closing' && <form className={`sftp-connect ${!terminalAccess && accessMode === 'sudoRoot' ? 'with-sudo' : ''}`} onSubmit={event => {
        event.preventDefault();
        if (files.working || activeTransfers > 0) { notify('请先完成或取消传输，再切换访问账号', 'error'); return; }
        const password = sudoPassword;
        setSudoPassword('');
        setRemoteSelected('');
        openedTarget.current = terminalAccess ? target : undefined;
        void files.open(root, accessMode, !terminalAccess && accessMode === 'sudoRoot' ? password : undefined,
          terminalAccess ? target?.terminalSessionId : undefined, terminalAccess ? target?.path : undefined).then(success => {
          if (success) { setAccessEditing(false); notify(terminalAccess ? '已使用当前终端身份打开文件管理' : accessMode === 'sudoRoot' ? '已使用 root 权限连接文件管理' : '已使用 SSH 登录账号连接文件管理', 'success'); }
        });
      }}>
        <div className="sftp-connect-fields">
          <label className="sftp-access-choice"><span className="sftp-field-label"><Icon name="user" size={13} />访问身份</span><Select<'terminal' | SftpAccessMode> value={terminalAccess ? 'terminal' : accessMode} label="文件访问身份" className="sftp-access-select" menuClassName="sftp-access-menu" menuMinWidth={220} disabled={files.phase === 'opening'} onChange={value => { setTerminalAccess(value === 'terminal'); if(value !== 'terminal')setAccessMode(value); setSudoPassword(''); }} options={[...(target ? [{ value: 'terminal' as const, label: '当前终端身份' }] : []), { value: 'login', label: 'SSH 登录账号' }, { value: 'sudoRoot', label: 'root（通过 sudo）' }]} /></label>
          {!terminalAccess && accessMode === 'sudoRoot' && <label className="sftp-password-field"><span className="sftp-field-label"><Icon name="key" size={13} />sudo 密码<small>可选</small></span><input type="password" autoComplete="off" value={sudoPassword} onChange={event => setSudoPassword(event.target.value)} placeholder="登录账号密码，免密可留空" disabled={files.phase === 'opening'} /></label>}
          <label className="sftp-root-field"><span className="sftp-field-label"><Icon name="folder" size={13} />远程根目录</span><input value={root} onChange={event => setRoot(event.target.value)} placeholder="默认目录留空，浏览全部填 /" disabled={files.phase === 'opening'} /></label>
          <button className="primary-button" disabled={files.phase === 'opening' || files.working || activeTransfers > 0}><Icon name={files.phase === 'opening' || ready ? 'refresh' : 'power'} size={14} />{files.phase === 'opening' ? '连接中…' : ready ? '切换并重连' : files.phase === 'closed' ? '重新打开会话' : '连接文件管理'}</button>
        </div>
        <div className="sftp-access-hint"><Icon name="bulb" size={13} /><span>{terminalAccess ? '复用当前终端认证，打开时定位到终端目录。退出 root 或关闭终端后，此文件会话失效；重新打开即可使用新身份。' : '独立文件会话，使用所选账号连接。'}{!terminalAccess && accessMode === 'sudoRoot' && <small>密码仅在会话内存中保留；服务器需允许 sudo 并安装 sftp-server。</small>}</span></div>
      </form>}
      <section className="dual-file-explorer" aria-label="本地与远程文件">
        <FileSource side="local" title="本地系统" path={files.local?.path ?? ''} parent={files.local?.parent ?? null} roots={files.local?.roots ?? []} entries={files.local?.entries ?? []} loading={files.localLoading} enabled selected={localSelected} select={setLocalSelected} browse={path => { setLocalSelected(''); void files.loadLocal(path); }} create={(kind, name) => kind === 'directory' ? files.mkdir('local', name) : files.createFile('local', name)} requestDelete={entry => setDeleteTarget({ side: 'local', entry })} copy={copy} dropSurface={localDropSurface} dropActive={pointerDropSide === 'local'} dragStart={(path, event, source) => startFileDrag('local', path, event, source)} />
        <div className="file-transfer-rail" aria-label="文件传输方向">
          <button className="transfer-direction upload" disabled={!ready || files.working || files.localLoading || files.remoteLoading || !localEntry} title="上传选中的本地文件或目录到右侧当前目录" aria-label="上传选中的本地文件或目录" onClick={() => void uploadSelected()}><Icon name="right" size={18} /></button>
          <span className="transfer-link" aria-hidden="true"><i /><i /><i /></span>
          <button className="transfer-direction download" disabled={!ready || files.working || files.localLoading || files.remoteLoading || !remoteEntry || !files.local} title="下载选中的远程文件或目录到左侧当前目录" aria-label="下载选中的远程文件或目录" onClick={() => remoteEntry && void downloadPaths([remoteEntry.path])}><Icon name="left" size={18} /></button>
        </div>
        <FileSource side="remote" title="服务器文件" path={files.remotePath} parent={files.session ? remoteParent(files.remotePath, files.session.rootPath) : null} dropSurface={remoteDropSurface} dropActive={pointerDropSide === 'remote' || (ready && nativeDragActive)} entries={files.entries} loading={files.remoteLoading} enabled={ready} selected={remoteSelected} select={setRemoteSelected} browse={path => { setRemoteSelected(''); void files.loadRemote(path); }} create={(kind, name) => kind === 'directory' ? files.mkdir('remote', name) : files.createFile('remote', name)} requestDelete={entry => setDeleteTarget({ side: 'remote', entry })} copy={copy} dragStart={(path, event, source) => startFileDrag('remote', path, event, source)} />
      </section>
      <footer className="sftp-transfer-options">
        <div className={`sftp-conflict-policy policy-${conflict.toLowerCase()}`} role="radiogroup" aria-label="上传同名文件处理方式">
          <span className="sftp-conflict-label"><Icon name="shield" size={14} /><strong>同名处理</strong></span>
          <div>{([['FAIL', '停止', '遇到同名文件时停止，并保留服务器原文件'], ['SKIP', '跳过', '跳过同名文件，继续传输其他项目'], ['REPLACE', '替换', '完整上传到临时文件并校验后，再替换服务器原文件']] as const).map(([value, label, title]) => <button key={value} type="button" role="radio" aria-checked={conflict === value} className={`${value.toLowerCase()} ${conflict === value ? 'selected' : ''}`} title={title} onClick={() => setConflict(value)}><i aria-hidden="true" />{label}</button>)}</div>
          <small>{conflict === 'FAIL' ? '保留原文件' : conflict === 'SKIP' ? '跳过后继续' : '校验后替换'}</small>
        </div>
        <span className="sftp-drag-hint"><Icon name="upload" size={13} />左拖右上传 · 右拖左下载</span>
        <button type="button" className={`sftp-queue-button ${activeTransfers ? 'active' : ''}`} aria-expanded={transfersOpen} onClick={() => setTransfersOpen(true)}><Icon name="upload" size={14} /><span>传输队列</span><b>{files.tasks.length}</b>{activeTransfers > 0 && <i title={`${activeTransfers} 个任务处理中`} />}</button>
      </footer>
      {transfersOpen && <><button type="button" className="sftp-transfer-drawer-backdrop" aria-label="关闭传输队列" onClick={() => setTransfersOpen(false)} /><aside className="sftp-transfer-drawer" role="dialog" aria-modal="true" aria-label="传输队列">
        <header><span><strong>传输队列</strong><small>{activeTransfers > 0 ? `${activeTransfers} 个处理中` : `${files.tasks.length} 条记录`}</small></span><div className="inline-actions"><IconButton icon="refresh" label="查询传输状态" disabled={!ready} onClick={() => void files.refreshTasks()} /><IconButton icon="close" label="关闭传输队列" onClick={() => setTransfersOpen(false)} /></div></header>
        {uploadRequest && claimedUpload.current !== uploadRequest.id && <p className="sftp-terminal-upload-pending" role="status">等待当前文件操作结束后，{uploadRequest.direction === 'DOWNLOAD' ? '下载到 ' + uploadRequest.paths[0] : '上传到 ' + uploadRequest.target.path}</p>}
        <section className="sftp-transfers" aria-label="SFTP 传输任务">
          {files.scanning && <p className="sftp-empty" role="status">{files.scanning}</p>}
          {!files.scanning && !files.tasks.length && <p className="sftp-empty">暂无传输<br /><small>选择文件后点击箭头，或拖到另一侧目录</small></p>}
          {files.tasks.map(task => <SftpTransferTask key={task.transferId} task={task} localBytes={files.localBytes[task.transferId]} error={files.taskErrors[task.transferId]}
            ready={ready} working={files.working} cancelling={files.cancelling.includes(task.transferId)} retry={()=>void files.retry(task.transferId)} cancel={()=>void files.cancel(task.transferId)}/>)}
        </section>
      </aside></>}
      {deleteTarget && <div className="sftp-delete-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !deleting) setDeleteTarget(null); }}>
        <section className="sftp-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sftp-delete-title" aria-describedby="sftp-delete-description">
          <span className="sftp-delete-icon"><Icon name="trash" size={22} /></span>
          <div>
            <h3 id="sftp-delete-title">确认删除“{deleteTarget.entry.name}”？</h3>
            <p id="sftp-delete-description">{deleteTarget.entry.kind === 'DIRECTORY' ? '仅允许删除空目录。此操作无法撤销。' : '文件删除后无法恢复，请确认路径无误。'}</p>
            <code title={deleteTarget.entry.path}>{deleteTarget.entry.path}</code>
          </div>
          <footer>
            <button className="outlined-button" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button>
            <button ref={deleteConfirmRef} className="danger-button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? '正在删除…' : '确认删除'}</button>
          </footer>
        </section>
      </div>}
    </div>
  </Modal>;
}
