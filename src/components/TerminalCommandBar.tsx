import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import type { TerminalCommandMode } from '../state/terminalBroadcast';
import { Select } from './Select';
import { Badge, Icon } from './Ui';
import './TerminalCommandBar.css';

export function TerminalCommandBar({ mode, changeMode, sessions, selectedIds, toggleTarget, targetCount, draft, changeDraft,
  inputRef, submit, busy }: {
  mode: TerminalCommandMode; changeMode: (mode: TerminalCommandMode) => void;
  sessions: readonly { id: string; title: string; address: string; available: boolean }[];
  selectedIds: readonly string[]; toggleTarget: (id: string) => void; targetCount: number;
  draft: string; changeDraft: (draft: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>;
  submit: () => void; busy: boolean;
}) {
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field || mode === 'single') return;
    const resize = () => {
      // CSS caps the height; wrapping is visual only and never inserts command newlines.
      field.style.height = '0px';
      field.style.height = `${field.scrollHeight + 2}px`;
    };
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [draft, mode, inputRef]);
  const submitDraft = () => { if (!busy && targetCount && draft.trim()) submit(); };
  return <section className="terminal-command-bar" aria-label="手工与常用命令执行目标" data-broadcast={mode !== 'single'}>
    <div className="terminal-command-scope"><span><Icon name="network" size={14} />命令目标</span>
      <Select label="命令执行范围" className="terminal-command-mode" value={mode} disabled={busy} onChange={changeMode}
        options={[{ value: 'single', label: '当前终端' }, { value: 'all', label: '全部终端' }, { value: 'selected', label: '勾选终端' }]} />
      {mode !== 'single' && <Badge tone="amber" icon="alert">{busy ? '广播 · 正在提交' : `广播 · ${targetCount} 个可用终端`}</Badge>}
      <Badge tone="blue" icon="bot" className="terminal-command-agent">Agent 始终单终端</Badge>
    </div>
    {mode === 'selected' && <div className="terminal-command-targets" role="group" aria-label="广播目标终端">
      {sessions.map((session, index) => <label key={session.id} data-selected={selectedIds.includes(session.id)} title={`${session.title} · ${session.address}`}>
        <input type="checkbox" checked={selectedIds.includes(session.id)} disabled={busy} onChange={() => toggleTarget(session.id)} />
        <span>{index + 1}. {session.title}</span>{!session.available && <small>不可用</small>}
      </label>)}
    </div>}
    {mode !== 'single' && <>
      <form className="terminal-broadcast-form" onSubmit={event => { event.preventDefault(); submitDraft(); }}>
        <textarea ref={inputRef} id="terminal-broadcast-command" className="code-input" rows={1} wrap="soft"
          value={draft} disabled={busy} spellCheck={false}
          aria-label="手工广播命令" aria-describedby="terminal-broadcast-help" placeholder="输入命令，Enter 执行 · Shift+Enter 换行"
          onChange={event => changeDraft(event.target.value)} onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat) submitDraft();
          }} />
        <button type="submit" disabled={busy || !targetCount || !draft.trim()}><Icon name="play" size={13} />{busy ? '正在提交…' : `执行到 ${targetCount} 个终端`}</button>
      </form>
      <p id="terminal-broadcast-help">Enter 执行 · Shift+Enter 换行。{mode === 'all' ? '包含未显示的已连接页签。' : '只发送至勾选且连接可用的终端。'}常用命令使用相同目标；普通终端交互不广播。</p>
    </>}
  </section>;
}
