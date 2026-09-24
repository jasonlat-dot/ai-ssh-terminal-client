import type { ReactNode } from 'react';
import type { Host, SavedCommand, TerminalSession } from '../types';
import { commandCategoryIcon } from '../data/mock';
import { Icon, IconButton } from './Ui';
import { TerminalWelcome } from './TerminalWelcome';

export function TerminalWorkspace({ remoteViews, sessions, activeId, host, select, close, add, maximize, isMaximized, filesOpen, toggleFiles, filePanel, copy, connections }: { remoteViews: ReactNode; sessions: TerminalSession[]; activeId: string; host?: Host; select: (id: string) => void; close: (id: string) => void; add: () => void; maximize: () => void; isMaximized: boolean; filesOpen: boolean; toggleFiles: () => void; filePanel: ReactNode; connections: () => void; copy: (text: string) => void }) {
  const active = sessions.find(session => session.id === activeId);
  return <section className="terminal-workspace" aria-label="终端工作区">
    <div className="terminal-tabs" role="tablist" aria-label="终端会话">
      {sessions.map(session => <div className={"terminal-tab " + (session.id === activeId ? 'selected' : '')} key={session.id}>
        <button role="tab" aria-selected={session.id === activeId} onClick={() => select(session.id)}><i className={"status-dot " + (session.id === activeId && !host?.online ? 'offline' : '')} /><span>{session.title}</span></button>
        <IconButton icon="close" label={'关闭 ' + session.title} onClick={() => close(session.id)} />
      </div>)}
      <button className="new-terminal-button" onClick={add} title="添加 SSH 连接"><Icon name="tabs" size={17} /><span>新建终端</span></button>
    </div>
    {active ? <div className={"terminal-body " + (filesOpen ? 'with-files' : '')}>
      {filesOpen && filePanel}
      <div className="terminal-pane">
        <div className="terminal-toolbar">
          <i className={"terminal-connection-dot " + (!host?.online ? 'offline' : '')} aria-hidden="true" />
          <span>{(host?.user ?? '') + '@' + (host?.address ?? '')}</span>
          <IconButton icon="copy" label="复制主机地址" onClick={() => copy(host?.address ?? '')} />
          <div className="inline-actions">
            <button className={"terminal-layout-button file-panel-toggle " + (filesOpen ? 'selected' : '')} onClick={toggleFiles} aria-expanded={filesOpen} aria-controls={filesOpen ? 'files' : undefined} title={filesOpen ? '收起当前终端的文件面板' : '打开当前终端的文件面板'}><Icon name="folder" size={16} /><span>{filesOpen ? '收起文件' : '打开文件'}</span></button>
            <button className="terminal-layout-button" onClick={maximize} title={isMaximized ? '恢复终端与助手布局' : '展开终端，隐藏助手'} aria-label={isMaximized ? '恢复终端布局' : '最大化终端'}><Icon name={isMaximized ? 'restore' : 'maximize'} size={16} /><span>{isMaximized ? '恢复布局' : '专注终端'}</span></button>
          </div>
        </div>
        <>{remoteViews}</>
      </div>
    </div> : <TerminalWelcome add={add} connections={connections} />}
  </section>;
}
export function CommandShelf({ commands, category, setCategory, fill, run, copy, add, disabled, collapsed, toggleCollapsed }: { commands: SavedCommand[]; category: string; setCategory: (value: string) => void; fill: (command: string) => void; run: (command: string) => void; copy: (text: string) => void; add: () => void; disabled: boolean; collapsed: boolean; toggleCollapsed: () => void }) {
  const filtered = commands.filter(command => category === '全部' || command.category === category);
  const categoryCards = ['全部', ...new Set(commands.map(command => command.category))];
  return <section className={`command-shelf ${collapsed ? 'collapsed' : ''}`} id="commands" tabIndex={-1}>
    <button className="command-panel-toggle" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-controls="command-shelf-content" title={collapsed ? '展开常用命令' : '收起常用命令'}><Icon name="right" size={16} /></button>
    <div className="command-shelf-inner" id="command-shelf-content" aria-hidden={collapsed}>
      <div className="section-heading"><div className="panel-title"><span className="command-library-icon"><Icon name="terminal" size={17} /></span><div className="command-library-heading"><h2>常用命令</h2><small>本机持久化命令库</small></div><span className="panel-count">{commands.length}</span></div><button className="text-button command-add-button" onClick={add}><Icon name="plus" />新增</button></div>
      <div className="command-categories" role="tablist" aria-label="命令分类">{categoryCards.map(item => { const count = item === '全部' ? commands.length : commands.filter(command => command.category === item).length; return <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}><Icon name={item === '全部' ? 'terminal' : commandCategoryIcon(item)} size={16} /><span>{item}</span><small>{count}</small></button>; })}</div>
      <div className="command-list-heading"><span>{category}</span><small>{filtered.length} 条命令</small></div>
      <div className="command-list">{filtered.map(command => <div className="command-row" key={command.id}><button className="command-fill" onClick={() => fill(command.command)} title={`填入终端：${command.command}`}><Icon name={command.icon} size={20} /><span className="command-name">{command.name}</span><code>{command.command}</code></button><button className="run-command labeled-run" aria-label={`运行 ${command.name}`} disabled={disabled} onClick={() => run(command.command)}><Icon name="play" size={14} />运行</button><IconButton icon="copy" label={`复制 ${command.name}`} onClick={() => copy(command.command)} /></div>)}{!filtered.length && <div className="empty-state">此分类暂无命令<button className="text-button mint" onClick={add}>添加第一条命令</button></div>}</div>
      <p className="command-hint">点击命令写入终端，点击运行直接执行</p>
    </div>
  </section>;
}
