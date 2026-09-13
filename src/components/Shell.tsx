import type { Host, Navigation } from '../types';
import { Icon, IconButton } from './Ui';
import type { IconName } from './Ui';
export function AppHeader({ search, notify }: { search: () => void; notify: (text: string) => void }) {
  return <header className="app-header"><div className="brand"><span className="brand-mark"><span /></span><div><strong>Agent SSH</strong><small>智能远程开发助手</small></div></div><button className="project-select" onClick={() => notify('当前演示项目：Web 服务')}><Icon name="terminal" size={15} /><span>Web 服务</span><Icon name="down" size={14} /></button><button className="global-search" onClick={search}><Icon name="search" /><span>搜索命令、文件或主机… (Ctrl + K)</span></button><div className="profile"><IconButton icon="bulb" label="通知" onClick={() => notify('目前没有新的通知。')} /><span className="header-divider" /><button className="user-menu" onClick={() => notify('zhangsan · 本地演示账户')}><span className="avatar">Z</span><span>zhangsan</span><Icon name="down" size={14} /></button></div></header>;
}
const items: { name: Navigation; label: string; subtitle: string; icon: IconName }[] = [
  { name: '连接', label: '连接', subtitle: '远程主机连接', icon: 'server' },
  { name: '命令', label: '终端', subtitle: '在线终端', icon: 'terminal' },
];
export function ActivityBar({ active, onSelect, collapsed, toggleCollapsed }: { active: Navigation; onSelect: (name: Navigation) => void; collapsed: boolean; toggleCollapsed: () => void }) {
  return <nav className="activity-bar" aria-label="主导航"><button className="nav-collapse-toggle" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-label={collapsed ? '展开导航栏' : '收起导航栏'} title={collapsed ? '展开导航栏' : '收起导航栏'}><Icon name="split" size={19} /><span>收起导航</span></button>{items.map(item => <button key={item.name} aria-label={item.label} title={collapsed ? item.label : undefined} className={`activity ${active === item.name ? 'selected' : ''}`} aria-current={active === item.name ? 'page' : undefined} onClick={() => onSelect(item.name)}><Icon name={item.icon} size={23} /><span><strong>{item.label}</strong><small>{item.subtitle}</small></span></button>)}<div className="nav-footer"><div className="planet-art" aria-hidden="true"><i /><span /></div><strong>让开发更简单</strong><small>智能 · 高效 · 安全</small></div></nav>;
}
export function StatusBar({ host }: { host?: Host }) {
  return <footer className="status-bar"><div className="status-left"><span><i className={`status-dot ${host?.online ? '' : 'offline'}`} />{host?.online ? 'SSH 已连接' : host ? 'SSH 未连接' : '等待远程连接'}</span><span className="sftp-status"><Icon name="box" size={15} />{'SFTP（模拟）'}</span><span className="latency-chip"><Icon name="signal" size={14} />延迟 —</span><span className="demo-badge">{host ? '远程终端' : '仅支持远程终端'}</span></div><div className="status-right"><span>UTF-8</span><span>xterm-256color</span><span>v0.1.0</span></div></footer>;
}
