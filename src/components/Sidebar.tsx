import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { SftpEntry, SftpTransfer } from '../api/sftp';
import { useSftp } from '../state/useSftp';
import { isTauriRuntime } from '../state/runtime';
import { formatBytes, remoteParent, transferPercent, transferStatus } from '../state/sftp';
import { Icon, IconButton, Modal } from './Ui';
import './SftpFileManager.css';

const LOCAL_PATH_DRAG_TYPE = 'application/x-agent-ssh-local-path';

function transferIdentity(task: SftpTransfer) {
  const rootItem = task.items.reduce<SftpTransfer['items'][number] | undefined>((root, item) => {
    if (!root) return item;
    const depth = item.relativePath.split('/').length;
    const rootDepth = root.relativePath.split('/').length;
    return depth < rootDepth ? item : root;
  }, undefined);
  const fileCount = task.items.filter(item => item.kind === 'FILE').length;
  const relativePath = rootItem?.relativePath || '正在准备文件清单';
  const name = relativePath.split('/').filter(Boolean).pop() || relativePath;
  return {
    name: rootItem?.kind === 'DIRECTORY' ? `${name} · ${fileCount} 个文件` : name,
    relativePath,
    location: task.direction === 'UPLOAD' ? `上传到 ${task.remotePath}` : `来自 ${task.remotePath}`,
  };
}

function FileSource({ side, title, path, parent, roots = [], entries, loading, enabled, selected, select, browse, create, requestDelete, copy, draggingPath, dragStart, dragEnd, uploadDrop }: {
  side: 'local' | 'remote'; title: string; path: string; parent: string | null; roots?: string[]; entries: SftpEntry[];
  loading: boolean; enabled: boolean; selected: string; select: (value: string) => void;
  browse: (path: string) => void; create: (kind: 'file' | 'directory', name: string) => Promise<boolean>;
  requestDelete: (entry: SftpEntry) => void; copy: (path: string) => void;
  draggingPath?: string; dragStart?: (path: string) => void; dragEnd?: () => void;
  uploadDrop?: (paths: string[]) => void;
}) {
  const [input, setInput] = useState(path);
  const [dropTarget, setDropTarget] = useState(false);
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
  return <section className={`file-source-card ${side} ${dropTarget ? 'drop-target' : ''}`} aria-label={title}
    onDragOver={event => { if (uploadDrop && (draggingPath || event.dataTransfer.types.includes(LOCAL_PATH_DRAG_TYPE))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropTarget(true); } }}
    onDragLeave={event => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropTarget(false); }}
    onDrop={event => {
      const localPath = draggingPath
        || event.dataTransfer.getData(LOCAL_PATH_DRAG_TYPE)
        || event.dataTransfer.getData('text/plain');
      if (uploadDrop && localPath) {
        event.preventDefault();
        setDropTarget(false);
        dragEnd?.();
        uploadDrop([localPath]);
      }
    }}>
    <header className="file-source-heading"><span className="file-source-icon"><Icon name={side === 'local' ? 'monitor' : 'server'} size={16} /></span><span><strong>{title}</strong><small>{side === 'local' ? '当前设备' : '远程服务器'}</small></span></header>
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
        {selectedEntry && <IconButton icon="trash" label={`删除 ${selectedEntry.name}`} disabled={loading} onClick={() => askDelete(selectedEntry)} />}
        <IconButton icon="refresh" label={`刷新${title}`} disabled={!enabled || loading} onClick={() => browse(path)} />
      </>}
    </div>
    <div className="file-list-heading"><span>名称</span><small>大小 / 修改时间</small></div>
    <div className="file-tree-scroll" aria-busy={loading}>
      {loading ? <p className="sftp-empty">正在读取目录…</p> : !enabled ? <p className="sftp-empty">连接后浏览服务器文件</p> : !entries.length ? <p className="sftp-empty">空目录</p> : <ul className="sftp-entry-list" aria-label={`${title}文件列表`}>
        {entries.map(entry => <li key={entry.path}><button className={`file-row ${selected === entry.path ? 'selected' : ''}`} aria-pressed={selected === entry.path} title={`${entry.path}\n${entry.permissions}`} disabled={entry.kind !== 'FILE' && entry.kind !== 'DIRECTORY'} draggable={side === 'local' && (entry.kind === 'FILE' || entry.kind === 'DIRECTORY')} onDragStart={event => { if (side === 'local') { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(LOCAL_PATH_DRAG_TYPE, entry.path); event.dataTransfer.setData('text/plain', entry.path); dragStart?.(entry.path); } }} onDragEnd={() => { setDropTarget(false); dragEnd?.(); }} onClick={() => select(entry.path)} onContextMenu={event => { event.preventDefault(); select(entry.path); setContextMenu({ entry, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 174)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 142)) }); }} onDoubleClick={() => { if (entry.kind === 'DIRECTORY') browse(entry.path); }} onKeyDown={event => { if (event.key === 'Enter' && entry.kind === 'DIRECTORY') { event.preventDefault(); browse(entry.path); } }}>
          <Icon name={entry.kind === 'DIRECTORY' ? 'folder' : 'file'} size={17} className={entry.kind === 'DIRECTORY' ? 'folder-icon' : ''} /><span className="sftp-entry-name">{entry.name}</span><span className="sftp-entry-meta"><small>{entry.kind === 'DIRECTORY' ? '目录' : entry.kind === 'FILE' ? formatBytes(entry.size) : '不支持'}</small><time>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}</time></span>
        </button></li>)}
      </ul>}
    </div>
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

