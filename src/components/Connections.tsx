import { useState } from 'react';
import type { Host } from '../types';
import { hosts as demoHosts } from '../data/mock';
import { Icon, IconButton } from './Ui';

export function loadHosts(): Host[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('agent-ssh-hosts-v1') ?? 'null');
    if (Array.isArray(stored) && stored.every(h => h && typeof h.id === 'string' && typeof h.name === 'string' && typeof h.address === 'string' && typeof h.user === 'string' && typeof h.online === 'boolean' && (h.port === undefined || Number.isInteger(h.port) && h.port > 0 && h.port <= 65535))) {
      return stored.map(h => ({ id: h.id, name: h.name, address: h.address, user: h.user, online: h.saved ? false : h.online, port: h.port ?? 22, environment: typeof h.environment === 'string' ? h.environment : '开发', auth: h.auth === 'key' ? 'key' : 'password', keyPath: typeof h.keyPath === 'string' ? h.keyPath : '', favorite: h.favorite === true, saved: h.saved === true }));
    }
  } catch { /* A damaged or unavailable store falls back to demo connections. */ }
  return demoHosts.map(h => ({ ...h, port: 22, environment: '生产', auth: 'password' }));
}

type Props = { hosts: Host[]; save: (hosts: Host[]) => boolean; terminal: (id: string) => void; local: () => void; copy: (value: string) => void };
const blank: Host = { id: '', name: '', address: '', user: 'root', port: 22, online: false, environment: '开发', auth: 'password', keyPath: '', saved: true };

