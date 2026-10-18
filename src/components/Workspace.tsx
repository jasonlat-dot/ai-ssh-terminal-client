import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalLayout } from '../state/terminalLayout';
import type { Host, SavedCommand, TerminalSession } from '../types';
import { commandCategoryIcon } from '../data/mock';
import { AccentIcon, Badge, Icon, IconButton, toneForIcon } from './Ui';
import { TerminalWelcome } from './TerminalWelcome';
import { isSessionConnected } from '../state/terminalSessions';
import { Select } from './Select';

export function TerminalWorkspace({ remoteViews, sessions, activeId, host, select, close, add, filesOpen, toggleFiles, commandCollapsed, toggleCommands, agentCollapsed, toggleAgent, filesAvailable = true, agentAvailable = true, copy, connections, layout = 'single', visibleIds = [activeId], changeLayout, reorder, commandControls, dockControls, agentTerminalId }: { remoteViews: ReactNode; sessions: TerminalSession[]; activeId: string; host?: Host; select: (id: string) => void; close: (id: string) => void; add: () => void; filesOpen: boolean; toggleFiles: () => void; commandCollapsed: boolean; toggleCommands: () => void; agentCollapsed: boolean; toggleAgent: () => void; filesAvailable?: boolean; agentAvailable?: boolean; connections: () => void; copy: (text: string) => void; layout?: TerminalLayout; visibleIds?: string[]; changeLayout?: (layout: TerminalLayout) => void; reorder?: (draggedId: string, targetId: string, after: boolean) => void; commandControls?: ReactNode; dockControls?: ReactNode; agentTerminalId?:string }) {
  const active = sessions.find(session => session.id === activeId);
  const dragging = useRef<{ id: string; pointerId: number; x: number; y: number; left: number; top: number; width: number; node: HTMLDivElement; moved: boolean; target: { id: string; after: boolean } | null } | null>(null);
  const suppressClick = useRef(false);
  const [draggedId, setDraggedId] = useState('');
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dragPreview, setDragPreview] = useState<{ title: string; left: number; top: number; width: number } | null>(null);
  const releaseDrag = () => {
    const drag = dragging.current; dragging.current = null;
    if (drag?.node.hasPointerCapture(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId);
  };
  const finishDrag = () => { releaseDrag(); setDraggedId(''); setDropTarget(null); setDragPreview(null); };
  useEffect(() => {
    const cancel = () => finishDrag();
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); releaseDrag(); };
  }, []);
  return <section className="terminal-workspace" aria-label="终端工作区">
    {dockControls && <header className="terminal-dock-heading">{dockControls}</header>}
    {dragPreview && createPortal(<div className="terminal-tab-drag-preview" aria-hidden="true"
      style={{ width: dragPreview.width, transform: `translate3d(${dragPreview.left}px, ${dragPreview.top}px, 0)` }}>
      <Icon name="terminal" size={14} /><span>{dragPreview.title}</span></div>, document.body)}
    <span className="terminal-layout-announcement" role="status">{announcement}</span>
    <div className="terminal-tab-strip">
    <div className="terminal-tabs" role="tablist" aria-label="终端会话">
      {sessions.map((session, index) => <div className={"terminal-tab " + (session.id === activeId ? 'selected' : '')} key={session.id}
        data-visible={layout !== 'single' && visibleIds.includes(session.id)}
        data-terminal-id={session.id} data-dragging={draggedId === session.id} data-reorderable={!!reorder}
        data-drop={dropTarget?.id === session.id ? dropTarget.after ? 'after' : 'before' : undefined}
          onDragStart={event => event.preventDefault()}
          onPointerDown={event => {
            if (!reorder || event.button !== 0 || event.isPrimary === false || dragging.current) return;
            const button = (event.target as Element).closest('button');
            if (button && button.getAttribute('role') !== 'tab') return;
            // Stop browser/native text dragging before capture; the whole tab is the handle.
            event.preventDefault();
            event.currentTarget.querySelector<HTMLElement>('[role="tab"]')?.focus({ preventScroll: true });
            const rect = event.currentTarget.getBoundingClientRect();
            dragging.current = { id: session.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
              left: rect.left, top: rect.top, width: rect.width, node: event.currentTarget, moved: false, target: null };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const drag = dragging.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
            drag.moved = true; event.preventDefault(); setDraggedId(drag.id);
            setDragPreview({ title: session.title, left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y, width: drag.width });
            const tabList = event.currentTarget.closest('.terminal-tabs');
            // Scroll long tab strips while dragging near their edges.
            if (tabList) {
              const bounds = tabList.getBoundingClientRect();
              if (event.clientX < bounds.left + 28) tabList.scrollLeft -= 16;
              else if (event.clientX > bounds.right - 28) tabList.scrollLeft += 16;
            }
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-terminal-id]');
            if (!target || target.closest('.terminal-tabs') !== tabList) { drag.target = null; setDropTarget(null); return; }
            const box = target.getBoundingClientRect();
            drag.target = { id: target.dataset.terminalId!, after: event.clientX > box.left + box.width / 2 };
            setDropTarget(drag.target);
          }}
          onPointerUp={event => {
            const drag = dragging.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            // Capture retargets pointer-up/click to the outer tab, so an ordinary
            // press must activate here instead of relying on the inner button.
            // Suppress any trailing click; keyboard activation still uses onClick.
            suppressClick.current = true;
            setTimeout(() => { suppressClick.current = false; }, 0);
            if (drag.moved) {
              if (drag.target && drag.id !== drag.target.id) {
                reorder?.(drag.id, drag.target.id, drag.target.after);
                setAnnouncement('终端页签顺序已调整');
              }
            } else {
              select(drag.id);
            }
            finishDrag();
          }}
          onPointerCancel={event => {
            if (dragging.current?.pointerId !== event.pointerId) return;
            finishDrag();
          }} onLostPointerCapture={event => { if (dragging.current?.pointerId === event.pointerId) finishDrag(); }}
        >
        <button role="tab" aria-selected={session.id === activeId}
          title="拖动调整顺序；Ctrl+Shift+左右方向键也可排序"
          onKeyDown={event => {
            if (event.key === 'Escape' && dragging.current) {
              event.preventDefault(); finishDrag();
              return;
            }
            if (!reorder || !event.ctrlKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            const target = sessions[index + (event.key === 'ArrowLeft' ? -1 : 1)];
            if (target) { reorder(session.id, target.id, event.key === 'ArrowRight'); setAnnouncement(`${session.title} 已移动`); }
          }} onClick={() => { if (!suppressClick.current) select(session.id); }}><i className={"status-dot " + (session.connectionStatus === 'unreachable' ? 'unreachable' : isSessionConnected(session) ? '' : 'offline')} /><span>{session.title}</span>{session.connectionStatus === 'unreachable' && <span className="terminal-tab-state">不可达</span>}</button>
        {!!agentTerminalId&&session.terminalSessionId===agentTerminalId&&<span className="terminal-agent-binding" role="img" title="当前 Agent 对话关联此终端" aria-label="当前 Agent 对话关联此终端"><Icon name="bot" size={14}/></span>}
        <IconButton icon="close" label={'关闭 ' + session.title} onClick={() => close(session.id)} />
      </div>)}
      <button className="new-terminal-button" onClick={add} title="新建本地 CMD"><Icon name="tabs" size={17} /><span>新建终端</span></button>
    </div>
    {changeLayout && <div className="terminal-layout-control"><Icon name="sidebar" size={15} /><span>布局</span>
      <Select label="终端分屏布局" className="terminal-layout-select" value={layout} onChange={changeLayout}
        options={[{ value: 'single' as TerminalLayout, label: '单窗口' }, ...(sessions.length < 2 ? [] : [
          { value: 'columns' as TerminalLayout, label: '左右分屏' }, { value: 'rows' as TerminalLayout, label: '上下分屏' },
          { value: 'grid' as TerminalLayout, label: '网格分屏 · 最多四窗' },
        ])]} /></div>}
    </div>
    {active ? <div className="terminal-body">
      <div className="terminal-pane">
        <div className="terminal-toolbar">
          <i className={"terminal-connection-dot " + (active.connectionStatus === 'unreachable' ? 'unreachable' : !isSessionConnected(active) ? 'offline' : '')} aria-hidden="true" />
          <span>{active.kind === 'local' ? `本地 · cmd.exe · ${host?.address ?? ''}` : (host?.user ?? '') + '@' + (host?.address ?? '')}</span>
          {!!agentTerminalId&&active.terminalSessionId===agentTerminalId&&<span className="terminal-agent-binding toolbar-binding" role="img" title="Agent 已关联 · 命令将在此终端的当前 Shell 中执行" aria-label="当前 Agent 对话关联此终端"><Icon name="bot" size={14}/></span>}
          {active.connectionStatus === 'unreachable' && <Badge tone="amber" icon="alert">服务不可达</Badge>}
          {active.kind === 'ssh' && <IconButton icon="copy" label="复制主机地址" onClick={() => copy(host?.address ?? '')} />}
          <div className="inline-actions workspace-panel-controls" aria-label="工作区面板">
            {active.kind === 'ssh' && <button type="button" className={`terminal-files-toggle ${filesOpen ? 'selected' : ''}`} disabled={!filesAvailable}
              title={filesAvailable ? filesOpen ? '收起 SFTP 文件管理' : '打开 SFTP 文件管理' : 'SFTP 文件管理（后续版本）'}
              aria-label={filesOpen ? '收起 SFTP 文件管理' : '打开 SFTP 文件管理'} onClick={toggleFiles} aria-pressed={filesOpen} aria-expanded={filesOpen}>
              <Icon name="folder" size={15}/><span>文件 · SFTP</span>
            </button>}
            <button type="button" className={`terminal-command-toggle ${!commandCollapsed ? 'selected' : ''}`}
              title={commandCollapsed ? '展开常用命令' : '收起常用命令'} aria-label={commandCollapsed ? '展开常用命令' : '收起常用命令'}
              onClick={toggleCommands} aria-pressed={!commandCollapsed} aria-expanded={!commandCollapsed} aria-controls="command-shelf-content">
              <Icon name="terminal" size={15}/><span>{commandCollapsed ? '展开命令' : '常用命令'}</span>
              <Icon name={commandCollapsed ? 'up' : 'down'} size={13}/>
            </button>
            <button type="button" className={`terminal-agent-toggle ${!agentCollapsed ? 'selected' : ''}`} disabled={!agentAvailable}
              title={!agentAvailable ? 'AI 功能（后续版本）' : agentCollapsed ? '展开智能体对话' : '收起智能体对话'}
              aria-label={agentCollapsed ? '展开智能体对话' : '收起智能体对话'} onClick={toggleAgent}
              aria-pressed={!agentCollapsed} aria-expanded={!agentCollapsed} aria-controls="agent-panel-content">
              <Icon name="bot" size={15}/><span>{agentCollapsed ? '展开对话' : 'Agent 对话'}</span>
              <Icon name={agentCollapsed ? 'left' : 'right'} size={13}/>
            </button>
          </div>
        </div>
        {commandControls}
        <div className="terminal-view-grid" data-layout={layout} data-count={visibleIds.length}>{remoteViews}</div>
      </div>
    </div> : <TerminalWelcome add={add} connections={connections} />}
  </section>;
}
export function CommandShelf({ commands, category, setCategory, fill, run, copy, add, disabled, collapsed, resize, broadcast = false }: { commands: SavedCommand[]; category: string; setCategory: (value: string) => void; fill: (command: string) => void; run: (command: string) => void; copy: (text: string) => void; add: () => void; disabled: boolean; collapsed: boolean; resize?: ReactNode; broadcast?: boolean }) {
  const filtered = commands.filter(command => category === '全部' || command.category === category);
  const categoryCards = ['全部', ...new Set(commands.map(command => command.category))];
  return <section className={`command-shelf ${collapsed ? 'collapsed' : ''}`} id="commands" tabIndex={-1}>
    {resize}
    <div className="command-shelf-inner" id="command-shelf-content" aria-hidden={collapsed}>
      <div className="section-heading"><div className="panel-title"><AccentIcon icon="terminal" tone="blue" size={16}/><div className="command-library-heading"><h2>常用命令</h2><small>本机持久化命令库</small></div><Badge tone="violet" className="panel-count">{commands.length}</Badge></div><button className="text-button command-add-button" onClick={add}><Icon name="plus" />新增</button></div>
      <div className="command-categories" role="tablist" aria-label="命令分类">{categoryCards.map(item => {
        const count = item === '全部' ? commands.length : commands.filter(command => command.category === item).length;
        const icon = item === '全部' ? 'terminal' : commandCategoryIcon(item);
        return <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>
          <AccentIcon icon={icon} size={14} className="command-category-icon" /><span>{item}</span><Badge tone={toneForIcon(icon)}>{count}</Badge>
        </button>;
      })}</div>
      <div className="command-list-heading"><span>{category}</span><small>{filtered.length} 条命令</small></div>
      <div className="command-list">{filtered.map(command => <div className="command-row" key={command.id}><button className="command-fill" onClick={() => fill(command.command)} title={`填入${broadcast ? '广播输入条' : '终端'}：${command.command}`}><AccentIcon icon={command.icon} size={16} className="command-row-icon" /><span className="command-name">{command.name}</span><code>{command.command}</code></button><button className="run-command labeled-run" aria-label={`${broadcast ? '广播运行' : '运行'} ${command.name}`} disabled={disabled} onClick={() => run(command.command)}><Icon name="play" size={14} />运行</button><IconButton icon="copy" label={`复制 ${command.name}`} onClick={() => copy(command.command)} /></div>)}{!filtered.length && <div className="empty-state">此分类暂无命令<button className="text-button mint" onClick={add}>添加第一条命令</button></div>}</div>
      <p className="command-hint">{broadcast ? '广播已启用：点击命令填入广播输入条，运行发送至目标终端' : '点击命令写入终端，点击运行直接执行'}</p>
    </div>
  </section>;
}
