import { useRef, useState } from 'react';
import type { FileNode, TransferItem } from '../types';
import { Icon, IconButton } from './Ui';

type FileProps = { files: FileNode[]; selected: string; expanded: Set<string>; select: (id: string) => void; toggle: (id: string) => void };
function TreeNodes({ files, selected, expanded, select, toggle }: FileProps) {
  return <ul className="file-tree">{files.map(file => <li key={file.id}><button className={`file-row ${selected === file.id ? 'selected' : ''}`} aria-expanded={file.kind === 'folder' ? expanded.has(file.id) : undefined} onClick={() => { select(file.id); if (file.kind === 'folder') toggle(file.id); }}><span className="tree-chevron">{file.kind === 'folder' && <Icon name={expanded.has(file.id) ? 'down' : 'right'} size={12} />}</span><Icon name={file.kind === 'folder' ? 'folder' : 'file'} className={file.kind === 'folder' ? 'folder-icon' : ''} /><span>{file.name}</span></button>{file.kind === 'folder' && expanded.has(file.id) && (file.children?.length ? <TreeNodes files={file.children} selected={selected} expanded={expanded} select={select} toggle={toggle} /> : <span className="empty-folder">空文件夹</span>)}</li>)}</ul>;
}
export function SessionFiles(props: FileProps & { sessionTitle: string; local: boolean; close: () => void; transfers: TransferItem[]; upload: (files: FileList) => void; refresh: () => void; create: () => void; copy: (text: string) => void; notify: (text: string) => void }) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [showAllTransfers, setShowAllTransfers] = useState(false);
  return <aside className="session-file-panel" aria-label={`${props.sessionTitle} 文件面板`}>
    <section id="files" className="files-section" tabIndex={-1}>
      <div className="section-heading"><h2>{props.local ? '本地文件' : '远程文件'}</h2><div className="inline-actions"><IconButton icon="refresh" label="刷新文件树" onClick={props.refresh} /><IconButton icon="down" label="收起文件面板" onClick={props.close} /></div></div>
      <p className="file-panel-description">{props.local ? '管理本地文件，模拟文件传输' : '管理远程文件，模拟 SFTP 文件传输'}</p>
      <div className="path-bar"><Icon name="home" size={18} /><span className="file-current-path">{props.local ? '~' : '/var/www/app'}</span><IconButton icon="copy" label="复制文件路径" onClick={() => props.copy(props.local ? '~' : '/var/www/app')} /></div>
      <div className="file-toolbar"><button className="outlined-button" onClick={() => uploadRef.current?.click()}><Icon name="upload" size={18} />上传</button><button className="outlined-button" onClick={props.create}><Icon name="plus" size={20} />新建<Icon name="down" size={14} /></button><IconButton className="outlined-button" icon="more" label="文件更多操作" onClick={() => props.notify('文件操作在当前会话中模拟；刷新文件树可恢复初始内容。')} /></div>
      <input ref={uploadRef} className="visually-hidden" type="file" multiple aria-label="上传文件选择器" onChange={e => { if (e.target.files?.length) props.upload(e.target.files); e.target.value = ''; }} />
      <div className="file-list-heading"><span>名称</span><Icon name="file" size={14} /></div>
      <div className="file-tree-scroll"><TreeNodes {...props} /></div>
    </section>
    <section className="transfers" aria-label={`${props.sessionTitle} 文件传输`}>
      <div className="transfer-heading"><h3>文件传输</h3>{props.transfers.length > 2 && <button className="text-button" onClick={() => setShowAllTransfers(value => !value)}>{showAllTransfers ? '收起记录' : `查看全部 (${props.transfers.length})`}<Icon name="right" size={14} /></button>}</div>
      {!props.transfers.length ? <div className="transfer-empty"><div><span><Icon name="upload" size={18} /></span><strong>暂无传输任务</strong></div><p>当前终端的文件传输会显示在这里</p></div> : <div className="transfer-list">{(showAllTransfers ? props.transfers : props.transfers.slice(-2)).map(transfer => <div className="transfer" key={transfer.id}><div><Icon name="file" size={18} /><span title={transfer.name}>{transfer.name}</span><small>{transfer.progress === 100 ? '已完成' : `${transfer.progress}%`}</small>{transfer.progress === 100 && <span className="small-check"><Icon name="check" size={11} /></span>}</div><progress value={transfer.progress} max={100} aria-label={`${transfer.name} 模拟传输进度`} /></div>)}</div>}
      <button className="deploy-button" onClick={() => uploadRef.current?.click()}><Icon name="upload" size={18} />新建传输任务</button>
    </section>
  </aside>;
}
