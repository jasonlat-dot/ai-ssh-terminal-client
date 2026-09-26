import { useSyncExternalStore } from 'react';
import type { FileUploadQueue } from '../state/fileUploads';
import type { Navigation } from '../types';
import type { ThemePreference } from '../state/useTheme';
import { Icon } from './Ui';
import type { IconName } from './Ui';
export function AppHeader({ notify, theme, setTheme, uploads, openUploads }: {
  uploads: FileUploadQueue;
  openUploads: () => void;
  notify: (text: string) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}) {
  const uploadItems = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  const uploading = uploadItems.filter(item => item.status === 'uploading' || item.status === 'queued').length;
  return <header className="app-header">
    <div className="brand"><span className="brand-mark"><span /></span><div><strong>Agent SSH</strong><small>智能远程开发助手</small></div></div>
    <div className="profile">
      <button type="button" className="header-upload-button" aria-label="打开独立文件上传" title="文件上传" aria-haspopup="dialog" onClick={openUploads}><Icon name="upload" size={16} /><span>文件上传</span>{uploading > 0 && <small>{uploading}</small>}</button>
      <div className="theme-switcher" role="group" aria-label="界面主题">
        {([
          ['system', 'monitor', '跟随系统'],
          ['light', 'sun', '浅色模式'],
          ['dark', 'moon', '深色模式'],
        ] as const).map(([value, icon, label]) => <button type="button" key={value} className={theme === value ? 'selected' : ''} aria-label={label} title={label} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon name={icon} size={15} /></button>)}
      </div>
      <span className="header-divider" />
      <button className="user-menu" onClick={() => notify('zhangsan · 本地演示账户')}><span className="avatar">Z</span><span>zhangsan</span><Icon name="down" size={14} /></button>
    </div>
  </header>;
}
const items: { name: Navigation; label: string; subtitle: string; icon: IconName }[] = [
  { name: '连接', label: '连接', subtitle: '远程主机连接', icon: 'database' },
  { name: '命令', label: '终端', subtitle: '在线终端', icon: 'terminal' },
];
export function ActivityBar({ active, onSelect, onSettings, settingsOpen, collapsed, toggleCollapsed }: {
  active: Navigation;
  onSelect: (name: Navigation) => void;
  onSettings: () => void;
  settingsOpen: boolean;
  collapsed: boolean;
  toggleCollapsed: () => void;
}) {
  return <nav className="activity-bar" aria-label="主导航">
    <button className="nav-collapse-toggle" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-label={collapsed ? '展开导航栏' : '收起导航栏'} title={collapsed ? '展开导航栏' : '收起导航栏'}><Icon name="sidebar" size={19} /><span>收起导航</span></button>
    {items.map(item => <button key={item.name} aria-label={item.label} title={collapsed ? item.label : undefined} className={`activity ${active === item.name ? 'selected' : ''}`} aria-current={active === item.name ? 'page' : undefined} onClick={() => onSelect(item.name)}><Icon name={item.icon} size={23} /><span><strong>{item.label}</strong><small>{item.subtitle}</small></span></button>)}
    <button className={`activity ${settingsOpen ? 'selected' : ''}`} aria-label="客户端设置" title={collapsed ? '客户端设置' : undefined} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={onSettings}><Icon name="settings" size={23} /><span><strong>设置</strong><small>后端服务器</small></span></button>
    <div className="nav-footer"><div className="planet-art" aria-hidden="true"><i /><span /></div><strong>让开发更简单</strong><small>智能 · 高效 · 安全</small></div>
  </nav>;
}
