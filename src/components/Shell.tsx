import type { Navigation } from '../types';
import type { ThemePreference } from '../state/useTheme';
import { Icon } from './Ui';
import type { IconName } from './Ui';
import { dragAppWindow } from '../state/appWindow';
import { WindowControls } from './WindowControls';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauriRuntime } from '../state/runtime';
import type { RustSettingsSection } from './RustBackendSettingsDialog';
import { settingsNavigation } from '../config/settingsNavigation';
import { NavigationButton } from './NavigationButton';
import './Shell.css';

const PROJECT_GITHUB_URL = 'https://github.com/jasonlat-dot/ai-ssh-terminal-server';
export function AppHeader({ notify, theme, setTheme }: {
  notify: (text: string) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}) {
  return <header className="app-header" onMouseDown={dragAppWindow}>
    <div className="brand"><img className="brand-mark" src="/agent-ssh-header.svg" alt="" draggable={false} /><div><strong>ShellPilot</strong><small>轻量 SSH 终端试用版</small></div></div>
    <span className="rust-preview-badge">Rust Preview · 0.4.0</span>
    <div className="profile">
      <div className="theme-switcher" role="group" aria-label="界面主题">
        {([
          ['system', 'monitor', '跟随系统'],
          ['light', 'sun', '浅色模式'],
          ['dark', 'moon', '深色模式'],
        ] as const).map(([value, icon, label]) => <button type="button" key={value} className={theme === value ? 'selected' : ''} aria-label={label} title={label} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon name={icon} size={15} /></button>)}
      </div>
      <span className="header-divider" />
      <a className="user-menu github-link" href={PROJECT_GITHUB_URL} target="_blank" rel="noopener noreferrer"
        aria-label="jasonlat · 打开 GitHub 项目" title="jasonlat · GitHub 项目"
        onClick={event => {
          if (!isTauriRuntime()) return;
          event.preventDefault();
          void openUrl(PROJECT_GITHUB_URL).catch(() => notify('无法打开 GitHub 项目，请检查系统浏览器。'));
        }}><span className="avatar"><Icon name="github" size={21} /></span><span>jasonlat</span><Icon name="upRight" size={14} /></a>
      <WindowControls />
    </div>
  </header>;
}
const items: { name: Navigation; label: string; subtitle: string; icon: IconName }[] = [
  { name: '命令', label: '终端', subtitle: 'SSH 与本地命令行', icon: 'terminalWindow' },
];
export function ActivityBar({ active, onSelect, onSettings, settingsOpen, collapsed, toggleCollapsed, settingsSection, onSettingsSection }: {
  active: Navigation;
  onSelect: (name: Navigation) => void;
  onSettings: () => void;
  settingsOpen: boolean;
  collapsed: boolean;
  toggleCollapsed: () => void;
  settingsSection?: RustSettingsSection;
  onSettingsSection?: (section: RustSettingsSection) => void;
}) {
  return <nav className="activity-bar" aria-label="主导航">
    <NavigationButton collapsed={collapsed} label={collapsed ? '展开导航栏' : '收起导航栏'} className="nav-collapse-toggle" onClick={toggleCollapsed} aria-expanded={!collapsed}><Icon name={collapsed ? 'panelOpen' : 'panelClose'} size={19} /><span>收起导航</span></NavigationButton>
    {items.map(item => <NavigationButton key={item.name} collapsed={collapsed} label={item.label} description={item.subtitle} className={`activity ${!settingsOpen && active === item.name ? 'selected' : ''}`} aria-current={!settingsOpen && active === item.name ? 'page' : undefined} onClick={() => onSelect(item.name)}><span className="activity-icon"><Icon name={item.icon} size={21} /></span><span className="activity-label" aria-hidden={collapsed}><strong>{item.label}</strong><small>{item.subtitle}</small></span></NavigationButton>)}
    {onSettingsSection ? <>
      <div className="activity-section-divider" aria-hidden="true"/>
      {settingsNavigation.map(item=><NavigationButton key={item.section} collapsed={collapsed} label={item.label} description={item.subtitle} className={`activity ${settingsOpen && settingsSection===item.section ? 'selected' : ''}`} aria-current={settingsOpen && settingsSection===item.section ? 'page' : undefined} onClick={()=>onSettingsSection(item.section)}><span className="activity-icon"><Icon name={item.icon} size={21}/></span><span className="activity-label" aria-hidden={collapsed}><strong>{item.label}</strong><small>{item.subtitle}</small></span></NavigationButton>)}
    </> : <NavigationButton collapsed={collapsed} label="客户端设置" description="管理本地工作区" className={`activity ${settingsOpen ? 'selected' : ''}`} aria-current={settingsOpen ? 'page' : undefined} onClick={onSettings}><span className="activity-icon"><Icon name="workspace" size={21} /></span><span className="activity-label" aria-hidden={collapsed}><strong>设置</strong><small>本地工作区</small></span></NavigationButton>}
    <div className="nav-footer"><div className="planet-art" aria-hidden="true"><i /><span /></div><strong>让开发更简单</strong><small>智能 · 高效 · 安全</small></div>
  </nav>;
}
