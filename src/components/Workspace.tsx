import type { ReactNode } from 'react';
import type { Host, SavedCommand, TerminalSession } from '../types';
import { commandCategoryIcon } from '../data/mock';
import { Icon, IconButton } from './Ui';
import { TerminalWelcome } from './TerminalWelcome';

export function TerminalWorkspace({ remoteViews, sessions, activeId, host, select, close, add, filesOpen, toggleFiles, commandCollapsed, toggleCommands, agentCollapsed, toggleAgent, filePanel, copy, connections }: { remoteViews: ReactNode; sessions: TerminalSession[]; activeId: string; host?: Host; select: (id: string) => void; close: (id: string) => void; add: () => void; filesOpen: boolean; toggleFiles: () => void; commandCollapsed: boolean; toggleCommands: () => void; agentCollapsed: boolean; toggleAgent: () => void; filePanel: ReactNode; connections: () => void; copy: (text: string) => void }) {
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
          <div className="inline-actions workspace-panel-controls" aria-label="工作区面板">
            <IconButton icon="folder" label={filesOpen ? '收起文件' : '打开文件'} className={filesOpen ? 'selected' : ''} onClick={toggleFiles} aria-pressed={filesOpen} aria-expanded={filesOpen} aria-controls="files" />
            <IconButton icon="terminal" label={commandCollapsed ? '展开常用命令' : '收起常用命令'} className={!commandCollapsed ? 'selected' : ''} onClick={toggleCommands} aria-pressed={!commandCollapsed} aria-expanded={!commandCollapsed} aria-controls="command-shelf-content" />
            <IconButton icon="bot" label={agentCollapsed ? '展开智能体对话' : '收起智能体对话'} className={!agentCollapsed ? 'selected' : ''} onClick={toggleAgent} aria-pressed={!agentCollapsed} aria-expanded={!agentCollapsed} aria-controls="agent-panel-content" />
          </div>
        </div>
        <>{remoteViews}</>
      </div>
    </div> : <TerminalWelcome add={add} connections={connections} />}
  </section>;
}
export function CommandShelf({ commands, category, setCategory, fill, run, copy, add, disabled, collapsed }: { commands: SavedCommand[]; category: string; setCategory: (value: string) => void; fill: (command: string) => void; run: (command: string) => void; copy: (text: string) => void; add: () => void; disabled: boolean; collapsed: boolean }) {
  const filtered = commands.filter(command => category === '全部' || command.category === category);
  const categoryCards = ['全部', ...new Set(commands.map(command => command.category))];
  return <section className={`command-shelf ${collapsed ? 'collapsed' : ''}`} id="commands" tabIndex={-1}>
    <div className="command-shelf-inner" id="command-shelf-content" aria-hidden={collapsed}>
      <div className="section-heading"><div className="panel-title"><div className="command-library-heading"><h2>常用命令</h2><small>本机持久化命令库</small></div><span className="panel-count">{commands.length}</span></div><button className="text-button command-add-button" onClick={add}><Icon name="plus" />新增</button></div>
      <div className="command-categories" role="tablist" aria-label="命令分类">{categoryCards.map(item => { const count = item === '全部' ? commands.length : commands.filter(command => command.category === item).length; return <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}><Icon name={item === '全部' ? 'terminal' : commandCategoryIcon(item)} size={16} /><span>{item}</span><small>{count}</small></button>; })}</div>
      <div className="command-list-heading"><span>{category}</span><small>{filtered.length} 条命令</small></div>
      <div className="command-list">{filtered.map(command => <div className="command-row" key={command.id}><button className="command-fill" onClick={() => fill(command.command)} title={`填入终端：${command.command}`}><Icon name={command.icon} size={20} /><span className="command-name">{command.name}</span><code>{command.command}</code></button><button className="run-command labeled-run" aria-label={`运行 ${command.name}`} disabled={disabled} onClick={() => run(command.command)}><Icon name="play" size={14} />运行</button><IconButton icon="copy" label={`复制 ${command.name}`} onClick={() => copy(command.command)} /></div>)}{!filtered.length && <div className="empty-state">此分类暂无命令<button className="text-button mint" onClick={add}>添加第一条命令</button></div>}</div>
      <p className="command-hint">点击命令写入终端，点击运行直接执行</p>
    </div>
  </section>;
}
