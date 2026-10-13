import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { downloadExpiresAt, downloadUnavailable, readUploadedFile, listUploadedFiles, deleteUploadedFile, readFileStorageStats } from '../api/files';
import type { UploadedFile, FileStorageStats } from '../api/files';
import { fileUploadPolicy, formatFileSize } from '../config/fileUpload';
import type { FileUploadQueue, UploadItem } from '../state/fileUploads';
import { isTauriRuntime } from '../state/runtime';
import { usingRustBuiltinBackend } from '../config/rustPreview';
import { AccentIcon, Badge, Icon, IconButton, Modal, fileTone } from './Ui';
import './FileUploadDialog.css';

export function DownloadButton({ file, refreshable = false }: {
  file: Pick<UploadedFile, 'urlExpiresAt' | 'downloadUrl'> & { fileId?: string }; refreshable?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<UploadedFile | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setFresh(null); setError(''); setNow(Date.now()); }, [file.downloadUrl, file.fileId]);
  const current = fresh ?? file;
  const unavailable = downloadUnavailable(current, now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const expiry = downloadExpiresAt(current.urlExpiresAt);
    const timer = expiry === null || expiry <= now ? undefined : setTimeout(update, Math.min(Math.max(0, expiry - Date.now()), 2_147_483_647));
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [current.urlExpiresAt, now]);
  const refresh = async () => {
    if (!file.fileId) return;
    setBusy(true); setError('');
    try { setFresh(await readUploadedFile(file.fileId)); setNow(Date.now()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '刷新失败'); }
    finally { setBusy(false); }
  };
  const download = (event: MouseEvent<HTMLAnchorElement>) => {
    setError('');
    if (downloadUnavailable(current)) { event.preventDefault(); setNow(Date.now()); return; }
    if (isTauriRuntime()) {
      event.preventDefault();
      void openUrl(current.downloadUrl).catch(() => setError('无法打开下载地址，请检查系统浏览器。'));
    }
  };
  return <span className="uploaded-download">
    {unavailable ? <><small>{unavailable}</small>{refreshable && file.fileId && <button type="button" className="outlined-button" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={13}/>{busy ? '刷新中' : '刷新链接'}</button>}</>
      : <a href={current.downloadUrl} target="_blank" rel="noopener noreferrer" onClick={download} className="file-download-button"><Icon name="down" size={14}/>下载</a>}
    {error && <small role="alert">{error}</small>}
  </span>;
}
function UploadRow({ item, queue, rust }: { item: UploadItem; queue: FileUploadQueue; rust: boolean }) {
  const labels = { queued: '等待上传', uploading: '上传中', success: '上传成功', error: '上传失败' };
  return <li className={'file-upload-item ' + item.status}>
    <div className="upload-item-heading">
      <AccentIcon icon="file" tone={fileTone(item.name)} className="upload-file-icon" size={19}/>
      <span className="upload-file-name"><strong title={item.result?.fileName ?? item.name}>{item.result?.fileName ?? item.name}</strong><small>{formatFileSize(item.result?.size ?? item.size)}</small></span>
      <Badge className="upload-item-status" role="status" tone={item.status === 'success' ? 'success' : item.status === 'error' ? 'danger' : item.status === 'queued' ? 'amber' : 'blue'}>{item.status === 'uploading' && <i className="file-upload-spinner" aria-hidden="true"/>}{labels[item.status]}</Badge>
      <IconButton icon="close" label={'从列表移除 ' + item.name + '（不删除存储文件）'} disabled={item.status === 'uploading'} onClick={() => queue.remove(item.id)}/>
    </div>
    {item.error && <p className="upload-item-error" role="alert">{item.error}</p>}
    {item.uncertain && <p className="upload-uncertain">后端可能已保存文件，再次上传可能产生新文件。</p>}
    {item.result && <details className="upload-result-details"><summary>文件信息</summary><dl>
      <dt>文件 ID</dt><dd>{item.result.fileId}</dd><dt>类型</dt><dd>{item.result.contentType}</dd><dt>存储状态</dt><dd>UPLOADED · 已存储</dd>
      <dt>SHA-256</dt><dd>{item.result.sha256 || '后端未提供'}</dd><dt>下载有效期至</dt><dd>{downloadExpiresAt(item.result.urlExpiresAt) === null ? String(item.result.urlExpiresAt) : new Date(downloadExpiresAt(item.result.urlExpiresAt)!).toLocaleString()}</dd>
    </dl><p>已存储不代表已完成内容解析。</p></details>}
    <div className="upload-item-actions">
      {item.status === 'error' && item.retryable && <button type="button" className="outlined-button" onClick={() => queue.retry(item.id)}><Icon name="refresh" size={13}/>{item.uncertain ? '重新上传（可能重复）' : '重试上传'}</button>}
      {item.result && <DownloadButton file={item.result} refreshable={rust}/>}
    </div>
  </li>;
}
export function FileUploadDialog({ queue, close }: { queue: FileUploadQueue; close: () => void }) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  const rust = usingRustBuiltinBackend();
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'upload' | 'stored'>('upload');
  const [stored, setStored] = useState<UploadedFile[]>([]);
  const [stats, setStats] = useState<FileStorageStats | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<UploadedFile | null>(null);
  useEffect(() => {
    if (!rust) return;
    let active = true;
    void readFileStorageStats().then(value => { if (active) setStats(value); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [rust, items, refresh]);
  useEffect(() => {
    if (!rust || tab !== 'stored') return;
    let active = true; setBusy(true); setError('');
    void listUploadedFiles(offset).then(page => { if (active) { setStored(page.items); setHasMore(page.hasMore); } })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [rust, tab, offset, refresh]);
  const removeStored = async () => {
    if (!deleteTarget) return;
    setBusy(true); setError('');
    try {
      await deleteUploadedFile(deleteTarget.fileId);
      items.filter(item => item.result?.fileId === deleteTarget.fileId).forEach(item => queue.remove(item.id));
      setDeleteTarget(null); setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Modal title="文件与附件" className="file-upload-modal" onClose={close}>
    <div className="file-upload-content">
      <p className="file-upload-intro">{rust ? '附件存到本机试用数据目录，不需要 SSH 连接。上传后可下载和管理，AI 对话将在下一阶段接入。' : '选择本地文件上传到文件服务，上传结果不会自动发送到对话。'}</p>
      {rust && <><div className="file-upload-tabs"><button type="button" className={tab === 'upload' ? 'selected' : ''} onClick={() => setTab('upload')}>上传记录</button><button type="button" className={tab === 'stored' ? 'selected' : ''} onClick={() => { setTab('stored'); setRefresh(value => value + 1); }}>已存储文件</button></div>
        {stats && <p className="file-storage-summary">{stats.enabled ? '本地存储' : '附件存储已关闭'} · {formatFileSize(stats.usedBytes)} / {formatFileSize(stats.maxStorageBytes)} · {stats.fileCount} 个文件{stats.reservedBytes > 0 ? ' · 上传预留 ' + formatFileSize(stats.reservedBytes) : ''}<br/>{stats.retentionDays ? '保留 ' + stats.retentionDays + ' 天后自动清理' : '文件长期保留，可手动删除'} · 下载链接 {Math.round(stats.downloadLinkSeconds / 60)} 分钟有效</p>}</>}
      {error && <p role="alert" className="upload-item-error">{error}</p>}
      {tab === 'upload' && <>
        <button type="button" data-autofocus className="file-upload-picker" onClick={() => input.current?.click()} disabled={rust && stats?.enabled === false}>
          <span className="file-upload-picker-icon"><Icon name="upload" size={22}/></span><strong>选择文件并上传</strong><span>支持多选 · 单文件上限 {formatFileSize(fileUploadPolicy.maxBytes)}</span>
        </button>
        <input ref={input} type="file" multiple tabIndex={-1} className="visually-hidden" accept={fileUploadPolicy.extensions.map(extension => '.' + extension).join(',')} aria-label="选择上传文件" onChange={event => {
          if (event.target.files?.length) { const duplicates = queue.add(Array.from(event.target.files)); setNotice(duplicates ? '已忽略 ' + duplicates + ' 个重复文件，失败记录可手动重试。' : ''); }
          event.target.value = '';
        }}/>
        <details className="upload-supported-types"><summary>支持的文件类型</summary><p>{fileUploadPolicy.extensions.join('、')}</p></details>
        {notice && <p role="status" className="upload-selection-notice">{notice}</p>}
        <div className="upload-list-heading"><strong>上传记录 <Badge tone="rose">{items.length}</Badge></strong><span>{items.filter(item => item.status === 'uploading').length} 个文件上传中</span></div>
        {items.length ? <ul className="file-upload-list">{items.map(item => <UploadRow key={item.id} item={item} queue={queue} rust={rust}/>)}</ul> : <div className="file-upload-empty"><Icon name="file" size={26}/><p>还没有上传文件</p></div>}
      </>}
      {tab === 'stored' && <>
        <div className="upload-list-heading"><strong>已存储文件</strong><button type="button" className="outlined-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新</button></div>
        {busy && <p role="status">正在读取…</p>}
        <ul className="file-upload-list">{stored.map(file => <li key={file.fileId} className="file-upload-item">
          <div className="upload-item-heading"><AccentIcon icon="file" tone={fileTone(file.fileName)} size={19}/><span className="upload-file-name"><strong>{file.fileName}</strong><small>{formatFileSize(file.size)}</small></span></div>
          <div className="upload-item-actions"><DownloadButton file={file} refreshable/><button type="button" className="outlined-button" disabled={busy} onClick={() => setDeleteTarget(file)}>删除存储文件</button></div>
        </li>)}</ul>
        {!busy && !stored.length && <p className="file-upload-intro">此页没有已存储附件。</p>}
        <div className="upload-item-actions"><button type="button" className="outlined-button" disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button><button type="button" className="outlined-button" disabled={busy || !hasMore} onClick={() => setOffset(value => value + 20)}>下一页</button></div>
        {deleteTarget && <div className="file-delete-confirm" role="alert"><p>删除「{deleteTarget.fileName}」的存储文件？删除后下载链接将失效。</p><button type="button" className="outlined-button" disabled={busy} onClick={() => void removeStored()}>确认删除</button><button type="button" className="outlined-button" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</button></div>}
      </>}
    </div>
    <footer><p>{rust ? '上传记录里的移除只清理列表；已存储文件可删除并释放容量。' : '下载链接临时有效，移除只清理此列表。'}</p><button type="button" className="outlined-button" onClick={close}>完成</button></footer>
  </Modal>;
}
