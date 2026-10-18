import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatAttachment } from '../types';
import type { UploadItem } from '../state/fileUploads';
import type { ChatAttachmentDraft } from '../state/chatAttachments';
import { isImageAttachment, textExcerptLabel } from '../state/chatAttachments';
import { formatFileSize } from '../config/fileUpload';
import { DownloadButton } from './DownloadButton';
import { CopyTextButton } from './CopyTextButton';
import { Badge, Icon, IconButton, Modal, fileTone } from './Ui';
import { agentApi } from '../api/agent';
import { type NativeAttachmentProgress, readNativeAttachmentPreview } from '../api/files';
import './ChatAttachments.css';

function Preview({ name, url }: { name: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className="chat-attachment-preview" data-accent={fileTone(name)}>{url && !failed
    ? <img src={url} alt={name} onError={() => setFailed(true)} /> : <Icon name="file" size={22} />}</span>;
}
/** Indeterminate activity: preparation has no trustworthy byte percentage. */
export function AttachmentProgress({name}:{name:string}) {
  return <span className="chat-attachment-progress" role="progressbar" aria-label={`正在准备附件 ${name}`} aria-valuetext="正在准备">
    <svg viewBox="0 0 36 36" aria-hidden="true"><circle className="attachment-progress-track" cx="18" cy="18" r="14"/><circle className="attachment-progress-arc" cx="18" cy="18" r="14"/></svg>
  </span>;
}
type AttachmentScope = {agentId:string;sessionId:string};
/** A thumbnail loads the prepared session snapshot, including after the original upload is removed. */
export function AttachmentImage({file,scope,preparing=false}: {file:Pick<ChatAttachment,'fileId'|'fileName'|'previewUrl'>;scope?:AttachmentScope;preparing?:boolean}) {
  const key=JSON.stringify([scope?.agentId,scope?.sessionId,file.fileId,file.fileName]);
  const [resource,setResource]=useState<{key:string;url?:string;error?:string}|null>(null);
  const [attempt,setAttempt]=useState(0);
  const [opened,setOpened]=useState<string|null>(null);
  const [loadedUrl,setLoadedUrl]=useState<string|null>(null);
  useEffect(()=>{
    let active=true;
    setResource(null);setOpened(null);
    if(file.previewUrl&&attempt===0){setResource({key,url:file.previewUrl});return;}
    if(!file.fileId)return;
    const request=scope?agentApi.attachment(scope.agentId,scope.sessionId,file.fileId).then(value=>{
      if(!value.imageUrl)throw new Error('此附件没有可预览的图片');return value.imageUrl;
    }):readNativeAttachmentPreview(file.fileId);
    void request.then(url=>{if(active)setResource({key,url});}).catch(error=>{if(active)setResource({key,error:error instanceof Error?error.message:'图片读取失败'});});
    return()=>{active=false;};
  },[key,file.previewUrl,attempt]);
  const current=resource?.key===key?resource:null;
  const url=current?.url;
  return <div className="chat-image-attachment">
    <button type="button" className={`chat-image-thumbnail${current?.error?' failed':''}`} aria-label={`${current?.error?'重新加载':'预览图片'} ${file.fileName}`} title={current?.error??file.fileName}
      onClick={()=>{if(current?.error)setAttempt(value=>value+1);else if(url)setOpened(key);}}>
      {url?<img src={url} alt={file.fileName} onLoad={()=>setLoadedUrl(url)} onError={()=>setResource({key,error:'图片加载失败，点击重试'})}/>:<span>{current?.error&&<span role="alert"><Icon name="refresh" size={22}/>加载失败，点击重试</span>}</span>}
      {!current?.error&&(preparing||!url||loadedUrl!==url)&&<AttachmentProgress name={file.fileName}/>}
    </button>
    {opened===key&&url&&<Modal icon="file" iconTone="violet" title={file.fileName} onClose={()=>setOpened(null)} className="chat-attachment-dialog" wide><img src={url} alt={file.fileName}/></Modal>}
  </div>;
}
export function DraftAttachments({ items, pending=[], draft, locked, report }: { pending?:readonly NativeAttachmentProgress[]; items: readonly UploadItem[]; draft: ChatAttachmentDraft; locked: boolean; report: (error: string) => void }) {
  return <ul className="chat-draft-attachments" aria-label="本次消息附件">{items.map(item => <li className={`chat-attachment ${item.status}${isImageAttachment(item.name)&&item.status!=='error'?' chat-draft-image':''}`} key={item.id}>
    <div className="chat-attachment-visual">{isImageAttachment(item.name)?<AttachmentImage file={{fileId:item.result?.fileId??'',fileName:item.name,previewUrl:item.previewUrl}} preparing={item.status==='queued'||item.status==='uploading'}/>:<><Preview name={item.name}/>{(item.status==='queued'||item.status==='uploading')&&<AttachmentProgress name={item.name}/>}</>}</div>
    <div className="chat-attachment-body"><strong title={item.textExcerpt?.preview ?? item.name}>{item.textExcerpt?.preview || item.name}</strong><small className="chat-attachment-meta">{item.textExcerpt ? `${textExcerptLabel(item.textExcerpt.source)} · ${item.textExcerpt.characters} 字符` : formatFileSize(item.size)}
      <Badge tone={item.status === 'success' ? 'success' : item.status === 'error' ? 'danger' : item.status === 'queued' ? 'amber' : 'blue'}
        icon={item.status === 'success' ? 'check' : item.status === 'error' ? 'alert' : item.status === 'queued' ? 'history' : 'refresh'}>
        {item.status === 'success' ? item.textExcerpt || item.referenced ? '已附加' : '待解析' : item.status === 'uploading' ? item.textExcerpt ? '正在添加文本' : '上传中' : item.status === 'queued' ? '等待上传' : '上传失败'}
      </Badge></small>
      {item.error && <p role="alert">{item.error}</p>}
      {item.uncertain && <p>重试可能产生新文件。</p>}
      {item.status === 'error' && <button type="button" disabled={locked} onClick={() => { try { draft.retry(item.id); report(''); } catch (error) { report((error as Error).message); } }}>重试上传</button>}
    </div>
    <IconButton icon="close" label={`移除附件 ${item.name}`} disabled={locked} onClick={() => { draft.remove(item.id); report(''); }} />
  </li>)}{pending.map(item=><li className={`chat-attachment uploading${isImageAttachment(item.fileName)?' chat-draft-image':''}`} key={`native:${item.id}`} title={item.fileName} aria-busy="true">
    <div className="chat-attachment-visual"><Preview name={item.fileName}/><AttachmentProgress name={item.fileName}/></div>
    <div className="chat-attachment-body"><strong title={item.fileName}>{item.fileName}</strong>{item.size>0&&<small>{formatFileSize(item.size)}</small>}</div>
  </li>)}</ul>;
}
export function MessageAttachments({ files, scope }: { files: ChatAttachment[]; scope?:AttachmentScope }) {
  const [preview,setPreview]=useState<{id:string;key:string;name:string;size:number;pdf:boolean;loading:boolean;text?:string;imageUrl?:string;error?:string}|null>(null);
  const [wrap,setWrap]=useState(false);
  useEffect(()=>setPreview(null),[scope?.sessionId,scope?.agentId]);
  const open=(file:ChatAttachment)=>{
    if(!scope)return;
    const key=JSON.stringify([scope.agentId,scope.sessionId,file.fileId]);
    const pdf=file.contentType==='application/pdf'||/\.pdf$/i.test(file.fileName);
    setWrap(pdf);
    setPreview({id:file.fileId,key,name:file.fileName,size:file.size,pdf,loading:true});
    void agentApi.attachment(scope.agentId,scope.sessionId,file.fileId).then(value=>setPreview(current=>current?.key===key?{...current,loading:false,text:value.text??undefined,imageUrl:value.imageUrl??undefined}:current)).catch(error=>setPreview(current=>current?.key===key?{...current,loading:false,error:error instanceof Error?error.message:'附件读取失败'}:current));
  };
  return <><div className="chat-message-attachments">
    {files.some(file=>isImageAttachment(file.fileName))&&<div className="chat-message-images">{files.filter(file=>isImageAttachment(file.fileName)).map(file=><AttachmentImage key={file.fileId} file={file} scope={scope}/>)}</div>}
    {files.filter(file=>!isImageAttachment(file.fileName)).map((file, index) => <div className="chat-attachment chat-message-file" key={`${file.fileId}:${index}`}>
    <button type="button" className="chat-file-preview-button" aria-label={`查看文件 ${file.fileName}`} disabled={!scope} onClick={()=>open(file)}>
      <Preview name={file.fileName} url={file.previewUrl} />
      <span className="chat-attachment-body"><strong title={file.textExcerpt?.preview ?? file.fileName}>{file.textExcerpt?.preview || file.fileName}</strong><small>{file.textExcerpt ? `${textExcerptLabel(file.textExcerpt.source)} · ${file.textExcerpt.characters} 字符` : formatFileSize(file.size)}</small></span>
    </button>
    {file.downloadUrl && file.urlExpiresAt !== undefined && <div className="chat-attachment-actions"><DownloadButton file={{ downloadUrl: file.downloadUrl, urlExpiresAt: file.urlExpiresAt }} /></div>}
  </div>)}</div>{preview&&createPortal(<Modal icon="file" iconTone="rose" title={preview.name} onClose={()=>setPreview(null)} className="chat-document-dialog" wide>
    <div className="chat-document-toolbar">
      <div className="chat-document-info"><Icon name="file" size={15}/><span>{preview.pdf?'PDF 文本':'文本'}</span><span>{formatFileSize(preview.size)}</span>{preview.text!==undefined&&<span>{preview.text.length?preview.text.split(/\r\n|\r|\n/).length:0} 行</span>}</div>
      {!preview.loading&&!preview.error&&preview.text!==undefined&&!preview.imageUrl&&<div className="chat-document-tools">
        <button type="button" className="chat-document-wrap" aria-pressed={wrap} onClick={()=>setWrap(value=>!value)}>自动换行</button>
        <CopyTextButton getText={()=>preview.text??''} label="复制全文" hint={{}}/>
      </div>}
    </div>
    <div className="chat-document-content" tabIndex={0} role="region" aria-label="文件内容" aria-busy={preview.loading}>
      {preview.loading?<div className="chat-document-state" role="status"><span className="chat-document-spinner" aria-hidden="true"/><p>正在读取文件…</p></div>
        :preview.error?<div className="chat-document-state"><Icon name="alert" size={26}/><p role="alert">{preview.error}</p><button type="button" className="outlined-button" onClick={()=>{const file=files.find(file=>file.fileId===preview.id);if(file)open(file);}}><Icon name="refresh" size={14}/>重新加载</button></div>
        :preview.imageUrl?<img src={preview.imageUrl} alt={preview.name}/>:<pre className={wrap?'is-wrapped':undefined}>{preview.text}</pre>}
    </div>
    {preview.pdf&&<footer className="chat-document-note">PDF 提取文本，不包含图表和扫描识别内容。</footer>}
  </Modal>,document.body)}</>;
}
