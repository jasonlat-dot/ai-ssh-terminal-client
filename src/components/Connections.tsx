import { useState } from 'react';
import type { Host } from '../types';
import type { ConnectionDraft } from '../api/ssh';
import type { useSshConnections } from '../state/useSshConnections';
import { Icon, IconButton } from './Ui';

type Props = { connections: ReturnType<typeof useSshConnections>; terminal: (id: string) => void; local: () => void; copy: (value: string) => void };
const blank: Host = { id: '', name: '', address: '', user: 'root', port: 22, online: false, environment: '开发', auth: 'password', keyPath: '', saved: true };

export function Connections({ connections, terminal, local, copy }: Props) {
  const { hosts, save, busy, loaded, error: apiError } = connections;
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [environment, setEnvironment] = useState('全部环境');
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Host | null>(null);
  const edit = async (host: Host) => {
    const detail = host.id ? await connections.detail(host.id) : host;
    if (detail) { setDraft({ ...detail }); setError(''); }
  };
  const filtered = hosts.filter(h => (!favorites || h.favorite) && (environment === '全部环境' || h.environment === environment) && `${h.name} ${h.address} ${h.user}`.toLowerCase().includes(query.trim().toLowerCase()));
  const submit = async () => {
    if (!draft || busy) return;
    const next = { ...draft, name: draft.name.trim(), address: draft.address.trim(), user: draft.user.trim(), keyPath: draft.keyPath?.trim() };
    if (!next.name || !next.address || !next.user) { setError('请填写连接名称、主机地址和用户名。'); return; }
    if (/[\s/@?#]/.test(next.address) || next.address.includes('://')) { setError('主机地址请填写 IP 或域名，不要包含协议、路径或空格。'); return; }
    if (!Number.isInteger(next.port) || next.port! < 1 || next.port! > 65535) { setError('端口必须是 1–65535 之间的整数。'); return; }
    if (next.auth === 'password' && hosts.find(h => h.id === next.id)?.auth === 'key') { setError('当前接口无法清除已有私钥，请新建密码认证连接。'); return; }
    const credentialsRequired = !next.id || hosts.find(h => h.id === next.id)?.auth !== next.auth;
    if (credentialsRequired && !(next.auth === 'key' ? next.privateKey?.trim() : next.password)) { setError(next.auth === 'key' ? '请填写私钥内容。' : '请填写 SSH 密码。'); return; }
    if (hosts.some(h => h.id !== next.id && h.address.toLowerCase() === next.address.toLowerCase() && (h.port ?? 22) === next.port && h.user === next.user)) { setError('已存在相同地址、端口和用户的连接。'); return; }
    if (await save(next)) { setDraft(null); setQuery(''); setFavorites(false); setEnvironment('全部环境'); }
  };

  return <main className="connections-page" aria-label="SSH 连接管理">
    <header className="connections-heading"><div><h1>SSH 连接管理</h1><p>集中管理已连接的远程主机，支持快速访问与运维操作。</p></div><button disabled={busy} className="primary-button" onClick={() => edit(blank)}><Icon name="plus" size={18} />新建连接</button></header>
    <div className="connection-stats">
      <div><span className="stat-icon"><Icon name="server" /></span><span><strong>{hosts.length}</strong><small>总连接数</small></span></div>
      <div><span className="stat-icon green"><Icon name="signal" /></span><span><strong>{hosts.filter(h => h.online).length}</strong><small>已连接</small></span></div>
      <div><span className="stat-icon amber"><Icon name="bulb" /></span><span><strong>{hosts.filter(h => !h.online).length}</strong><small>未连接主机</small></span></div>
      <div><span className="stat-icon violet"><Icon name="signal" /></span><span><strong>—<em> ms</em></strong><small>平均延迟</small></span></div>
      <div><span className="stat-icon amber"><Icon name="star" /></span><span><strong>{hosts.filter(h => h.favorite).length}</strong><small>收藏主机</small></span></div>
    </div>
    <div className="connection-feedback" aria-live="polite">{busy && <span>正在处理，请稍候…</span>}{apiError && <p role="alert" className="form-error">{apiError}</p>}<button className="outlined-button" disabled={busy} onClick={() => connections.refresh()}>刷新连接</button></div>
    {deleting && <section className="connection-editor" role="alertdialog" aria-label="确认删除连接"><h2>删除 {deleting.name}？</h2><p>将断开 SSH 并删除后端连接配置。</p><div className="dialog-actions"><button disabled={busy} className="outlined-button" onClick={() => setDeleting(null)}>取消</button><button disabled={busy} className="primary-button" onClick={async () => { if (await connections.remove(deleting.id)) setDeleting(null); }}>确认删除</button></div></section>}
    {draft && <section className="connection-editor" aria-label={draft.id ? '编辑 SSH 连接' : '新建 SSH 连接'}><header><div><h2>{draft.id ? '编辑 SSH 连接' : '新建 SSH 连接'}</h2><p>保存连接信息，方便下次访问。</p></div><IconButton icon="close" label="取消编辑连接" disabled={busy} onClick={() => setDraft(null)} /></header>
      <form onSubmit={e => { e.preventDefault(); submit(); }}><fieldset disabled={busy} className="connection-form-fields"><div className="connection-form-grid">
        <label>连接名称<input autoFocus required maxLength={60} placeholder="例如：生产数据库" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>主机地址<input required maxLength={253} placeholder="192.168.1.10 或 example.com" value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} /></label>
        <label>端口<input type="number" required min={1} max={65535} value={draft.port ?? ''} onChange={e => setDraft({ ...draft, port: e.target.valueAsNumber })} /></label>
        <label>用户名<input required maxLength={64} value={draft.user} onChange={e => setDraft({ ...draft, user: e.target.value })} /></label>
        <label>环境<select value={draft.environment} onChange={e => setDraft({ ...draft, environment: e.target.value })}>{['生产', '开发', '测试', '本地'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>认证方式<select aria-label="认证方式" value={draft.auth ?? 'password'} onChange={e => setDraft({ ...draft, auth: e.target.value as Host['auth'] })}><option value="password">密码</option><option value="key">SSH 私钥</option></select></label>
        {draft.auth === 'key'
          ? <label className="key-path">私钥内容<textarea rows={5} autoComplete="off" placeholder={draft.id ? '留空保留原私钥；更换认证方式时必填' : '粘贴完整 PEM / OpenSSH 私钥内容'} value={draft.privateKey ?? ''} onChange={e => setDraft({ ...draft, privateKey: e.target.value })} /></label>
          : <label>SSH 密码<input type="password" autoComplete="new-password" placeholder={draft.id ? '留空保留原密码；更换认证方式时必填' : '输入 SSH 密码'} value={draft.password ?? ''} onChange={e => setDraft({ ...draft, password: e.target.value })} /></label>}
        <label>连接超时（秒）<input type="number" min={1} step={1} placeholder="保留后端配置" value={draft.connectTimeout ?? ''} onChange={e => setDraft({ ...draft, connectTimeout: e.target.value === '' ? undefined : e.target.valueAsNumber })} /></label>
        <label>保活间隔（秒）<input type="number" min={0} step={1} placeholder="保留后端配置" value={draft.keepaliveInterval ?? ''} onChange={e => setDraft({ ...draft, keepaliveInterval: e.target.value === '' ? undefined : e.target.valueAsNumber })} /></label>
        <label>启动命令<input placeholder="未修改则保留后端配置" value={draft.startupCommand ?? ''} onChange={e => setDraft({ ...draft, startupCommand: e.target.value })} /></label>
        <label>压缩<select value={draft.compression === undefined ? '' : String(draft.compression)} onChange={e => setDraft({ ...draft, compression: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">保留后端配置</option><option value="true">开启</option><option value="false">关闭</option></select></label>
        <label>严格主机密钥检查<select value={draft.strictHostKeyCheck === undefined ? '' : String(draft.strictHostKeyCheck)} onChange={e => setDraft({ ...draft, strictHostKeyCheck: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">保留后端配置</option><option value="true">开启</option><option value="false">关闭</option></select></label>
      </div></fieldset><p className="muted">凭据提交到后端，不在浏览器中持久保存。环境和收藏仅保存在本地。高级配置不回显，未修改的字段保留后端值。</p>{error && <p role="alert" className="form-error">{error}</p>}<div className="dialog-actions"><button type="button" className="outlined-button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button disabled={busy} type="submit" className="primary-button">{busy ? '保存中…' : '保存连接'}</button></div></form>
    </section>}
    <div className="connections-filter"><div className="connection-filter-tabs"><button aria-pressed={!favorites} className={!favorites ? 'selected' : ''} onClick={() => setFavorites(false)}>全部连接 <span>{hosts.length}</span></button><button aria-pressed={favorites} className={favorites ? 'selected' : ''} onClick={() => setFavorites(true)}>收藏主机 <span>{hosts.filter(h => h.favorite).length}</span></button></div><label className="host-search"><Icon name="search" size={17} /><input aria-label="搜索连接" placeholder="搜索名称、IP 或用户…" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="筛选环境" value={environment} onChange={e => setEnvironment(e.target.value)}>{['全部环境', '生产', '开发', '测试', '本地'].map(value => <option key={value}>{value}</option>)}</select></div>
    <div className="connection-grid">{filtered.map(h => <article className={`ssh-host-card ${h.online ? 'is-online' : ''}`} key={h.id}>
      <header><span className="host-symbol"><Icon name="server" size={29} /></span><div className="host-identity"><div className="host-title-line"><h2 title={h.name}>{h.name}</h2><span className={`environment-tag ${h.environment === '生产' ? 'production' : ''}`}>{h.environment ?? '开发'}</span></div><div className="host-address"><span title={h.address}>{h.address}</span><IconButton icon="copy" label={`复制 ${h.name} 地址`} onClick={() => copy(h.address)} /></div></div><IconButton icon="star" className={h.favorite ? 'is-favorite' : ''} aria-pressed={!!h.favorite} label={`${h.favorite ? '取消收藏' : '收藏'} ${h.name}`} disabled={busy} onClick={() => connections.favorite(h)} /></header>
      <span className={`host-status ${h.online ? 'online' : ''}`}><i />{h.status === 2 ? '连接中' : h.status === 3 ? '连接失败' : h.online ? '已连接' : '未连接'}</span>
      <dl><div><dt><Icon name="server" size={13} />连接协议</dt><dd>SSH</dd></div><div><dt><Icon name="network" size={13} />端口</dt><dd>{h.port ?? 22}</dd></div><div><dt><Icon name="user" size={13} />用户名</dt><dd title={h.user}>{h.user}</dd></div><div><dt><Icon name="key" size={13} />认证方式</dt><dd>{h.auth === 'key' ? 'SSH 私钥' : '密码认证'}</dd></div></dl>
      <footer><button disabled={busy} className="primary-button" onClick={() => terminal(h.id)}><Icon name="terminal" size={16} />{h.online ? '进入终端' : '连接并进入'}</button>{h.online && <button disabled={busy} className="outlined-button" onClick={() => connections.disconnect(h.id)}>断开</button>}<button disabled={busy || !!draft} className="outlined-button" onClick={() => edit(h)}>编辑</button><button disabled={busy} className="outlined-button" onClick={() => setDeleting(h)}>删除</button></footer>
    </article>)}</div>
    {loaded && !busy && !apiError && !filtered.length && <div className="empty-state"><Icon name="server" size={32} /><h2>暂无匹配的连接</h2><p>调整筛选条件，或新建一个 SSH 连接。</p><button disabled={busy} className="primary-button" onClick={() => edit(blank)}>新建连接</button></div>}
    <button className="local-terminal-link" onClick={local}><Icon name="terminal" size={17} />只想在本机工作？打开本地终端<Icon name="right" size={15} /></button>
  </main>;
}
