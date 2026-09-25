import { useState } from 'react';
import type { Host } from '../types';
import type { ConnectionDraft } from '../api/ssh';
import type { useSshConnections } from '../state/useSshConnections';
import { Icon, IconButton, Modal } from './Ui';
import { SshConnectionDialog } from './SshConnectionDialog';

type Props = { connections: ReturnType<typeof useSshConnections>; terminal: (id: string) => void; create: () => void; copy: (value: string) => void };

export function ConnectionSidebar({ connections, activeHostId, terminal, create, manage, setManage }: {
  connections: ReturnType<typeof useSshConnections>;
  activeHostId?: string | null;
  terminal: (id: string) => void;
  create: () => void;
  manage: boolean;
  setManage: (value: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const hosts = connections.hosts.filter(host => `${host.name} ${host.address} ${host.user}`.toLowerCase().includes(query.trim().toLowerCase()));
  const edit = async (host: Host) => {
    const detail = await connections.detail(host.id);
    if (detail) setDraft({ ...detail });
  };
  return <aside className="host-sidebar" aria-label="SSH 连接列表">
    <header className="host-sidebar-heading">
      <div><span>SSH</span><strong>{manage ? '管理连接' : '服务器'}</strong><small>{connections.hosts.length}</small></div>
      <IconButton icon="plus" label="添加 SSH 连接" disabled={connections.busy} onClick={create} />
    </header>
    <label className="sidebar-host-search"><Icon name="search" size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索连接" aria-label="搜索 SSH 连接" /></label>
    <div className="sidebar-host-list">
      {hosts.map(host => <div key={host.id} className={`sidebar-host ${host.id === activeHostId ? 'selected' : ''} ${manage ? 'managing' : ''}`}>
        <button className="sidebar-host-main" disabled={connections.busy} onClick={() => terminal(host.id)}>
          <i className="status-dot offline" aria-hidden="true" />
          <span><strong title={host.name}>{host.name}</strong><small title={`${host.user}@${host.address}:${host.port ?? 22}`}>{host.user}@{host.address}:{host.port ?? 22}</small></span>
          <em>已保存</em>
        </button>
        {manage && <div className="sidebar-host-actions">
          <IconButton icon="star" className={`favorite-icon ${host.favorite ? 'is-favorite' : ''}`} aria-pressed={!!host.favorite} label={`${host.favorite ? '取消收藏' : '收藏'} ${host.name}`} disabled={connections.busy} onClick={() => connections.favorite(host)} />
          <IconButton icon="edit" className="edit-icon" label={`编辑 ${host.name}`} disabled={connections.busy} onClick={() => edit(host)} />
          <IconButton icon="trash" className="destructive-icon" label={`删除 ${host.name}`} disabled={connections.busy} onClick={() => setDeleting(host)} />
        </div>}
      </div>)}
      {!hosts.length && <div className="sidebar-host-empty"><Icon name="server" size={22} /><span>{connections.loaded ? '没有匹配的连接' : '正在加载连接…'}</span></div>}
    </div>
    <footer><button onClick={() => setManage(!manage)}><Icon name={manage ? 'check' : 'settings'} size={14} />{manage ? '完成管理' : '管理全部连接'}</button><IconButton icon="refresh" label="刷新连接列表" disabled={connections.busy} onClick={() => connections.refresh()} /></footer>
    {draft && <SshConnectionDialog connections={connections} initial={draft} onClose={() => setDraft(null)} />}
    {deleting && <Modal title="删除连接" dismissDisabled={connections.busy} onClose={() => setDeleting(null)}>
      <div className="compact-delete-dialog"><p>确定删除 <strong>{deleting.name}</strong>？该操作无法恢复。</p><div className="dialog-actions"><button className="outlined-button" disabled={connections.busy} onClick={() => setDeleting(null)}>取消</button><button className="delete-dialog-confirm" disabled={connections.busy} onClick={async () => { if (await connections.remove(deleting.id)) setDeleting(null); }}>确认删除</button></div></div>
    </Modal>}
  </aside>;
}

export function Connections({ connections, terminal, create, copy }: Props) {
  const { hosts, busy, loaded, error: apiError } = connections;
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const edit = async (host: Host) => {
    const detail = await connections.detail(host.id);
    if (detail) setDraft({ ...detail });
  };
  const filtered = hosts.filter(h => (!favorites || h.favorite) && `${h.name} ${h.address} ${h.user}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <main className="connections-page" aria-label="SSH 连接管理">
    <header className="connections-heading">
      <div><span className="eyebrow">REMOTE HOSTS</span><h1>SSH 连接</h1><p><strong>{hosts.length}</strong> 个已保存配置</p></div>
      <button disabled={busy} className="primary-button connection-create-button" onClick={create}><Icon name="plus" size={17} />添加 SSH</button>
    </header>
    {deleting && <Modal title="删除确认" className="delete-connection-modal" dismissDisabled={busy} onClose={() => setDeleting(null)}>
      <span className="delete-dialog-warning" aria-hidden="true"><Icon name="alert" size={36} /></span>
      <div className="delete-dialog-content">
        <h3>确定要删除该 SSH 连接吗？</h3>
        <p>删除后无法恢复，连接配置与认证信息将被移除；已经打开的终端页签仍保持各自的会话。</p>
        <div className="delete-host-summary">
          <span><Icon name="server" size={34} /></span>
          <div><strong>{deleting.name}</strong><small>{deleting.address}:{deleting.port ?? 22}</small></div>
        </div>
        {apiError && <p role="alert" className="delete-dialog-error">{apiError}</p>}
        <footer className="delete-dialog-actions">
          <button data-autofocus disabled={busy} className="outlined-button" onClick={() => setDeleting(null)}>取消</button>
          <button disabled={busy} className="delete-dialog-confirm" onClick={async () => { if (await connections.remove(deleting.id)) setDeleting(null); }}>{busy ? '正在删除…' : '确认删除'}</button>
        </footer>
      </div>
    </Modal>}
    {draft && <SshConnectionDialog connections={connections} initial={draft} onClose={() => setDraft(null)} />}
    <div className="connections-filter">
      <div className="connection-filter-tabs"><button aria-pressed={!favorites} className={!favorites ? 'selected' : ''} onClick={() => setFavorites(false)}>全部 <span>{hosts.length}</span></button><button aria-pressed={favorites} className={favorites ? 'selected' : ''} onClick={() => setFavorites(true)}>收藏 <span>{hosts.filter(h => h.favorite).length}</span></button></div>
      <label className="host-search"><Icon name="search" size={16} /><input aria-label="搜索连接" placeholder="搜索主机、IP 或用户" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <IconButton className="connection-refresh" icon="refresh" label="刷新连接" disabled={busy} onClick={() => connections.refresh()} />
    </div>
    <div className="connection-feedback" aria-live="polite">{busy && <span>正在同步连接…</span>}{apiError && <p role="alert" className="form-error">{apiError}</p>}</div>
    <div className="connection-list" role="list">{filtered.map(h => <article className="ssh-host-row" key={h.id} role="listitem">
      <button className="host-row-main" disabled={busy} onClick={() => terminal(h.id)} aria-label={`为 ${h.name} 新建终端会话`}>
        <span className="host-symbol"><Icon name="server" size={19} /></span>
        <span className="host-row-identity"><strong title={h.name}>{h.name}</strong><small title={`${h.user}@${h.address}:${h.port ?? 22}`}>{h.user}@{h.address}:{h.port ?? 22}</small></span>
        <span className="host-row-meta"><span><Icon name="key" size={13} />{h.auth === 'key' ? '私钥' : '密码'}</span><span><Icon name="network" size={13} />SSH</span></span>
        <span className="host-status"><i />已保存</span>
      </button>
      <div className="host-row-actions">
        <IconButton icon="copy" label={`复制 ${h.name} 地址`} onClick={() => copy(h.address)} />
        <IconButton icon="star" className={`favorite-icon ${h.favorite ? 'is-favorite' : ''}`} aria-pressed={!!h.favorite} label={`${h.favorite ? '取消收藏' : '收藏'} ${h.name}`} disabled={busy} onClick={() => connections.favorite(h)} />
        <IconButton icon="terminal" className="terminal-icon" label={`为 ${h.name} 新建终端会话`} disabled={busy} onClick={() => terminal(h.id)} />
        <IconButton icon="edit" className="edit-icon" label={`编辑 ${h.name}`} disabled={busy || !!draft} onClick={() => edit(h)} />
        <IconButton icon="trash" className="host-row-delete" label={`删除 ${h.name}`} disabled={busy} onClick={() => setDeleting(h)} />
      </div>
    </article>)}</div>
    {loaded && !busy && !apiError && !filtered.length && <div className="empty-state"><Icon name="server" size={32} /><h2>暂无匹配的连接</h2><p>添加云服务器或远程主机后，即可创建终端会话。</p><button disabled={busy} className="primary-button connection-create-button" onClick={create}>新建连接</button></div>}
  </main>;
}
