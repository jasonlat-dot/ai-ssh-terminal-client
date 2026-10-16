import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { agentApi, type AgentMemories, type AgentMemory, type AgentMemoryWrite, type AgentProject } from '../api/agent';
import { Icon, Modal, Toggle } from './Ui';
import { Select } from './Select';
import './AgentMemory.css';

export type MemoryScope = { agentId: string; sessionId: string; projectId?: string };
type Entry = AgentMemories['items'][number];

// Only editable fields cross IPC. Native code owns target identity and provenance.
function editable(memory: AgentMemoryWrite): AgentMemoryWrite {
  const { id, revision, title, content, kind, scope, enabled } = memory;
  return { id, revision, title, content, kind, scope, enabled };
}
function sameTarget(a: AgentMemory['target'], b: AgentMemory['target']) {
  return !!a && !!b && a.connectionId === b.connectionId && a.identity.host === b.identity.host
    && a.identity.port === b.identity.port && a.identity.username === b.identity.username && a.identity.hostKey === b.identity.hostKey;
}
function scopeLabel(item: AgentMemory, projects: AgentProject[]) {
  if (item.scope === 'global') return { text: '全局生效', kind: 'global' as const };
  const identity = item.target?.identity;
  const project = item.source.projectId ? projects.find(value => value.id === item.source.projectId)
    : projects.find(value => value.connectionId === item.target?.connectionId && !!value.identity && !!identity
      && value.identity.host === identity.host && value.identity.port === identity.port
      && value.identity.username === identity.username && value.identity.hostKey === identity.hostKey);
  const server = identity ? `${identity.host}:${identity.port}` : '服务器地址未知';
  return { text: `${project?.name ?? '服务器'} · ${server}`, kind: 'project' as const };
}
function message(cause: unknown) {
  if ((cause as { code?: string })?.code === 'AGENT_MEMORY_CHANGED') return '记录已在其他窗口更改，编辑文字已保留。请刷新并核对最新版本后再保存。';
  return cause instanceof Error ? cause.message : '操作失败，请重试。';
}
function updatedAt(timestamp: number) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : '未知时间';
}

