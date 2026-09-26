import { useEffect, useState } from 'react';
import type { ChatAttachment } from '../types';
import type { UploadItem } from '../state/fileUploads';
import type { ChatAttachmentDraft } from '../state/chatAttachments';
import { formatFileSize } from '../config/fileUpload';
import { DownloadButton } from './FileUploadDialog';
import { Icon, IconButton } from './Ui';
import './ChatAttachments.css';

function Preview({ name, url }: { name: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className="chat-attachment-preview">{url && !failed
    ? <img src={url} alt={name} onError={() => setFailed(true)} /> : <Icon name="file" size={22} />}</span>;
}
export function DraftAttachments({ items, draft, locked, report }: { items: readonly UploadItem[]; draft: ChatAttachmentDraft; locked: boolean; report: (error: string) => void }) {
  return <ul className="chat-draft-attachments" aria-label="本次消息附件">{items.map(item => <li className={`chat-attachment ${item.status}`} key={item.id}>
    <Preview name={item.name} url={item.previewUrl} />
    <div className="chat-attachment-body"><strong title={item.name}>{item.name}</strong><small>{formatFileSize(item.size)} · {item.status === 'success' ? item.referenced ? '已附加' : '上传成功' : item.status === 'uploading' ? '上传中' : item.status === 'queued' ? '等待上传' : '上传失败'}</small>
      {item.status === 'uploading' && <i className="file-upload-spinner" aria-label="正在上传" />}
      {item.error && <p role="alert">{item.error}</p>}
      {item.uncertain && <p>重试可能产生新文件。</p>}
      {item.status === 'error' && <button type="button" disabled={locked} onClick={() => { try { draft.retry(item.id); report(''); } catch (error) { report((error as Error).message); } }}>重试上传</button>}
    </div>
    <IconButton icon="close" label={`移除附件 ${item.name}`} disabled={locked} onClick={() => { draft.remove(item.id); report(''); }} />
  </li>)}</ul>;
}
export function MessageAttachments({ files, attach, disabled }: { files: ChatAttachment[]; attach: (files: ChatAttachment[]) => void; disabled: boolean }) {
  return <div className="chat-message-attachments">{files.map((file, index) => <div className="chat-attachment" key={`${file.fileId}:${index}`}>
    <Preview name={file.fileName} url={file.previewUrl} />
    <div className="chat-attachment-body"><strong title={file.fileName}>{file.fileName}</strong><small>{formatFileSize(file.size)}</small>
      <div className="chat-attachment-actions"><button type="button" disabled={disabled} onClick={() => attach([file])}><Icon name="plus" size={12} />再次附加</button>
        {file.downloadUrl && file.urlExpiresAt !== undefined && <DownloadButton file={{ downloadUrl: file.downloadUrl, urlExpiresAt: file.urlExpiresAt }} />}
      </div>
    </div>
  </div>)}</div>;
}