export function SessionFiles({ connectionId, title, visible, minimize, remove, copy, notify }: {
  connectionId: string; title: string; visible: boolean; minimize: () => void; remove: () => void;
  copy: (text: string) => void; notify: (message: string, type?: 'info' | 'error' | 'success') => void;
}) {
  // This controller remains mounted while minimized, independently of terminal tabs.
  const files = useSftp(connectionId);
  const [root, setRoot] = useState('');
  const [localSelected, setLocalSelected] = useState('');
  const [remoteSelected, setRemoteSelected] = useState('');
  const [conflict, setConflict] = useState<'FAIL' | 'SKIP' | 'REPLACE'>('FAIL');
  const [nativeDragActive, setNativeDragActive] = useState(false);
  const [draggingLocalPath, setDraggingLocalPath] = useState('');
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ side: 'local' | 'remote'; entry: SftpEntry } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const ready = files.phase === 'ready';
  const activeTransfers = files.tasks.filter(task => !['COMPLETED', 'CANCELLED'].includes(task.progress.status)).length;
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
    notify(`正在准备上传 ${uniquePaths.length} 项到 ${files.remotePath}`);
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
    if (succeeded !== uniquePaths.length) setTransfersOpen(true);
  };
  const uploadSelected = async () => {
    if (!localEntry) return;
    notify(`正在创建上传任务：${localEntry.name} → ${files.remotePath}`);
    const succeeded = await files.transfer('UPLOAD', localEntry.path, files.remotePath, conflict);
    if (succeeded) {
      notify(`已开始上传：${localEntry.name}，可在传输队列查看进度。`, 'success');
    }
  };
  useEffect(() => {
    if (!visible || !isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === 'over') setNativeDragActive(true);
      else if (event.payload.type === 'drop') {
        setNativeDragActive(false);
        void uploadPaths(event.payload.paths);
      } else setNativeDragActive(false);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); setNativeDragActive(false); };
  }, [visible, ready, files.remotePath, conflict]);
  if (!visible) return null;
  return <Modal title={`文件管理 · ${title}`} onClose={() => { if (deleteTarget && !deleting) setDeleteTarget(null); else if (transfersOpen) setTransfersOpen(false); else minimize(); }} className="sftp-modal" dismissDisabled={deleting}>
    <div className="session-file-panel sftp-manager">
      <div className="sftp-session-bar"><span><i className={`status-dot ${ready ? '' : 'offline'}`} />{ready ? `${files.connection} · 目标 ${files.remotePath}` : files.phase === 'opening' ? '正在建立文件管理连接…' : files.phase === 'closed' ? '文件管理会话已结束' : '使用已保存的 SSH 配置连接'}</span><div className="inline-actions"><button className="file-mini-action" disabled={files.phase === 'opening' || files.phase === 'closing'} onClick={async () => { if (await files.close()) remove(); }}>{files.phase === 'closing' ? '正在关闭…' : '结束文件会话'}</button></div></div>
      {!ready && files.phase !== 'closing' && <form className="sftp-connect" onSubmit={event => { event.preventDefault(); void files.open(root); }}><label>远程根目录<input value={root} onChange={event => setRoot(event.target.value)} placeholder="留空使用账号默认目录；/ 浏览整个文件系统" disabled={files.phase === 'opening'} /></label><button className="primary-button" disabled={files.phase === 'opening'}>{files.phase === 'opening' ? '连接中…' : files.phase === 'closed' ? '重新打开会话' : '连接文件管理'}</button></form>}
      <div className={`sftp-native-drop ${nativeDragActive ? 'visible' : ''}`} aria-hidden={!nativeDragActive}><span><Icon name="upload" size={28} /></span><strong>{ready ? `释放以上传到 ${files.remotePath}` : '请先连接文件管理'}</strong><small>支持文件和文件夹，可一次拖入多项</small></div>
      <section className="dual-file-explorer" aria-label="本地与远程文件">
        <FileSource side="local" title="本地系统" path={files.local?.path ?? ''} parent={files.local?.parent ?? null} roots={files.local?.roots ?? []} entries={files.local?.entries ?? []} loading={files.localLoading} enabled selected={localSelected} select={setLocalSelected} browse={path => { setLocalSelected(''); void files.loadLocal(path); }} create={(kind, name) => kind === 'directory' ? files.mkdir('local', name) : files.createFile('local', name)} requestDelete={entry => setDeleteTarget({ side: 'local', entry })} copy={copy} dragStart={setDraggingLocalPath} dragEnd={() => setDraggingLocalPath('')} />
        <div className="file-transfer-rail" aria-label="文件传输方向">
          <button className="transfer-direction upload" disabled={!ready || files.working || files.localLoading || files.remoteLoading || !localEntry} title="上传选中的本地文件或目录到右侧当前目录" aria-label="上传选中的本地文件或目录" onClick={() => void uploadSelected()}><Icon name="right" size={18} /></button>
          <span className="transfer-link" aria-hidden="true"><i /><i /><i /></span>
          <button className="transfer-direction download" disabled={!ready || files.working || files.localLoading || files.remoteLoading || !remoteEntry || !files.local} title="下载选中的远程文件或目录到左侧当前目录" aria-label="下载选中的远程文件或目录" onClick={() => remoteEntry && files.local && void files.transfer('DOWNLOAD', files.local.path, remoteEntry.path, 'FAIL')}><Icon name="left" size={18} /></button>
        </div>
        <FileSource side="remote" title="服务器文件" path={files.remotePath} parent={files.session ? remoteParent(files.remotePath, files.session.rootPath) : null} entries={files.entries} loading={files.remoteLoading} enabled={ready} selected={remoteSelected} select={setRemoteSelected} browse={path => { setRemoteSelected(''); void files.loadRemote(path); }} create={(kind, name) => kind === 'directory' ? files.mkdir('remote', name) : files.createFile('remote', name)} requestDelete={entry => setDeleteTarget({ side: 'remote', entry })} copy={copy} draggingPath={draggingLocalPath} dragEnd={() => setDraggingLocalPath('')} uploadDrop={paths => void uploadPaths(paths)} />
      </section>
      <footer className="sftp-transfer-options">
        <div className={`sftp-conflict-policy policy-${conflict.toLowerCase()}`} role="radiogroup" aria-label="上传同名文件处理方式">
          <span className="sftp-conflict-label"><Icon name="shield" size={14} /><strong>同名处理</strong></span>
          <div>{([['FAIL', '停止', '遇到同名文件时停止，并保留服务器原文件'], ['SKIP', '跳过', '跳过同名文件，继续传输其他项目'], ['REPLACE', '替换', '完整上传到临时文件并校验后，再替换服务器原文件']] as const).map(([value, label, title]) => <button key={value} type="button" role="radio" aria-checked={conflict === value} className={`${value.toLowerCase()} ${conflict === value ? 'selected' : ''}`} title={title} onClick={() => setConflict(value)}><i aria-hidden="true" />{label}</button>)}</div>
          <small>{conflict === 'FAIL' ? '保留原文件' : conflict === 'SKIP' ? '跳过后继续' : '校验后替换'}</small>
        </div>
        <span className="sftp-drag-hint"><Icon name="upload" size={13} />将左侧条目或系统文件拖到右侧上传</span>
        <button type="button" className={`sftp-queue-button ${activeTransfers ? 'active' : ''}`} aria-expanded={transfersOpen} onClick={() => setTransfersOpen(true)}><Icon name="upload" size={14} /><span>传输队列</span><b>{files.tasks.length}</b>{activeTransfers > 0 && <i title={`${activeTransfers} 个任务处理中`} />}</button>
      </footer>
      {transfersOpen && <><button type="button" className="sftp-transfer-drawer-backdrop" aria-label="关闭传输队列" onClick={() => setTransfersOpen(false)} /><aside className="sftp-transfer-drawer" role="dialog" aria-modal="true" aria-label="传输队列">
        <header><span><strong>传输队列</strong><small>{activeTransfers > 0 ? `${activeTransfers} 个处理中` : `${files.tasks.length} 条记录`}</small></span><div className="inline-actions"><IconButton icon="refresh" label="查询传输状态" disabled={!ready} onClick={() => void files.refreshTasks()} /><IconButton icon="close" label="关闭传输队列" onClick={() => setTransfersOpen(false)} /></div></header>
        <section className="sftp-transfers" aria-label="SFTP 传输任务">
          {files.scanning && <p className="sftp-empty" role="status">{files.scanning}</p>}
          {!files.scanning && !files.tasks.length && <p className="sftp-empty">暂无传输<br /><small>选择文件后点击箭头，或拖到远程目录</small></p>}
          {files.tasks.map(task => {
            const progress = task.progress;
            const percent = transferPercent(progress);
            const finished = ['COMPLETED', 'CANCELLED'].includes(progress.status);
            const failed = task.items.filter(item => item.status === 'FAILED');
            const received = Object.values(files.localBytes[task.transferId] ?? {}).reduce((sum, bytes) => sum + bytes, 0);
            const identity = transferIdentity(task);
            return <article className={`sftp-task ${progress.status.toLowerCase()}`} key={task.transferId}>
              <div className="sftp-task-title">
                <span className="sftp-task-direction"><Icon name={task.direction === 'UPLOAD' ? 'upload' : 'down'} size={14} /><strong>{task.direction === 'UPLOAD' ? '上传' : '下载'}</strong></span>
                <span className="sftp-task-file"><strong title={identity.relativePath}>{identity.name}</strong><small title={task.remotePath}>{identity.location}</small></span>
                <small className="sftp-task-status">{transferStatus[progress.status] ?? progress.status}</small>
              </div>
              <div className="sftp-task-progress">{percent !== null && <progress max={100} value={percent} aria-label={`${task.direction === 'UPLOAD' ? '上传' : '下载'}字节进度`} />}<span>{percent === null ? `${progress.completedItems} / ${progress.totalItems} 项` : `${percent}% · ${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)}`}</span></div>
              <footer><small>完成 {progress.completedItems}/{progress.totalItems} 项{progress.failedItems > 0 && ` · 失败 ${progress.failedItems} 项`}{progress.awaitingConfirmation > 0 && ` · 待保存确认 ${progress.awaitingConfirmation} 项`}{task.direction === 'DOWNLOAD' && received > 0 && ` · 本机已接收 ${formatBytes(received)}`}{percent === 100 && !finished && ' · 正在提交或等待确认'}</small><div className="inline-actions">{!finished && <><button className="file-mini-action" disabled={!ready || files.working} onClick={() => void files.retry(task.transferId)}>重查并重试</button><button className="file-mini-action" disabled={!ready || files.cancelling.includes(task.transferId)} onClick={() => void files.cancel(task.transferId)}>{files.cancelling.includes(task.transferId) ? '取消中…' : '取消'}</button></>}</div></footer>
              {files.taskErrors[task.transferId] && !finished && <p className="sftp-task-error">{files.taskErrors[task.transferId]}</p>}
              {failed.length > 0 && <details><summary>查看 {failed.length} 个失败条目</summary>{failed.map(item => <p key={item.itemId}>{item.relativePath}：{item.message || item.errorCode || '传输失败'}</p>)}</details>}
            </article>;
          })}
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
