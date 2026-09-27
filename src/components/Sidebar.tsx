import { useEffect, useState } from 'react';
import type { SftpEntry } from '../api/sftp';
import { useSftp } from '../state/useSftp';
import { formatBytes, remoteParent, transferPercent, transferStatus } from '../state/sftp';
import { Icon, IconButton, Modal } from './Ui';
import './SftpFileManager.css';

function FileSource({ side, title, path, parent, entries, loading, enabled, selected, select, browse, create, copy }: {
  side: 'local' | 'remote'; title: string; path: string; parent: string | null; entries: SftpEntry[];
  loading: boolean; enabled: boolean; selected: string; select: (value: string) => void;
  browse: (path: string) => void; create: () => void; copy: (path: string) => void;
}) {
  const [input, setInput] = useState(path);
  useEffect(() => { setInput(path); select(''); }, [path, select]);
  return <section className={`file-source-card ${side}`} aria-label={title}>
    <header className="file-source-heading"><span className="file-source-icon"><Icon name={side === 'local' ? 'monitor' : 'server'} size={16} /></span><span><strong>{title}</strong><small>{side === 'local' ? '当前设备' : '远程服务器'}</small></span></header>
    <form className="path-bar" onSubmit={event => { event.preventDefault(); if (input.trim()) browse(input.trim()); }}>
      <IconButton icon="up" label={`${title}上一级`} disabled={!enabled || !parent || loading} onClick={() => parent && browse(parent)} />
      <input aria-label={`${title}目录路径`} value={input} onChange={event => setInput(event.target.value)} placeholder={side === 'local' ? '输入本地绝对路径' : '远程目录路径'} disabled={!enabled || loading} />
      <button type="submit" className="file-mini-action" disabled={!enabled || loading || !input.trim()}>前往</button>
      <IconButton icon="copy" label={`复制${title}路径`} disabled={!path} onClick={() => copy(path)} />
    </form>
    <div className="file-source-actions"><button className="file-mini-action" disabled={!enabled || loading || !path} onClick={create}><Icon name="plus" size={14} />新建目录</button><IconButton icon="refresh" label={`刷新${title}`} disabled={!enabled || loading} onClick={() => browse(path)} /><small>双击目录进入</small></div>
    <div className="file-list-heading"><span>名称</span><small>大小 / 修改时间</small></div>
    <div className="file-tree-scroll" aria-busy={loading}>
      {loading ? <p className="sftp-empty">正在读取目录…</p> : !enabled ? <p className="sftp-empty">连接后浏览服务器文件</p> : !entries.length ? <p className="sftp-empty">空目录</p> : <ul className="sftp-entry-list" aria-label={`${title}文件列表`}>
        {entries.map(entry => <li key={entry.path}><button className={`file-row ${selected === entry.path ? 'selected' : ''}`} aria-pressed={selected === entry.path} title={`${entry.path}\n${entry.permissions}`} disabled={entry.kind !== 'FILE' && entry.kind !== 'DIRECTORY'} onClick={() => select(entry.path)} onDoubleClick={() => { if (entry.kind === 'DIRECTORY') browse(entry.path); }} onKeyDown={event => { if (event.key === 'Enter' && entry.kind === 'DIRECTORY') { event.preventDefault(); browse(entry.path); } }}>
          <Icon name={entry.kind === 'DIRECTORY' ? 'folder' : 'file'} size={17} className={entry.kind === 'DIRECTORY' ? 'folder-icon' : ''} /><span className="sftp-entry-name">{entry.name}</span><span className="sftp-entry-meta"><small>{entry.kind === 'DIRECTORY' ? '目录' : entry.kind === 'FILE' ? formatBytes(entry.size) : '不支持'}</small><time>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}</time></span>
        </button></li>)}
      </ul>}
    </div>
  </section>;
}