export function AgentMemoryButton({ scope }: { scope: MemoryScope }) {
  const [open, setOpen] = useState(false);
  const key = `${scope.agentId}:${scope.sessionId}:${scope.projectId ?? ''}`;
  useEffect(() => { setOpen(false); }, [key]);
  return <>
    <button type="button" className="agent-memory-button" aria-label="管理长期记忆" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(true)}><Icon name="book" size={15} /><span>记忆</span></button>
    {open && createPortal(<AgentMemoryDialog key={key} scope={scope} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

export function AgentMemoryDialog({ scope, onClose }: { scope: MemoryScope; onClose: () => void }) {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [projectReload, setProjectReload] = useState(0);
  const [listing, setListing] = useState<AgentMemories | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);
  const [draft, setDraft] = useState<AgentMemoryWrite | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  const [saving, setSaving] = useState('');
  const pending = useRef(false);
  const alive = useRef(true);
  const enabledHelp = useId();
  const view = scope;
  const canEdit = (item: Entry) => item.scope === 'global' || sameTarget(item.target, listing?.target ?? null);
  const locked = !!saving || loading;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setProjectsLoading(true); setProjectsError('');
    void agentApi.projects().then(items => { if (!cancelled) setProjects(items); })
      .catch(cause => { if (!cancelled) setProjectsError(message(cause)); })
      .finally(() => { if (!cancelled) setProjectsLoading(false); });
    return () => { cancelled = true; };
  }, [projectReload]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setListing(null); setError('');
    void agentApi.memories(view.agentId, view.sessionId, view.projectId).then(result => {
      if (cancelled) return;
      setListing(result);
      // Explicit refresh adopts only the latest revision; the user's draft is retained.
      setDraft(current => {
        const latest = current && result.items.find(item => item.id === current.id);
        return current && latest ? { ...current, revision: latest.revision } : current;
      });
    }).catch(cause => { if (!cancelled) setError(message(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view.agentId, view.sessionId, view.projectId, reload]);

  async function mutate(id: string, action: () => Promise<void>) {
    if (pending.current || loading || !listing) return;
    pending.current = true; setSaving(id); setError('');
    try { await action(); }
    catch (cause) { if (alive.current) setError(message(cause)); }
    finally { pending.current = false; if (alive.current) setSaving(''); }
  }
  function replace(saved: AgentMemory) {
    if (!alive.current) return;
    setListing(current => current && ({ ...current, items: [
      { ...saved, applicable: saved.scope === 'global' || sameTarget(saved.target, current.target) },
      ...current.items.filter(item => item.id !== saved.id),
    ] }));
  }
  function save() {
    if (!draft || locked || !listing || (draft.scope === 'server' && !listing.target)) return;
    const input = { ...editable(draft), title: draft.title.trim(), content: draft.content.trim() };
    const bytes = new TextEncoder();
    if (!input.title || !input.content) { setError('请填写记忆标题和内容。'); return; }
    if (bytes.encode(input.title).length > 120 || bytes.encode(input.content).length > 2048) {
      setError('标题或内容过长，请缩短后保存（标题最多 120 字节，内容最多 2048 字节）。'); return;
    }
    void mutate(input.id, async () => {
      const result = await agentApi.saveMemory(view.agentId, view.sessionId, input, view.projectId);
      if (!alive.current) return;
      replace(result); setDraft(null);
    });
  }
  const items = listing?.items.filter(item => all || item.applicable) ?? [];
  return <Modal title="长期记忆" className="agent-memory-dialog" dismissDisabled={!!saving} onClose={onClose}>
    <div className="agent-memory-body">
      <p className="agent-memory-intro">保存你确认的偏好与经验，供后续对话参考。记忆不会自动授予工具执行权限。</p>
      {projectsLoading && <p className="agent-memory-muted" role="status">正在读取服务器项目…</p>}
      {projectsError && <p className="agent-memory-error" role="alert">项目读取失败：{projectsError} <button type="button" onClick={() => setProjectReload(value => value + 1)}>重试项目列表</button></p>}
      {!loading && listing && !listing.target && <p className="agent-memory-muted">当前对话尚未确认服务器身份，现在只能保存全局记忆。</p>}
      {error && <p className="agent-memory-error" role="alert">{error}</p>}
      <div className="agent-memory-toolbar">{draft ? <span className="agent-memory-toolbar-state">正在编辑记忆</span> : <label><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} />显示全部记忆</label>}<div className="agent-memory-toolbar-actions">
        <button type="button" className="agent-memory-secondary" disabled={locked} onClick={() => setReload(value => value + 1)}><Icon name="refresh" size={14} />刷新</button>
        {!draft && <button type="button" className="agent-memory-primary" disabled={locked || !listing || !!deleteTarget} onClick={() => {
          setError(''); setDraft({ id: crypto.randomUUID(), revision: 0, title: '', content: '', kind: 'preference', scope: listing?.target ? 'server' : 'global', enabled: true });
        }}><Icon name="plus" size={14} />新建记忆</button>}
      </div></div>
      {draft ? <form className="agent-memory-editor" onSubmit={event => { event.preventDefault(); save(); }}>
        <label>记忆标题<input autoFocus aria-label="记忆标题" value={draft.title} maxLength={120} disabled={!!saving}
          onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className="agent-memory-fields"><label>类型<Select label="记忆类型" value={draft.kind} disabled={!!saving}
          options={[{ value: 'preference', label: '偏好' }, { value: 'procedure', label: '经验 / 流程' }]}
          onChange={kind => setDraft({ ...draft, kind })} /></label>
          <label>生效范围<Select<AgentMemoryWrite['scope']> label="生效范围" value={draft.scope} disabled={!!saving}
            options={[{ value: 'global', label: '全局 · 所有对话' }, ...(listing?.target ? [{ value: 'server', label: '当前服务器' }] : [])] as Array<{ value: AgentMemoryWrite['scope']; label: string }>}
            onChange={value => setDraft({ ...draft, scope: value })} /></label></div>
        <label>记忆内容<textarea aria-label="记忆内容" value={draft.content} rows={5} maxLength={2048} disabled={!!saving}
          onChange={event => setDraft({ ...draft, content: event.target.value })} /></label>
        <label className="agent-memory-enable"><input type="checkbox" checked={draft.enabled} disabled={!!saving} aria-describedby={enabledHelp}
          onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用这条记忆</label>
        <p id={enabledHelp} className="agent-memory-muted">保存后生效；启用时按生效范围和上下文容量供后续消息参考。关闭仅暂停使用，记录仍会保留，不改写已有聊天内容。</p>
        <footer><button type="button" className="agent-memory-secondary" disabled={!!saving} onClick={() => { setDraft(null); setError(''); }}>取消编辑</button>
          <button type="submit" className="agent-memory-primary" disabled={locked || !listing || !draft.title.trim() || !draft.content.trim()}>{saving ? '正在保存…' : '保存记忆'}</button></footer>
      </form> : <>
        {loading ? <p className="agent-memory-empty" role="status">正在读取记忆…</p> : listing && !items.length ? <p className="agent-memory-empty">{all ? '尚无记忆' : '当前范围暂无适用记忆'}</p> : null}
        <div className="agent-memory-list">{items.map(item => <article key={item.id} className="agent-memory-card">
          <div className="agent-memory-card-heading"><strong>{item.title}</strong><span className={`agent-memory-scope-badge ${scopeLabel(item, projects).kind}`}>{scopeLabel(item, projects).text}</span><div className="agent-memory-card-actions">
            <span>{saving === item.id ? '保存中…' : item.enabled ? '已启用' : '已停用'}</span>
            <Toggle label={`启用记忆：${item.title}`} value={item.enabled} disabled={locked || !!deleteTarget || !canEdit(item)} onChange={enabled => {
              if (!canEdit(item)) return;
              void mutate(item.id, async () => { replace(await agentApi.saveMemory(view.agentId, view.sessionId, { ...editable(item), enabled }, view.projectId)); });
            }} />
            <button type="button" className="agent-memory-edit" aria-label={`编辑记忆：${item.title}`} title="编辑记忆" disabled={locked || !!deleteTarget || !canEdit(item)}
              onClick={() => { setError(''); setDraft(editable(item)); }}><Icon name="edit" size={15} /></button>
            <button type="button" className="agent-memory-delete" aria-label={`删除记忆：${item.title}`} title="删除记忆" disabled={locked || !!deleteTarget || !canEdit(item)}
              onClick={() => { setError(''); setDeleteTarget(item); }}><Icon name="trash" size={15} /></button>
          </div></div>
          <p className="agent-memory-content">{item.content}</p>
          <p className="agent-memory-muted">{item.kind === 'preference' ? '偏好' : '经验 / 流程'} · {item.scope === 'global' ? '全局' : `${item.target?.identity.username}@${item.target?.identity.host}:${item.target?.identity.port}`} · 更新于 {updatedAt(item.updatedAt)}</p>
          {deleteTarget?.id === item.id && <div className="agent-memory-delete-confirm" role="group" aria-label="确认删除记忆">
            <span>删除这条记忆？聊天记录会保留。</span><button type="button" disabled={!!saving} onClick={() => setDeleteTarget(null)}>取消</button>
            <button type="button" className="agent-memory-delete" disabled={locked} onClick={() => {
              void mutate(item.id, async () => {
                await agentApi.deleteMemory(view.agentId, view.sessionId, item.id, item.revision, view.projectId);
                if (!alive.current) return;
                setListing(current => current && ({ ...current, items: current.items.filter(value => value.id !== item.id) })); setDeleteTarget(null);
              });
            }}>确认删除</button></div>}
        </article>)}</div>
      </>}
    </div>
  </Modal>;
}
