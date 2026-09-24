import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileNode, TransferItem } from '../types';
import { Icon, IconButton } from './Ui';

type FileProps = { files: FileNode[]; selected: string; expanded: Set<string>; select: (id: string) => void; toggle: (id: string) => void };

const localFiles: FileNode[] = [
  { id: 'local:desktop', name: 'Desktop', kind: 'folder', children: [] },
  { id: 'local:downloads', name: 'Downloads', kind: 'folder', children: [{ id: 'local:downloads/nginx.conf', name: 'nginx.conf', kind: 'file' }] },
  { id: 'local:projects', name: 'Projects', kind: 'folder', children: [
    { id: 'local:projects/agent-ssh', name: 'agent-ssh-terminal', kind: 'folder', children: [
      { id: 'local:projects/agent-ssh/src', name: 'src', kind: 'folder', children: [{ id: 'local:projects/agent-ssh/src/App.tsx', name: 'App.tsx', kind: 'file' }] },
      { id: 'local:projects/agent-ssh/package.json', name: 'package.json', kind: 'file' },
      { id: 'local:projects/agent-ssh/README.md', name: 'README.md', kind: 'file' },
    ] },
  ] },
];

function findFile(files: FileNode[], id: string): FileNode | undefined {
  for (const file of files) {
    if (file.id === id) return file;
    const child = findFile(file.children ?? [], id);
    if (child) return child;
  }
}

function TreeNodes({ files, selected, expanded, select, toggle }: FileProps) {
  return <ul className="file-tree" role="tree">{files.map(file => <li key={file.id} role="none"><button role="treeitem" className={`file-row ${selected === file.id ? 'selected' : ''}`} aria-selected={selected === file.id} aria-expanded={file.kind === 'folder' ? expanded.has(file.id) : undefined} onClick={() => { select(file.id); if (file.kind === 'folder') toggle(file.id); }}><span className="tree-chevron">{file.kind === 'folder' && <Icon name={expanded.has(file.id) ? 'down' : 'right'} size={12} />}</span><Icon name={file.kind === 'folder' ? 'folder' : 'file'} className={file.kind === 'folder' ? 'folder-icon' : ''} /><span>{file.name}</span></button>{file.kind === 'folder' && <div className={`file-tree-children ${expanded.has(file.id) ? 'expanded' : ''}`}>{file.children?.length ? <TreeNodes files={file.children} selected={selected} expanded={expanded} select={select} toggle={toggle} /> : <span className="empty-folder">空文件夹</span>}</div>}</li>)}</ul>;
}

function FileSource({ kind, title, subtitle, path, tree, actions, copy }: {
  kind: 'local' | 'remote'; title: string; subtitle: string; path: string; tree: FileProps; actions: ReactNode; copy: (text: string) => void;
}) {
  return <section className={`file-source-card ${kind}`} aria-label={title}>
    <header className="file-source-heading"><span className="file-source-icon"><Icon name={kind === 'local' ? 'monitor' : 'server'} size={16} /></span><span><strong>{title}</strong><small>{subtitle}</small></span><i className="file-source-status" aria-label="可用" /></header>
    <div className="path-bar"><Icon name={kind === 'local' ? 'home' : 'database'} size={15} /><span className="file-current-path" title={path}>{path}</span><IconButton icon="copy" label={`复制${title}路径`} onClick={() => copy(path)} /></div>
    <div className="file-source-actions">{actions}</div>
    <div className="file-list-heading"><span>名称</span><small>{kind === 'local' ? '本机' : 'SFTP'}</small></div>
    <div className="file-tree-scroll"><TreeNodes {...tree} /></div>
  </section>;
}