export function SessionFiles({ connectionId, title, visible, minimize, remove, copy }: {
  connectionId: string; title: string; visible: boolean; minimize: () => void; remove: () => void; copy: (text: string) => void;
}) {
  // This controller remains mounted while minimized, independently of terminal tabs.
  const files = useSftp(connectionId);
  const [root, setRoot] = useState('');
  const [localSelected, setLocalSelected] = useState('');
  const [remoteSelected, setRemoteSelected] = useState('');
  const [conflict, setConflict] = useState<'FAIL' | 'SKIP'>('FAIL');
  const [creating, setCreating] = useState<'local' | 'remote' | null>(null);
  const [name, setName] = useState('');
  const [savingDirectory, setSavingDirectory] = useState(false);
  const ready = files.phase === 'ready';
  const localEntry = files.local?.entries.find(entry => entry.path === localSelected);
  const remoteEntry = files.entries.find(entry => entry.path === remoteSelected);
  if (!visible) return null;
  return <Modal title={`文件管理 · ${title}`} onClose={minimize} className="sftp-modal">
    <div className="session-file-panel sftp-manager">
      <div className="sftp-session-bar"><span><i className={`status-dot ${ready ? '' : 'offline'}`} />{ready ? files.connection : files.phase === 'opening' ? '正在建立文件管理连接…' : files.phase === 'closed' ? '文件管理会话已结束' : '使用已保存的 SSH 配置连接'}</span><div className="inline-actions"><button className="file-mini-action" onClick={minimize}>收起，后台继续</button><button className="file-mini-action" disabled={files.phase === 'opening' || files.phase === 'closing'} onClick={async () => { if (await files.close()) remove(); }}>{files.phase === 'closing' ? '正在关闭…' : '关闭会话并取消传输'}</button></div></div>
      {!ready && files.phase !== 'closing' && <form className="sftp-connect" onSubmit={event => { event.preventDefault(); void files.open(root); }}><label>远程根目录<input value={root} onChange={event => setRoot(event.target.value)} placeholder="留空使用账号默认目录；/ 浏览整个文件系统" disabled={files.phase === 'opening'} /></label><button className="primary-button" disabled={files.phase === 'opening'}>{files.phase === 'opening' ? '连接中…' : files.phase === 'closed' ? '重新打开会话' : '连接文件管理'}</button></form>}
      {files.error && <div className="sftp-error" role="alert"><span>{files.error}</span><IconButton icon="close" label="清除文件管理错误提示" onClick={() => files.setError('')} /></div>}
      <section className="dual-file-explorer" aria-label="本地与远程文件">
        <FileSource side="local" title="本地系统" path={files.local?.path ?? ''} parent={files.local?.parent ?? null} entries={files.local?.entries ?? []} loading={files.localLoading} enabled selected={localSelected} select={setLocalSelected} browse={path => { setLocalSelected(''); void files.loadLocal(path); }} create={() => { setCreating('local'); setName(''); }} copy={copy} />
        <div className="file-transfer-rail" aria-label="文件传输方向">
          <button className="transfer-direction upload" disabled={!ready || files.working || files.localLoading || files.remoteLoading || !localEntry} title="上传选中的本地文件或目录到右侧当前目录" aria-label="上传选中的本地文件或目录" onClick={() => localEntry && void files.transfer('UPLOAD', localEntry.path, files.remotePath, conflict)}><Icon name="right" size={18} /></button>
          <span className="transfer-link" aria-hidden="true"><i /><i /><i /></span>
          <button className="transfer-direction download" disabled={!ready || files.working || files.localLoading || files.remoteLoading || !remoteEntry || !files.local} title="下载选中的远程文件或目录到左侧当前目录" aria-label="下载选中的远程文件或目录" onClick={() => remoteEntry && files.local && void files.transfer('DOWNLOAD', files.local.path, remoteEntry.path, 'FAIL')}><Icon name="left" size={18} /></button>
        </div>
        <FileSource side="remote" title="服务器文件" path={files.remotePath} parent={files.session ? remoteParent(files.remotePath, files.session.rootPath) : null} entries={files.entries} loading={files.remoteLoading} enabled={ready} selected={remoteSelected} select={setRemoteSelected} browse={path => { setRemoteSelected(''); void files.loadRemote(path); }} create={() => { setCreating('remote'); setName(''); }} copy={copy} />
      </section>
      {creating && <form className="sftp-create" onSubmit={async event => { event.preventDefault(); setSavingDirectory(true); if (await files.mkdir(creating, name)) setCreating(null); setSavingDirectory(false); }}><label>{creating === 'local' ? '本地' : '远程'}新目录<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="目录名称" disabled={savingDirectory} /></label><button className="primary-button" disabled={!name.trim() || savingDirectory}>创建</button><button className="outlined-button" disabled={savingDirectory} type="button" onClick={() => setCreating(null)}>取消</button></form>}
      <div className="sftp-transfer-options"><label>上传同名文件<select value={conflict} onChange={event => setConflict(event.target.value as 'FAIL' | 'SKIP')}><option value="FAIL">报错，保留已有文件</option><option value="SKIP">跳过已有文件</option></select></label><span>传输目标为另一侧当前目录 · 下载保留同名文件</span></div>
      <section className="sftp-transfers" aria-label="SFTP 传输任务"><header><strong>传输任务 <small>{files.tasks.length}</small></strong><IconButton icon="refresh" label="查询传输状态" disabled={!ready} onClick={() => void files.refreshTasks()} /></header>
        {files.scanning && <p className="sftp-empty" role="status">{files.scanning}</p>}
        {!files.scanning && !files.tasks.length && <p className="sftp-empty">选择文件或目录，使用中间箭头上传或下载。</p>}
        {files.tasks.map(task => {
          const progress = task.progress;
          const percent = transferPercent(progress);
          const finished = ['COMPLETED', 'CANCELLED'].includes(progress.status);
          const failed = task.items.filter(item => item.status === 'FAILED');
          const received = Object.values(files.localBytes[task.transferId] ?? {}).reduce((sum, bytes) => sum + bytes, 0);
          return <article className={`sftp-task ${progress.status.toLowerCase()}`} key={task.transferId}>
            <div className="sftp-task-title"><span><Icon name={task.direction === 'UPLOAD' ? 'upload' : 'down'} size={14} /><strong>{task.direction === 'UPLOAD' ? '上传' : '下载'}</strong><span title={task.remotePath}>{task.remotePath}</span></span><small>{transferStatus[progress.status] ?? progress.status}</small></div>
            <div className="sftp-task-progress">{percent !== null && <progress max={100} value={percent} aria-label={`${task.direction === 'UPLOAD' ? '上传' : '下载'}字节进度`} />}<span>{percent === null ? `${progress.completedItems} / ${progress.totalItems} 项` : `${percent}% · ${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)}`}</span></div>
            <footer><small>完成 {progress.completedItems}/{progress.totalItems} 项{progress.failedItems > 0 && ` · 失败 ${progress.failedItems} 项`}{progress.awaitingConfirmation > 0 && ` · 待保存确认 ${progress.awaitingConfirmation} 项`}{task.direction === 'DOWNLOAD' && received > 0 && ` · 本机已接收 ${formatBytes(received)}`}{percent === 100 && !finished && ' · 正在提交或等待确认'}</small><div className="inline-actions">{!finished && <><button className="file-mini-action" disabled={!ready || files.working} onClick={() => void files.retry(task.transferId)}>重查并重试</button><button className="file-mini-action" disabled={!ready || files.cancelling.includes(task.transferId)} onClick={() => void files.cancel(task.transferId)}>{files.cancelling.includes(task.transferId) ? '取消中…' : '取消'}</button></>}</div></footer>
            {files.taskErrors[task.transferId] && !finished && <p className="sftp-task-error">{files.taskErrors[task.transferId]}</p>}
            {failed.length > 0 && <details><summary>查看 {failed.length} 个失败条目</summary>{failed.map(item => <p key={item.itemId}>{item.relativePath}：{item.message || item.errorCode || '传输失败'}</p>)}</details>}
          </article>;
        })}
      </section>
    </div>
  </Modal>;
}