export function Connections({ hosts, save, terminal, local, copy }: Props) {
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [environment, setEnvironment] = useState('全部环境');
  const [draft, setDraft] = useState<Host | null>(null);
  const [error, setError] = useState('');
  const edit = (host: Host) => { setDraft({ ...host }); setError(''); };
  const filtered = hosts.filter(h => (!favorites || h.favorite) && (environment === '全部环境' || h.environment === environment) && `${h.name} ${h.address} ${h.user}`.toLowerCase().includes(query.trim().toLowerCase()));
  const submit = () => {
    if (!draft) return;
    const next = { ...draft, name: draft.name.trim(), address: draft.address.trim(), user: draft.user.trim(), keyPath: draft.keyPath?.trim() };
    if (!next.name || !next.address || !next.user) { setError('请填写连接名称、主机地址和用户名。'); return; }
    if (/[\s/@?#]/.test(next.address) || next.address.includes('://')) { setError('主机地址请填写 IP 或域名，不要包含协议、路径或空格。'); return; }
    if (!Number.isInteger(next.port) || next.port! < 1 || next.port! > 65535) { setError('端口必须是 1–65535 之间的整数。'); return; }
    if (next.auth === 'key' && !next.keyPath) { setError('请填写私钥文件路径。'); return; }
    if (hosts.some(h => h.id !== next.id && h.address.toLowerCase() === next.address.toLowerCase() && (h.port ?? 22) === next.port && h.user === next.user)) { setError('已存在相同地址、端口和用户的连接。'); return; }
    next.keyPath = next.auth === 'key' ? next.keyPath : '';
    next.saved = true;
    next.online = false;
    const updated = next.id ? hosts.map(h => h.id === next.id ? next : h) : [...hosts, { ...next, id: crypto.randomUUID() }];
    if (save(updated)) { setDraft(null); setQuery(''); setFavorites(false); setEnvironment('全部环境'); }
  };

  return <main className="connections-page" aria-label="SSH 连接管理">
    <header className="connections-heading"><div><h1>SSH 连接管理</h1><p>集中管理已连接的远程主机，支持快速访问与运维操作。</p></div><button className="primary-button" onClick={() => edit(blank)}><Icon name="plus" size={18} />新建连接</button></header>
    <div className="connection-stats">
      <div><span className="stat-icon"><Icon name="server" /></span><span><strong>{hosts.length}</strong><small>总连接数</small></span></div>
      <div><span className="stat-icon green"><Icon name="signal" /></span><span><strong>{hosts.filter(h => h.online).length}</strong><small>演示在线</small></span></div>
      <div><span className="stat-icon amber"><Icon name="bulb" /></span><span><strong>{hosts.filter(h => !h.online).length}</strong><small>未连接主机</small></span></div>
      <div><span className="stat-icon violet"><Icon name="signal" /></span><span><strong>—<em> ms</em></strong><small>平均延迟</small></span></div>
      <div><span className="stat-icon amber"><Icon name="star" /></span><span><strong>{hosts.filter(h => h.favorite).length}</strong><small>收藏主机</small></span></div>
    </div>
    {draft && <section className="connection-editor" aria-label={draft.id ? '编辑 SSH 连接' : '新建 SSH 连接'}><header><div><h2>{draft.id ? '编辑 SSH 连接' : '新建 SSH 连接'}</h2><p>保存连接信息，方便下次访问。</p></div><IconButton icon="close" label="取消编辑连接" onClick={() => setDraft(null)} /></header>
      <form onSubmit={e => { e.preventDefault(); submit(); }}><div className="connection-form-grid">
        <label>连接名称<input autoFocus required maxLength={60} placeholder="例如：生产数据库" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>主机地址<input required maxLength={253} placeholder="192.168.1.10 或 example.com" value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} /></label>
        <label>端口<input type="number" required min={1} max={65535} value={draft.port ?? ''} onChange={e => setDraft({ ...draft, port: e.target.valueAsNumber })} /></label>
        <label>用户名<input required maxLength={64} value={draft.user} onChange={e => setDraft({ ...draft, user: e.target.value })} /></label>
        <label>环境<select value={draft.environment} onChange={e => setDraft({ ...draft, environment: e.target.value })}>{['生产', '开发', '测试', '本地'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>认证方式<select value={draft.auth ?? 'password'} onChange={e => setDraft({ ...draft, auth: e.target.value as Host['auth'] })}><option value="password">密码（连接时输入）</option><option value="key">SSH 私钥</option></select></label>
        {draft.auth === 'key' && <label className="key-path">私钥路径<input required placeholder="~/.ssh/id_ed25519" value={draft.keyPath ?? ''} onChange={e => setDraft({ ...draft, keyPath: e.target.value })} /></label>}
      </div><p className="muted">仅保存连接配置，不保存密码或私钥内容。真实 SSH 服务尚未接入。</p>{error && <p role="alert" className="form-error">{error}</p>}<div className="dialog-actions"><button type="button" className="outlined-button" onClick={() => setDraft(null)}>取消</button><button type="submit" className="primary-button">保存连接</button></div></form>
    </section>}
    <div className="connections-filter"><div className="connection-filter-tabs"><button aria-pressed={!favorites} className={!favorites ? 'selected' : ''} onClick={() => setFavorites(false)}>全部连接 <span>{hosts.length}</span></button><button aria-pressed={favorites} className={favorites ? 'selected' : ''} onClick={() => setFavorites(true)}>收藏主机 <span>{hosts.filter(h => h.favorite).length}</span></button></div><label className="host-search"><Icon name="search" size={17} /><input aria-label="搜索连接" placeholder="搜索名称、IP 或用户…" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="筛选环境" value={environment} onChange={e => setEnvironment(e.target.value)}>{['全部环境', '生产', '开发', '测试', '本地'].map(value => <option key={value}>{value}</option>)}</select></div>
    <div className="connection-grid">{filtered.map(h => <article className={`ssh-host-card ${h.online ? 'is-online' : ''}`} key={h.id}>
      <header><span className="host-symbol"><Icon name="server" size={29} /></span><div className="host-identity"><div className="host-title-line"><h2 title={h.name}>{h.name}</h2><span className={`environment-tag ${h.environment === '生产' ? 'production' : ''}`}>{h.environment ?? '开发'}</span></div><div className="host-address"><span title={h.address}>{h.address}</span><IconButton icon="copy" label={`复制 ${h.name} 地址`} onClick={() => copy(h.address)} /></div></div><IconButton icon="star" className={h.favorite ? 'is-favorite' : ''} aria-pressed={!!h.favorite} label={`${h.favorite ? '取消收藏' : '收藏'} ${h.name}`} onClick={() => save(hosts.map(item => item.id === h.id ? { ...item, favorite: !item.favorite } : item))} /></header>
      <span className={`host-status ${h.online ? 'online' : ''}`}><i />{h.saved ? '未连接' : h.online ? '在线 · 演示' : '离线 · 演示'}</span>
      <dl><div><dt><Icon name="server" size={13} />连接协议</dt><dd>SSH</dd></div><div><dt><Icon name="network" size={13} />端口</dt><dd>{h.port ?? 22}</dd></div><div><dt><Icon name="user" size={13} />用户名</dt><dd title={h.user}>{h.user}</dd></div><div><dt><Icon name="key" size={13} />认证方式</dt><dd>{h.auth === 'key' ? 'SSH 私钥' : '密码认证'}</dd></div></dl>
      <footer><button className="primary-button" onClick={() => terminal(h.id)}><Icon name="terminal" size={16} />进入终端</button></footer>
    </article>)}</div>
    {!filtered.length && <div className="empty-state"><Icon name="server" size={32} /><h2>暂无匹配的连接</h2><p>调整筛选条件，或新建一个 SSH 连接。</p><button className="primary-button" onClick={() => edit(blank)}>新建连接</button></div>}
    <button className="local-terminal-link" onClick={local}><Icon name="terminal" size={17} />只想在本机工作？打开本地终端<Icon name="right" size={15} /></button>
  </main>;
}
