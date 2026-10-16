import { useState } from 'react';
import type { Host, TerminalSession } from '../types';
import type { ConnectionDraft } from '../api/ssh';
import type { useSshConnections } from '../state/useSshConnections';
import { AccentIcon, Badge, Icon, IconButton, Modal } from './Ui';
import { SshConnectionDialog } from './SshConnectionDialog';
import { isSessionConnected } from '../state/terminalSessions';

type Props = { connections: ReturnType<typeof useSshConnections>; terminal: (id: string) => void; create: () => void; copy: (value: string) => void };

export function ConnectionSidebar({ connections, sessions, connectingHostIds, activeHostId, activeSessionId, terminal, cancelConnection, activate, create, collapsed, toggleCollapsed, embedded = false }: {
  connections: ReturnType<typeof useSshConnections>;
  sessions: TerminalSession[];
  connectingHostIds: ReadonlySet<string>;
  activeHostId?: string | null;
  activeSessionId?: string | null;
  terminal: (id: string) => void;
  cancelConnection: (id: string) => void;
  activate: (id: string) => void;
  create: () => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  embedded?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [manageMode, setManageMode] = useState<'none' | 'selected' | 'all'>('none');
  const hosts = connections.hosts.filter(host => `${host.name} ${host.address} ${host.user}`.toLowerCase().includes(query.trim().toLowerCase()));
  const edit = async (host: Host) => {
    const detail = await connections.detail(host.id);
    if (detail) setDraft({ ...detail });
  };
  return <aside id="connection-sidebar-content" className={`host-sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="SSH 连接列表">
    <header className="host-sidebar-heading">
      <div className="host-sidebar-title"><span>SSH</span><strong>服务器</strong><small>{connections.hosts.length}</small></div>
      <div className="host-sidebar-heading-actions">
        <IconButton icon="plus" className="host-sidebar-add" label="添加 SSH 连接" disabled={connections.busy} onClick={create} />
        <IconButton icon="refresh" className="host-sidebar-refresh" label="刷新连接列表" disabled={connections.busy} onClick={() => connections.refresh()} />
        <IconButton icon={embedded ? collapsed ? 'up' : 'down' : collapsed ? 'right' : 'left'} className="host-sidebar-collapse" label={collapsed ? '展开连接列表' : '收起连接列表'} aria-controls="ssh-connection-list" aria-expanded={!collapsed} onClick={toggleCollapsed} />
      </div>
    </header>
    <label className="sidebar-host-search"><Icon name="search" size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索连接" aria-label="搜索 SSH 连接" /></label>
    <div className="sidebar-host-list" id="ssh-connection-list">
      {hosts.map(host => {
        const hostSessions = sessions.filter(session => session.connectionId === host.id);
        const connectedCount = hostSessions.filter(isSessionConnected).length;
        const unreachable = hostSessions.some(session => session.connectionStatus === 'unreachable');
        const connecting = connectingHostIds.has(host.id);
        const reconnecting = hostSessions.some(session => session.reconnecting);
        const reusableSession = hostSessions.find(session => session.id === activeSessionId && (session.connected || session.connectionStatus === 'unreachable'))
          ?? hostSessions.find(session => session.connected || session.connectionStatus === 'unreachable');
        const showManagement = manageMode === 'all' || (manageMode === 'selected' && host.id === activeHostId);
        return <div key={host.id} className={`sidebar-host ${host.id === activeHostId ? 'selected' : ''} ${unreachable ? 'is-unreachable' : ''} ${showManagement ? 'managing' : ''}`}>
        <button className="sidebar-host-main" disabled={connections.busy || connecting} aria-label={connecting ? `${host.name} 正在连接` : reusableSession ? `打开 ${host.name} 已有终端` : `连接 ${host.name}`} onClick={() => reusableSession ? activate(reusableSession.id) : terminal(host.id)}>
          <i className={`status-dot ${unreachable ? 'unreachable' : connectedCount ? '' : 'offline'} ${connecting || reconnecting ? 'pending' : ''}`} aria-hidden="true" />
          <span><strong title={host.name}>{host.name}</strong><small title={`${host.user}@${host.address}:${host.port ?? 22}`}>{host.user}@{host.address}:{host.port ?? 22}</small></span>
          <div className="sidebar-host-state" aria-live="polite">
            {connecting || reconnecting
              ? <em className="connection-pending"><i aria-hidden="true" />{connecting ? '连接中' : '重连中'}</em>
              : <em className={unreachable ? 'connection-unreachable' : ''}>{unreachable ? '服务不可达' : connectedCount ? '已连接' : '已保存'}</em>}
            {!unreachable && !!connectedCount && <small>{connectedCount} 个会话</small>}
          </div>
        </button>
        {(connecting || showManagement) && <div className="sidebar-host-actions">
          {connecting && <button className="sidebar-host-cancel" aria-label={`取消连接 ${host.name}`} onClick={() => cancelConnection(host.id)}><Icon name="close" size={12} />取消连接</button>}
          {showManagement && <>
            <IconButton icon="terminal" className="terminal-icon" label={`为 ${host.name} 新建终端会话`} disabled={connections.busy || connecting} onClick={() => terminal(host.id)} />
            <IconButton icon="edit" className="edit-icon" label={`编辑 ${host.name}`} disabled={connections.busy || connecting} onClick={() => edit(host)} />
            <IconButton icon="trash" className="destructive-icon" label={`删除 ${host.name}`} disabled={connections.busy || connecting} onClick={() => setDeleting(host)} />
          </>}
        </div>}
      </div>;
      })}
      {!hosts.length && <div className="sidebar-host-empty"><Icon name="server" size={22} /><span>{connections.loaded ? '没有匹配的连接' : '正在加载连接…'}</span></div>}
    </div>
    <footer className="sidebar-management-footer">
      <button className="sidebar-manage-button" aria-pressed={manageMode === 'selected'} disabled={connections.busy || !activeHostId} title={activeHostId ? '只显示当前连接的编辑和删除操作' : '请先打开一个远程连接'} onClick={() => setManageMode(mode => mode === 'selected' ? 'none' : 'selected')}><Icon name="edit" size={13} />管理当前</button>
      <button className="sidebar-manage-button" aria-pressed={manageMode === 'all'} disabled={connections.busy || !connections.hosts.length} title="显示全部连接的编辑和删除操作" onClick={() => setManageMode(mode => mode === 'all' ? 'none' : 'all')}><Icon name="settings" size={13} />管理全部</button>
    </footer>
    {draft && <SshConnectionDialog connections={connections} initial={draft} onClose={() => setDraft(null)} />}
    {deleting && <Modal title="删除连接" dismissDisabled={connections.busy} onClose={() => setDeleting(null)}>
      <div className="compact-delete-dialog"><p>确定删除 <strong>{deleting.name}</strong>？该操作无法恢复。</p><div className="dialog-actions"><button className="outlined-button" disabled={connections.busy} onClick={() => setDeleting(null)}>取消</button><button className="delete-dialog-confirm" disabled={connections.busy} onClick={async () => { if (await connections.remove(deleting.id)) setDeleting(null); }}>确认删除</button></div></div>
    </Modal>}
  </aside>;
}

export function Connections({ connections, terminal, create, copy }: Props) {
  const { hosts, busy, loaded, error: apiError } = connections;
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const edit = async (host: Host) => {
    const detail = await connections.detail(host.id);
    if (detail) setDraft({ ...detail });
  };
  const filtered = hosts.filter(h => `${h.name} ${h.address} ${h.user}`.toLowerCase().includes(query.trim().toLowerCase()));
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
      <div className="connection-filter-tabs"><button aria-pressed="true" className="selected">全部 <Badge tone="violet">{hosts.length}</Badge></button></div>
      <label className="host-search"><Icon name="search" size={16} /><input aria-label="搜索连接" placeholder="搜索主机、IP 或用户" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <IconButton className="connection-refresh" icon="refresh" label="刷新连接" disabled={busy} onClick={() => connections.refresh()} />
    </div>
    <div className="connection-feedback" aria-live="polite">{busy && <span>正在同步连接…</span>}{apiError && <p role="alert" className="form-error">{apiError}</p>}</div>
    <div className="connection-list" role="list">{filtered.map(h => <article className="ssh-host-row" key={h.id} role="listitem">
      <button className="host-row-main" disabled={busy} onClick={() => terminal(h.id)} aria-label={`为 ${h.name} 新建终端会话`}>
        <AccentIcon icon="server" size={19} className="host-symbol" />
        <span className="host-row-identity"><strong title={h.name}>{h.name}</strong><small title={`${h.user}@${h.address}:${h.port ?? 22}`}>{h.user}@{h.address}:{h.port ?? 22}</small></span>
        <span className="host-row-meta"><Badge tone="amber" icon="key">{h.auth === 'key' ? '私钥' : '密码'}</Badge><Badge tone="cyan" icon="network">SSH</Badge></span>
        <Badge className="host-status" icon="check">已保存</Badge>
      </button>
      <div className="host-row-actions">
        <IconButton icon="copy" label={`复制 ${h.name} 地址`} onClick={() => copy(h.address)} />
        <IconButton icon="terminal" className="terminal-icon" label={`为 ${h.name} 新建终端会话`} disabled={busy} onClick={() => terminal(h.id)} />
        <IconButton icon="edit" className="edit-icon" label={`编辑 ${h.name}`} disabled={busy || !!draft} onClick={() => edit(h)} />
        <IconButton icon="trash" className="host-row-delete" label={`删除 ${h.name}`} disabled={busy} onClick={() => setDeleting(h)} />
      </div>
    </article>)}</div>
    {loaded && !busy && !apiError && !filtered.length && <div className="empty-state"><Icon name="server" size={32} /><h2>暂无匹配的连接</h2><p>添加云服务器或远程主机后，即可创建终端会话。</p><button disabled={busy} className="primary-button connection-create-button" onClick={create}>新建连接</button></div>}
  </main>;
}
