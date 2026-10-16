import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { downloadUnavailable, nativeAttachmentReference, saveNativeAttachment, type UploadedFile } from '../api/files';
import { Icon } from './Ui';
import './DownloadButton.css';

/** The chat attachment download action is independent of any file-management UI. */
export function DownloadButton({ file }: { file: Pick<UploadedFile, 'urlExpiresAt' | 'downloadUrl'> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const currentUrl = useRef(file.downloadUrl);
  currentUrl.current = file.downloadUrl;
  useEffect(() => { setError(''); }, [file.downloadUrl]);
  const unavailable = downloadUnavailable(file);
  const download = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const reference = nativeAttachmentReference(file.downloadUrl);
    if (!reference || pending.current || downloadUnavailable(file)) return;
    const url = file.downloadUrl;
    pending.current = true; setBusy(true); setError('');
    try { await saveNativeAttachment(reference.fileId, reference.backendUrl); }
    catch (cause) {
      if (currentUrl.current === url) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { pending.current = false; setBusy(false); }
  };
  return <span className="uploaded-download">
    {unavailable ? <small>{unavailable}</small> : <a href={file.downloadUrl} onClick={download}
      aria-disabled={busy} aria-busy={busy} className="file-download-button"><Icon name="down" size={14}/>{busy ? '正在保存…' : '下载'}</a>}
    {error && <small role="alert">{error}</small>}
  </span>;
}
