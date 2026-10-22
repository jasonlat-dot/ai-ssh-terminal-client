import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sftpApi } from '../api/sftp';
import { notify } from '../state/notifications';
import { createSidebarTransfer } from '../state/terminalUpload';
import type { TerminalTransferRequest } from '../state/terminalUpload';
import type { TerminalRuntime } from '../state/terminalRuntime';
import type { DirectoryListing, TerminalDirectory } from '../state/terminalDirectory';
import { directoryChild, directoryParent, readDirectoryFollow, saveDirectoryFollow } from '../state/terminalDirectory';
import { resourceBytes } from '../state/terminalResources';
import { Icon, IconButton } from './Ui';
import './TerminalFileSidebar.css';

const emptyDirectory: TerminalDirectory = { path: '', revision: 0 };
const noSubscribe = () => () => {};
const noDirectory = () => emptyDirectory;

/** A terminal owns its directory signal. The browser never writes commands into its shell. */
export function TerminalFileSidebar({ runtime, terminalId, title, local, connected, visible, openFiles, transfer, copy }: {
  runtime?: TerminalRuntime; terminalId: string; title?: string; local: boolean; connected: boolean; visible: boolean;
  transfer: (request: TerminalTransferRequest) => void;
  openFiles: () => void; copy: (path: string) => Promise<void>;
}) {
  const directory = useSyncExternalStore(runtime?.subscribeDirectory ?? noSubscribe, runtime?.directorySnapshot ?? noDirectory);
  const [follow, setFollow] = useState(readDirectoryFollow);
  const [manualPath, setManualPath] = useState('');
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState('');
  const [showHidden, setShowHidden] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [revision, refresh] = useState(0);
  const [page, setPage] = useState<{ listing: DirectoryListing | null; loading: boolean; error: string; scope?: string }>({ listing: null, loading: false, error: '' });
  const enabled = !!runtime?.directoryList && !local && connected && visible && pageVisible;
  const path = follow ? directory.path : manualPath;
  const promptRevision = follow ? directory.revision : 0;
  const scope = directory.accessKey || '';
  const [choosing, setChoosing] = useState(false);
  const alive = useRef(false), choosingLock = useRef(false);
  const transferState = useRef({ runtime, path, scope, selected, enabled });
  transferState.current = { runtime, path, scope, selected, enabled };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!enabled || !runtime?.directoryList) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    let busy = false;
    const cancel = () => { clearTimeout(timer); controller?.abort(); };
    const load = async () => {
      if (disposed || document.hidden || busy) return;
      busy = true; controller = new AbortController();
      setPage(previous => ({ ...previous, loading: true, error: '' }));
      try {
        const listing = await runtime.directoryList!(path, controller.signal);
        if (!disposed && !controller.signal.aborted) setPage({ listing, loading: false, error: '', scope });
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setPage({ listing: null, loading: false,
          error: error instanceof Error ? error.message : '无法读取目录，请检查连接和权限。', scope });
      } finally {
        busy = false;
        if (!disposed && !document.hidden) timer = setTimeout(load, 5000);
      }
    };
    setPage(previous => ({ listing: previous.scope === scope && previous.listing?.path === path ? previous.listing : null, loading: true, error: '', scope })); setSelected('');
    // Merge successive prompt notifications before requesting an SFTP channel.
    timer = setTimeout(load, 150);
    return () => { disposed = true; cancel(); };
  }, [enabled, runtime, path, follow, promptRevision, revision, scope]);
  useEffect(() => { setInput(page.listing?.path || path); }, [page.listing?.path, path]);

  const changeFollow = (value: boolean) => {
    if (!value) setManualPath(page.listing?.path || directory.path);
    setFollow(value); saveDirectoryFollow(value); setSelected('');
  };
  const browse = (target: string) => {
    if (!target.startsWith('/') || /[\x00-\x1f\x7f]/.test(target)) return;
    setFollow(false); saveDirectoryFollow(false); setManualPath(target); setSelected(''); refresh(value => value + 1);
  };
  const entries = page.listing?.entries.filter(entry => showHidden || !entry.name.startsWith('.')) ?? [];
  const unavailable = !runtime || local;
  const selectedEntry = page.listing?.entries.find(entry => entry.name === selected && !entry.directory && !entry.symlink);
  const canTransfer = enabled && !page.loading && !page.error && !!page.listing && page.scope === scope
    && directory.access !== 'unavailable' && !choosing;
  const chooseTransfer = async (download: boolean) => {
    if (!canTransfer || !runtime || !page.listing || choosingLock.current || (download && !selectedEntry)) return;
    choosingLock.current = true; setChoosing(true);
    const source = transferState.current, owner = runtime, destination = page.listing.path;
    const remoteName = download ? selectedEntry!.name : undefined;
    const snapshot = owner.directorySnapshot?.();
    try {
      const paths = await sftpApi.pickLocal(download);
      if (!paths.length || !alive.current) return;
      const current = transferState.current;
      if (current.runtime !== owner || !current.enabled || current.scope !== source.scope || current.path !== source.path
        || (download && current.selected !== source.selected) || owner.directorySnapshot?.().accessKey !== snapshot?.accessKey) {
        notify('目录、选中文件或终端身份已变化，请重新选择后传输。', 'error'); return;
      }
      transfer(createSidebarTransfer(owner, terminalId, title || '终端文件', destination, paths, remoteName));
    } catch (error) { if (alive.current) notify(error instanceof Error ? error.message : '无法开始文件传输。', 'error'); }
    finally { choosingLock.current = false; if (alive.current) setChoosing(false); }
  };
  return <section className="terminal-file-sidebar" aria-label="当前终端文件" hidden={!visible}>
    <header className="terminal-file-heading"><span><Icon name="server" size={14} /><strong title={title}>{title || '终端文件'}</strong></span>
      <div className="terminal-file-actions" aria-label="文件传输操作" aria-busy={choosing}>
        <IconButton icon="upload" className="terminal-file-transfer upload" label="上传文件到当前目录" disabled={!canTransfer} onClick={() => void chooseTransfer(false)} />
        <IconButton icon="download" className="terminal-file-transfer download" label="下载选中文件" title={selectedEntry ? `下载 ${selectedEntry.name}` : '先在列表中选择要下载的文件'} disabled={!canTransfer || !selectedEntry} onClick={() => void chooseTransfer(true)} />
        <IconButton icon="refresh" label="刷新文件列表" disabled={!enabled || page.loading} onClick={() => refresh(value => value + 1)} />
      </div>
    </header>
    {unavailable ? <div className="terminal-file-empty"><Icon name="folder" size={30} /><strong>{local ? '当前是本地终端' : '尚未选择 SSH 终端'}</strong><p>连接并激活一个 SSH 终端后，在这里浏览服务器文件。</p></div> : <>
      <form className="terminal-file-path" onSubmit={event => { event.preventDefault(); browse(input.trim()); }}>
        <IconButton icon="up" label="文件上一级目录" disabled={!enabled || !(page.listing?.path || path) || (page.listing?.path || path) === '/'} onClick={() => browse(directoryParent(page.listing?.path || path))} />
        <input aria-label="服务器目录路径" value={input} onChange={event => setInput(event.target.value)} placeholder="输入绝对路径" disabled={!enabled} spellCheck={false} />
        <button type="submit" disabled={!enabled || !input.startsWith('/')} aria-label="前往服务器目录"><Icon name="right" size={14} /></button>
      </form>
      <div className="terminal-file-options"><label><input type="checkbox" checked={follow} onChange={event => changeFollow(event.target.checked)} />跟随终端目录</label>
        <button type="button" aria-pressed={showHidden} title={showHidden ? '隐藏点开头的文件' : '显示隐藏文件'} onClick={() => setShowHidden(value => !value)}>隐藏文件</button>
      </div>
      <p className="terminal-file-note" role="status">{!connected ? '连接已断开，重新连接后恢复浏览。' : directory.access === 'unavailable' ? 'root 目录通道未就绪 · 请退出 root 后重新 sudo -i' : directory.access === 'root' ? `已复用终端 root 认证 · ${follow ? '跟随终端目录' : '自由浏览'}` : follow && !directory.path ? '暂显示登录目录。目录跟随在新建或重连的 Bash 终端生效；其他 Shell 可手动浏览。' : follow && directory.running ? '命令运行中 · 显示上次同步的目录' : follow ? '已跟随终端 · 目录变化时同步' : '自由浏览 · 不改变终端目录'}</p>
      {page.error && <div className="terminal-file-error" role="alert"><Icon name="alert" size={14} /><span>{page.error}<small>目录浏览跟随当前终端的访问身份，无需重复输入 sudo 密码。独立的“管理与传输”使用自己的文件会话。</small></span><button type="button" disabled={!enabled} onClick={() => refresh(value => value + 1)}>重试</button></div>}
      <div className="terminal-file-list" role="list" aria-label="目录内容" aria-busy={page.loading}>
        {page.loading && !page.listing ? <p className="terminal-file-placeholder">正在读取目录…</p> : !page.error && page.listing && !entries.length ? <p className="terminal-file-placeholder">{page.listing.entries.length ? '没有可见文件' : '此目录为空'}</p> : entries.map(entry => <button key={entry.name} type="button" role="listitem"
          className={`terminal-file-entry${selected === entry.name ? ' selected' : ''}`} disabled={!enabled} title={`${entry.name}${entry.symlink ? ' · 符号链接' : ''}`}
          onClick={() => entry.directory || entry.symlink ? browse(directoryChild(page.listing!.path, entry.name)) : setSelected(entry.name)}>
          <Icon name={entry.directory ? 'folder' : 'file'} size={16} className={entry.directory ? 'is-folder' : ''} /><span>{entry.name}{entry.symlink && <small> ↗</small>}</span>
          {entry.directory ? <Icon name="right" size={12} /> : <small>{entry.symlink ? '链接' : resourceBytes(entry.size)}</small>}
        </button>)}
      </div>
      <footer className="terminal-file-footer"><span>{page.listing ? `${entries.length} 项${page.listing.truncated ? ' · 仅展示部分' : ''}` : '只读目录浏览'}</span>
        <IconButton icon="copy" label={selected ? '复制选中文件路径' : '复制当前目录路径'} disabled={!page.listing} onClick={() => { if (page.listing) void copy(selected ? directoryChild(page.listing.path, selected) : page.listing.path); }} />
        <button type="button" disabled={!connected} onClick={openFiles}><Icon name="folder" size={13} />管理与传输<Icon name="upRight" size={12} /></button>
      </footer>
    </>}
  </section>;
}
