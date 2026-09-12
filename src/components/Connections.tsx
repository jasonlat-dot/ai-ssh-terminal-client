import { useState } from 'react';
import type { Host } from '../types';
import type { ConnectionDraft } from '../api/ssh';
import type { useSshConnections } from '../state/useSshConnections';
import { Icon, IconButton, Modal } from './Ui';
import { SshConnectionDialog } from './SshConnectionDialog';

type Props = { connections: ReturnType<typeof useSshConnections>; terminal: (id: string) => void; create: () => void; copy: (value: string) => void };

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
    <header className="connections-heading"><div><h1>SSH 连接管理</h1><p>集中管理云服务器与远程主机，支持快速访问与运维操作。</p></div><button disabled={busy} className="primary-button connection-create-button" onClick={create}><Icon name="plus" size={18} />新建连接</button></header>
    <div className="connection-stats">
      <div><span className="stat-icon"><Icon name="server" /></span><span><strong>{hosts.length}</strong><small>总连接数</small></span></div>
      <div><span className="stat-icon green"><Icon name="signal" /></span><span><strong>{hosts.filter(h => h.online).length}</strong><small>已连接</small></span></div>
      <div><span className="stat-icon amber"><Icon name="bulb" /></span><span><strong>{hosts.filter(h => !h.online).length}</strong><small>未连接主机</small></span></div>
      <div><span className="stat-icon violet"><Icon name="signal" /></span><span><strong>—<em> ms</em></strong><small>平均延迟</small></span></div>
      <div><span className="stat-icon amber"><Icon name="star" /></span><span><strong>{hosts.filter(h => h.favorite).length}</strong><small>收藏主机</small></span></div>
    </div>
    <div className="connection-feedback" aria-live="polite">{busy && <span>正在处理，请稍候…</span>}{apiError && <p role="alert" className="form-error">{apiError}</p>}<button className="outlined-button" disabled={busy} onClick={() => connections.refresh()}>刷新连接</button></div>
    {deleting && <Modal title="删除确认" className="delete-connection-modal" dismissDisabled={busy} onClose={() => setDeleting(null)}>
      <span className="delete-dialog-warning" aria-hidden="true"><Icon name="alert" size={36} /></span>
      <div className="delete-dialog-content">
        <h3>确定要删除该 SSH 连接吗？</h3>
        <p>删除后无法恢复，连接配置、认证信息与相关终端会话将被移除。</p>
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
    <div className="connections-filter"><div className="connection-filter-tabs"><button aria-pressed={!favorites} className={!favorites ? 'selected' : ''} onClick={() => setFavorites(false)}>全部连接 <span>{hosts.length}</span></button><button aria-pressed={favorites} className={favorites ? 'selected' : ''} onClick={() => setFavorites(true)}>收藏主机 <span>{hosts.filter(h => h.favorite).length}</span></button></div><label className="host-search"><Icon name="search" size={17} /><input aria-label="搜索连接" placeholder="搜索名称、IP 或用户…" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="connection-grid">{filtered.map(h => <article className={`ssh-host-card ${h.online ? 'is-online' : ''}`} key={h.id}>
      <header><span className="host-symbol"><Icon name="server" size={29} /></span><div className="host-identity"><div className="host-title-line"><h2 title={h.name}>{h.name}</h2></div><div className="host-address"><span title={h.address}>{h.address}</span><IconButton icon="copy" label={`复制 ${h.name} 地址`} onClick={() => copy(h.address)} /></div></div><IconButton icon="star" className={h.favorite ? 'is-favorite' : ''} aria-pressed={!!h.favorite} label={`${h.favorite ? '取消收藏' : '收藏'} ${h.name}`} disabled={busy} onClick={() => connections.favorite(h)} /></header>
      <span className={`host-status ${h.online ? 'online' : ''}`}><i />{h.status === 2 ? '连接中' : h.status === 3 ? '连接失败' : h.online ? '已连接' : '未连接'}</span>
      <dl><div><dt><Icon name="server" size={13} />连接协议</dt><dd>SSH</dd></div><div><dt><Icon name="network" size={13} />端口</dt><dd>{h.port ?? 22}</dd></div><div><dt><Icon name="user" size={13} />用户名</dt><dd title={h.user}>{h.user}</dd></div><div><dt><Icon name="key" size={13} />认证方式</dt><dd>{h.auth === 'key' ? 'SSH 私钥' : '密码认证'}</dd></div></dl>
      <footer><button disabled={busy} className="host-card-action action-terminal" onClick={() => terminal(h.id)}><Icon name="terminal" size={16} />{h.online ? '进入终端' : '连接并进入'}</button>{h.online && <button disabled={busy} className="host-card-action action-disconnect" onClick={() => connections.disconnect(h.id)}>断开</button>}<button disabled={busy || !!draft} className="host-card-action action-edit" onClick={() => edit(h)}>编辑</button><button disabled={busy} className="host-card-action action-delete" onClick={() => setDeleting(h)}>删除</button></footer>
    </article>)}</div>
    {loaded && !busy && !apiError && !filtered.length && <div className="empty-state"><Icon name="server" size={32} /><h2>暂无匹配的连接</h2><p>添加云服务器或远程主机后，即可创建终端会话。</p><button disabled={busy} className="primary-button connection-create-button" onClick={create}>新建连接</button></div>}
  </main>;
}
