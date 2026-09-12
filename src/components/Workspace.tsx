import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Host, SavedCommand, TerminalSession } from '../types';
import { categories } from '../data/mock';
import { Icon, IconButton } from './Ui';
import { TerminalWelcome } from './TerminalWelcome';

function Prompt({ host }: { host?: Host }) {
  return <span className="terminal-prompt"><span>{`${host?.user ?? 'root'}@${host?.name ?? 'remote-host'}`}</span>:<span className="terminal-path">/var/www/app</span>$ </span>;
}
export function TerminalWorkspace({ remoteViews, sessions, activeId, host, select, close, add, changeInput, run, fillFocus, maximize, isMaximized, filesOpen, toggleFiles, filePanel, copy, connections }: { remoteViews: ReactNode; sessions: TerminalSession[]; activeId: string; host?: Host; select: (id: string) => void; close: (id: string) => void; add: () => void; changeInput: (text: string) => void; run: () => void; fillFocus: number; maximize: () => void; isMaximized: boolean; filesOpen: boolean; toggleFiles: () => void; filePanel: ReactNode; connections: () => void; copy: (text: string) => void }) {
  const active = sessions.find(session => session.id === activeId);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (fillFocus) inputRef.current?.focus(); }, [fillFocus]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [active?.entries.length, activeId]);
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
        <div className="terminal-output remote-command-entry" ref={scrollRef}>
          {active.entries.map(entry => <div className="terminal-entry" key={entry.id}><div><Prompt host={host} />{entry.command}</div><pre>{entry.output}</pre></div>)}
          {!host?.online && <p className="terminal-notice">主机离线，请重新连接后运行命令。</p>}
          <form className="terminal-input-row" onSubmit={event => { event.preventDefault(); run(); }}>
            <label htmlFor="terminal-input"><span className="terminal-prompt">命令 &gt; </span></label>
            <div className="terminal-input-wrap"><input id="terminal-input" ref={inputRef} value={active.input} aria-label="终端命令输入" autoComplete="off" spellCheck={false} disabled={active.busy || !host?.online} onChange={event => changeInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />{!active.input && !active.busy && <span className="block-cursor" />}</div>
            {active.busy && <span className="terminal-pending">提交中…</span>}
          </form>
        </div>
      </div>
    </div> : <TerminalWelcome add={add} connections={connections} />}
  </section>;
}
export function CommandShelf({ commands, category, setCategory, fill, run, copy, add, disabled, collapsed, toggleCollapsed }: { commands: SavedCommand[]; category: string; setCategory: (value: string) => void; fill: (command: string) => void; run: (command: string) => void; copy: (text: string) => void; add: () => void; disabled: boolean; collapsed: boolean; toggleCollapsed: () => void }) {
  const filtered = commands.filter(command => category === '全部' || command.category === category);
  return <section className={`command-shelf ${collapsed ? 'collapsed' : ''}`} id="commands" tabIndex={-1}><div className="section-heading"><button className="panel-title" onClick={toggleCollapsed} aria-expanded={!collapsed} title={collapsed ? '展开常用命令' : '收起常用命令'}><span className="command-toggle-icon"><Icon name={collapsed ? 'panelOpen' : 'panelClose'} size={19} /></span><h2>常用命令</h2><span className="panel-count">{commands.length}</span><span className="collapse-caption">{collapsed ? '展开' : '收起'}</span></button><button className="text-button" onClick={add}><Icon name="plus" />添加命令</button></div>{!collapsed && <><div className="command-categories" role="tablist" aria-label="命令分类">{categories.map(item => <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="command-list">{filtered.map(command => <div className="command-row" key={command.id}><button className="command-fill" onClick={() => fill(command.command)} title={`填入命令：${command.command}`}><Icon name={command.icon} size={20} /><span className="command-name">{command.name}</span><code>{command.command}</code></button><button className="run-command labeled-run" aria-label={`运行 ${command.name}`} disabled={disabled} onClick={() => run(command.command)}><Icon name="play" size={14} />运行</button><IconButton icon="copy" label={`复制 ${command.name}`} onClick={() => copy(command.command)} /></div>)}{!filtered.length && <div className="empty-state">此分类暂无命令<button className="text-button mint" onClick={add}>添加第一条命令</button></div>}</div><p className="command-hint">点击命令可填入当前终端</p></>}</section>;
}
