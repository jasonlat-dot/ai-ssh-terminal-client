import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { downloadExpiresAt, downloadUnavailable } from '../api/files';
import type { UploadedFile } from '../api/files';
import { fileUploadPolicy, formatFileSize } from '../config/fileUpload';
import type { FileUploadQueue, UploadItem } from '../state/fileUploads';
import { isTauriRuntime } from '../state/runtime';
import { Icon, IconButton, Modal } from './Ui';
import './FileUploadDialog.css';

function DownloadButton({ file }: { file: UploadedFile }) {
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const unavailable = downloadUnavailable(file, now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const expiry = downloadExpiresAt(file.urlExpiresAt);
    // Refresh at expiration, after OS sleep, or when returning from the browser.
    const timer = expiry === null || expiry <= now ? undefined : setTimeout(update, Math.min(Math.max(0, expiry - Date.now()), 2_147_483_647));
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [file.urlExpiresAt, now]);
  const download = (event: MouseEvent<HTMLAnchorElement>) => {
    setError('');
    const expired = downloadUnavailable(file);
    if (expired) { event.preventDefault(); setNow(Date.now()); return; }
    if (isTauriRuntime()) {
      event.preventDefault();
      void openUrl(file.downloadUrl).catch(() => setError('无法打开下载地址，请检查系统浏览器。'));
    }
  };
  return <span className="uploaded-download">
    {unavailable ? <small>{unavailable}</small> : <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer" onClick={download} className="file-download-button"><Icon name="down" size={14} />下载</a>}
    {error && <small role="alert">{error}</small>}
  </span>;
}

function UploadRow({ item, queue }: { item: UploadItem; queue: FileUploadQueue }) {
  const labels = { queued: '等待上传', uploading: '上传中', success: '上传成功', error: '上传失败' };
  return <li className={`file-upload-item ${item.status}`}>
    <div className="upload-item-heading">
      <span className="upload-file-icon"><Icon name="file" size={19} /></span>
      <span className="upload-file-name"><strong title={item.result?.fileName ?? item.name}>{item.result?.fileName ?? item.name}</strong><small>{formatFileSize(item.result?.size ?? item.size)}</small></span>
      <span className="upload-item-status" role="status">{item.status === 'uploading' ? <i className="file-upload-spinner" aria-hidden="true" /> : item.status === 'success' ? <Icon name="check" size={13} /> : null}{labels[item.status]}</span>
      <IconButton icon="close" label={`从列表移除 ${item.name}（不删除服务器文件）`} disabled={item.status === 'uploading'} onClick={() => queue.remove(item.id)} />
    </div>
    {item.error && <p className="upload-item-error" role="alert">{item.error}</p>}
    {item.uncertain && <p className="upload-uncertain">后端可能已保存文件，再次上传可能产生新文件。</p>}
    {item.result && <details className="upload-result-details"><summary>文件信息</summary><dl>
      <dt>文件 ID</dt><dd>{item.result.fileId}</dd>
      <dt>类型</dt><dd>{item.result.contentType}</dd>
      <dt>存储状态</dt><dd>{item.result.status} · 已存储</dd>
      <dt>SHA-256</dt><dd>{item.result.sha256}</dd>
      <dt>下载有效期至</dt><dd>{downloadExpiresAt(item.result.urlExpiresAt) === null ? String(item.result.urlExpiresAt) : new Date(downloadExpiresAt(item.result.urlExpiresAt)!).toLocaleString()}</dd>
    </dl><p>已存储不代表已完成内容解析或安全扫描。</p></details>}
    {(item.result || (item.status === 'error' && item.retryable)) && <div className="upload-item-actions">
      {item.status === 'error' && item.retryable && <button type="button" className="outlined-button" onClick={() => queue.retry(item.id)}><Icon name="refresh" size={13} />{item.uncertain ? '重新上传（可能重复）' : '重试上传'}</button>}
      {item.result && <DownloadButton file={item.result} />}
    </div>}
  </li>;
}

export function FileUploadDialog({ queue, close }: { queue: FileUploadQueue; close: () => void }) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState('');
  const uploading = items.filter(item => item.status === 'uploading').length;
  return <Modal title="文件上传" className="file-upload-modal" onClose={close}>
    <div className="file-upload-content">
      <p className="file-upload-intro">选择本地文件上传到文件服务，上传结果独立保留，不会自动发送到对话。</p>
      <button type="button" data-autofocus className="file-upload-picker" onClick={() => input.current?.click()}>
        <span className="file-upload-picker-icon"><Icon name="upload" size={22} /></span>
        <strong>选择文件并上传</strong><span>支持多选 · 单文件上限 {formatFileSize(fileUploadPolicy.maxBytes)}</span>
      </button>
      <input ref={input} type="file" multiple tabIndex={-1} className="visually-hidden" accept={fileUploadPolicy.extensions.map(extension => `.${extension}`).join(',')} aria-label="选择上传文件" onChange={event => {
        if (event.target.files?.length) {
          const duplicates = queue.add(Array.from(event.target.files));
          setNotice(duplicates ? `已忽略 ${duplicates} 个列表中的重复文件；失败文件可点击重试。` : '');
        }
        event.target.value = '';
      }} />
      <details className="upload-supported-types"><summary>支持的文件类型</summary><p>{fileUploadPolicy.extensions.join('、')}</p></details>
      {notice && <p className="upload-selection-notice" role="status">{notice}</p>}
      <div className="upload-list-heading"><strong>上传记录 <small>{items.length}</small></strong><span>{uploading ? `${uploading} 个文件上传中` : '每个文件独立上传'}</span></div>
      {items.length ? <ul className="file-upload-list">{items.map(item => <UploadRow item={item} queue={queue} key={item.id} />)}</ul>
        : <div className="file-upload-empty"><Icon name="file" size={26} /><p>还没有上传文件</p><small>选择文件后，上传状态和下载入口会显示在这里。</small></div>}
    </div>
    <footer><p>下载链接临时有效，过期后不可下载。移除只清理此列表。</p><button type="button" className="outlined-button" onClick={close}>完成</button></footer>
  </Modal>;
}