export function SessionFiles(props: FileProps & { sessionTitle: string; close: () => void; transfers: TransferItem[]; upload: (files: FileList) => void; refresh: () => void; create: () => void; copy: (text: string) => void; notify: (text: string) => void }) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [showAllTransfers, setShowAllTransfers] = useState(false);
  const [localSelected, setLocalSelected] = useState('local:projects/agent-ssh/package.json');
  const [localExpanded, setLocalExpanded] = useState(() => new Set(['local:projects', 'local:projects/agent-ssh']));
  const localTree: FileProps = { files: localFiles, selected: localSelected, expanded: localExpanded, select: setLocalSelected, toggle: id => setLocalExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }) };
  const remoteName = findFile(props.files, props.selected)?.name ?? '所选文件';

  return <aside className="session-file-panel" aria-label={`${props.sessionTitle} 文件面板`}>
    <header className="file-explorer-heading"><span className="file-explorer-title"><span className="file-explorer-mark"><Icon name="folder" size={17} /></span><span><strong>文件管理</strong><small>本地系统与 {props.sessionTitle}</small></span></span><div className="inline-actions"><IconButton icon="refresh" label="刷新本地和远程文件" onClick={() => { props.refresh(); props.notify('已刷新本地与服务器文件列表。'); }} /><IconButton icon="down" label="收起文件面板" onClick={props.close} /></div></header>
    <section id="files" className="dual-file-explorer" tabIndex={-1}>
      <FileSource kind="local" title="本地系统" subtitle="当前设备" path="~/Projects/agent-ssh-terminal" tree={localTree} copy={props.copy} actions={<><button className="file-mini-action" onClick={() => props.notify('本地新建文件将在接入系统文件 API 后启用。')}><Icon name="plus" size={14} />新建</button><IconButton icon="more" label="本地文件更多操作" onClick={() => props.notify('本地文件操作将在接入系统文件 API 后启用。')} /></>} />
      <div className="file-transfer-rail" aria-label="本地与服务器文件传输"><button className="transfer-direction upload" title="上传到服务器" aria-label="上传到服务器" onClick={() => uploadRef.current?.click()}><Icon name="right" size={16} /><span>上传</span></button><span className="transfer-link" aria-hidden="true"><i /><i /><i /></span><button className="transfer-direction download" title="下载到本地" aria-label="下载到本地" onClick={() => props.notify(`准备下载 ${remoteName}；真实下载能力将在接入 SFTP 文件接口后启用。`)}><Icon name="left" size={16} /><span>下载</span></button></div>
      <FileSource kind="remote" title="服务器文件" subtitle={props.sessionTitle} path="/var/www/app" tree={props} copy={props.copy} actions={<><button className="file-mini-action primary" onClick={() => uploadRef.current?.click()}><Icon name="upload" size={14} />上传</button><button className="file-mini-action" onClick={props.create}><Icon name="plus" size={14} />新建</button><IconButton icon="more" label="服务器文件更多操作" onClick={() => props.notify('服务器文件操作在当前会话中模拟；刷新可恢复初始内容。')} /></>} />
    </section>
    <input ref={uploadRef} className="visually-hidden" type="file" multiple aria-label="上传文件选择器" onChange={event => { if (event.target.files?.length) props.upload(event.target.files); event.target.value = ''; }} />
    <details className="transfers" aria-label={`${props.sessionTitle} 文件传输`}><summary className="transfer-heading"><span><Icon name="upload" size={15} /><strong>传输队列</strong></span><small>{props.transfers.length ? `${props.transfers.length} 项` : '暂无任务'}</small><Icon name="down" size={13} /></summary><div className="transfer-content">{props.transfers.length > 2 && <button className="text-button" onClick={() => setShowAllTransfers(value => !value)}>{showAllTransfers ? '收起记录' : `查看全部 (${props.transfers.length})`}</button>}{!props.transfers.length ? <div className="transfer-empty"><p>从两侧选择文件，即可上传或下载</p></div> : <div className="transfer-list">{(showAllTransfers ? props.transfers : props.transfers.slice(-2)).map(transfer => <div className="transfer" key={transfer.id}><div><Icon name="file" size={18} /><span title={transfer.name}>{transfer.name}</span><small>{transfer.progress === 100 ? '已完成' : `${transfer.progress}%`}</small>{transfer.progress === 100 && <span className="small-check"><Icon name="check" size={11} /></span>}</div><progress value={transfer.progress} max={100} aria-label={`${transfer.name} 模拟传输进度`} /></div>)}</div>}</div></details>
  </aside>;
}
