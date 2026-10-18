import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { agentApi, type AgentMemories, type AgentMemory, type AgentMemoryWrite, type AgentProject } from '../api/agent';
import { Icon, Modal, Toggle } from './Ui';
import { Select } from './Select';
import './AgentMemory.css';

export type MemoryScope = { agentId: string; sessionId: string; projectId?: string };
type Entry = AgentMemories['items'][number];
type TargetKey = 'global' | 'server' | `project:${string}`;
type ScopeFilter = 'all' | 'applicable' | TargetKey;
const PAGE_SIZE = 8;

// Only editable fields cross IPC. Native code owns target identity and provenance.
function editable(memory: AgentMemoryWrite): AgentMemoryWrite {
  const { id, revision, title, content, kind, scope, enabled } = memory;
  return { id, revision, title, content, kind, scope, enabled };
}
function sameTarget(a: AgentMemory['target'], b: AgentMemory['target']) {
  return !!a && !!b && a.connectionId === b.connectionId && a.identity.host === b.identity.host
    && a.identity.port === b.identity.port && a.identity.username === b.identity.username && a.identity.hostKey === b.identity.hostKey;
}
function projectTarget(project: AgentProject): AgentMemory['target'] {
  return project.identity ? { connectionId: project.connectionId, identity: project.identity } : null;
}
function memoryProject(item: AgentMemory, projects: AgentProject[]) {
  const matches = projects.filter(project => sameTarget(item.target, projectTarget(project)));
  return matches.find(project => project.id === item.source.projectId) ?? matches[0];
}
function projectLabel(project: AgentProject) {
  const server = project.identity ?? project.profile;
  return server ? `${project.name} · ${server.host}:${server.port}` : project.name;
}
function scopeLabel(item: AgentMemory, projects: AgentProject[]) {
  if (item.scope === 'global') return { text: '全局生效', kind: 'global' as const };
  const identity = item.target?.identity;
  const project = memoryProject(item, projects);
  const server = identity ? `${identity.host}:${identity.port}` : '服务器地址未知';
  return { text: `${project?.name ?? '服务器'} · ${server}`, kind: 'project' as const };
}
function message(cause: unknown) {
  if ((cause as { code?: string })?.code === 'AGENT_MEMORY_CHANGED') return '记录已在其他窗口更改，编辑文字已保留。请刷新并核对最新版本后再保存。';
  if ((cause as { code?: string })?.code === 'AGENT_TARGET_MISMATCH') return '服务器身份与这条记忆不一致，编辑文字已保留。请刷新项目列表后重试。';
  return cause instanceof Error ? cause.message : '操作失败，请重试。';
}
function updatedAt(timestamp: number) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : '未知时间';
}

export function AgentMemoryButton({ scope, onNotice }: { scope: MemoryScope; onNotice?: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const key = `${scope.agentId}:${scope.sessionId}:${scope.projectId ?? ''}`;
  useEffect(() => { setOpen(false); }, [key]);
  return <>
    <button type="button" className="agent-memory-button" aria-label="管理长期记忆" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(true)}><Icon name="book" size={15} /><span>记忆</span></button>
    {open && createPortal(<AgentMemoryDialog key={key} scope={scope} onNotice={onNotice} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

export function AgentMemoryDialog({ scope, onClose, onNotice }: { scope: MemoryScope; onClose: () => void; onNotice?: (message: string) => void }) {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [projectReload, setProjectReload] = useState(0);
  const [listing, setListing] = useState<AgentMemories | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<AgentMemoryWrite | null>(null);
  const [draftTarget, setDraftTarget] = useState<TargetKey>('global');
  const [original, setOriginal] = useState<Entry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  const [saving, setSaving] = useState('');
  const [toggling, setToggling] = useState<Set<string>>(() => new Set());
  const togglePending = useRef(new Set<string>());
  const pending = useRef(false);
  const alive = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const enabledHelp = useId();
  const contentId = useId();
  const view = scope;
  const currentTarget = listing?.target ?? null;
  const locked = !!saving || loading;
  const filterLocked = locked || !!deleteTarget;
  const targetKey = (item: AgentMemory): TargetKey | undefined => {
    if (item.scope === 'global') return 'global';
    if (sameTarget(item.target, currentTarget)) return 'server';
    const project = memoryProject(item, projects);
    return project ? `project:${project.id}` : undefined;
  };
  const targetView = (key: TargetKey): MemoryScope => key === 'server' ? view
    : key.startsWith('project:') ? { agentId: '', sessionId: '', projectId: key.slice(8) }
    : { agentId: '', sessionId: '' };
  const targetOptions: { value: TargetKey; label: string }[] = [
    { value: 'global', label: '全局 · 所有对话' },
    ...(currentTarget ? [{ value: 'server' as const, label: `${projects.find(project => sameTarget(projectTarget(project), currentTarget))?.name ?? '当前服务器'} · ${currentTarget.identity.host}:${currentTarget.identity.port}` }] : []),
    ...projects.filter(project => project.identity && !sameTarget(projectTarget(project), currentTarget))
      .map(project => ({ value: `project:${project.id}` as TargetKey, label: projectLabel(project) })),
  ];
  const canEdit = (item: Entry) => targetKey(item) !== undefined;
  const resetPage = () => { setPage(1); setExpanded(new Set()); if (listRef.current) listRef.current.scrollTop = 0; };
  const resetFilters = () => { setScopeFilter('all'); setQuery(''); setKindFilter('all'); setStatusFilter('all'); resetPage(); };
  const refresh = () => { if (togglePending.current.size) return; setReload(value => value + 1); setProjectReload(value => value + 1); };
  const cancelEdit = () => { setDraft(null); setOriginal(null); setError(''); };
  const cancelDelete = () => { if (pending.current) return; setDeleteTarget(null); setError(''); };
  const startEdit = (item: Entry) => {
    const key = targetKey(item);
    if (locked || pending.current || togglePending.current.has(item.id) || key === undefined) return;
    setError(''); setOriginal(item); setDraftTarget(key); setDraft(editable(item));
  };
  const startNew = () => {
    if (locked || pending.current || !listing) return;
    const filteredProject = scopeFilter.startsWith('project:') ? projects.find(project => project.id === scopeFilter.slice(8)) : undefined;
    let key: TargetKey = currentTarget ? 'server' : 'global';
    if (scopeFilter === 'global') key = 'global';
    if (scopeFilter.startsWith('project:')) {
      key = filteredProject?.identity
        ? sameTarget(projectTarget(filteredProject), currentTarget) ? 'server' : `project:${filteredProject.id}`
        : 'global';
    }
    setError(''); setOriginal(null); setDraftTarget(key);
    setDraft({ id: crypto.randomUUID(), revision: 0, title: '', content: '', kind: 'preference', scope: key === 'global' ? 'global' : 'server', enabled: true });
  };

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
    setListing(current => {
      if (!current) return current;
      const updated = { ...saved, applicable: saved.scope === 'global' || sameTarget(saved.target, current.target) };
      return { ...current, items: current.items.some(item => item.id === saved.id)
        ? current.items.map(item => item.id === saved.id ? updated : item)
        : [updated, ...current.items] };
    });
  }
  async function toggleMemory(item: Entry, enabled: boolean) {
    const key = targetKey(item);
    if (key === undefined || pending.current || loading || deleteTarget || togglePending.current.has(item.id)) return;
    const writeView = targetView(key);
    togglePending.current.add(item.id); setToggling(new Set(togglePending.current)); setError('');
    try {
      replace(await agentApi.saveMemory(writeView.agentId, writeView.sessionId, { ...editable(item), enabled }, writeView.projectId));
      if (alive.current) onNotice?.(`已${enabled ? '启用' : '停用'}长期记忆“${item.title}”`);
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      togglePending.current.delete(item.id);
      if (alive.current) setToggling(new Set(togglePending.current));
    }
  }
  function save() {
    if (!draft || locked || !listing) return;
    // Updating a server record (including making it global) must still present
    // that record's original verified server view to the native owner check.
    const key = original?.scope === 'server' ? targetKey(original) : draftTarget;
    if (!key || !targetOptions.some(option => option.value === key)) {
      setError('此服务器项目的身份已变化，请刷新后核对再保存。'); return;
    }
    const writeView = targetView(key);
    const input = { ...editable(draft), title: draft.title.trim(), content: draft.content.trim() };
    const bytes = new TextEncoder();
    if (!input.title || !input.content) { setError('请填写记忆标题和内容。'); return; }
    if (bytes.encode(input.title).length > 120 || bytes.encode(input.content).length > 2048) {
      setError('标题或内容过长，请缩短后保存（标题最多 120 字节，内容最多 2048 字节）。'); return;
    }
    void mutate(input.id, async () => {
      const result = await agentApi.saveMemory(writeView.agentId, writeView.sessionId, input, writeView.projectId);
      if (!alive.current) return;
      replace(result); setDraft(null); setOriginal(null); setQuery(''); setKindFilter('all'); setStatusFilter('all'); resetPage();
      if (scopeFilter !== 'all' && scopeFilter !== 'applicable') setScopeFilter(input.scope === 'global' ? 'global' : draftTarget === 'server' ? 'applicable' : draftTarget);
      onNotice?.(`已${original ? '更新' : '添加'}长期记忆“${result.title}”`);
    });
  }
  const search = query.trim().toLocaleLowerCase();
  const items = listing?.items.filter(item => {
    const project = scopeFilter.startsWith('project:') ? projects.find(value => value.id === scopeFilter.slice(8)) : undefined;
    const inScope = scopeFilter === 'all' || (scopeFilter === 'applicable' && item.applicable)
      || (scopeFilter === 'global' && item.scope === 'global')
      || (project && item.scope === 'server' && item.target?.connectionId === project.connectionId
        && (!project.identity || sameTarget(item.target, projectTarget(project))));
    return inScope && (kindFilter === 'all' || item.kind === kindFilter)
      && (statusFilter === 'all' || item.enabled === (statusFilter === 'enabled'))
      && (!search || `${item.title}\n${item.content}\n${scopeLabel(item, projects).text}\n${item.target?.identity.username ?? ''}`.toLocaleLowerCase().includes(search));
  }) ?? [];
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const filtered = !!search || scopeFilter !== 'all' || kindFilter !== 'all' || statusFilter !== 'all';
  const originalTarget = original ? targetKey(original) : undefined;
  const editOptions = original?.scope === 'server' ? targetOptions.filter(option => option.value === 'global' || option.value === originalTarget) : targetOptions;
  return <><Modal icon="book" iconTone="violet" title="长期记忆" className="agent-memory-dialog" active={!deleteTarget} dismissDisabled={!!saving || toggling.size > 0} onClose={onClose}>
    <div className={`agent-memory-body${draft ? ' is-editing' : ''}`}>
      <p className="agent-memory-intro">保存你确认的偏好与经验，供后续对话参考。记忆不会自动授予工具执行权限。</p>
      {projectsError && <p className="agent-memory-error" role="alert">项目读取失败：{projectsError} <button type="button" onClick={() => setProjectReload(value => value + 1)}>重试项目列表</button></p>}
      {error && <p className="agent-memory-error" role="alert">{error}</p>}
      <div className="agent-memory-toolbar">{draft ? <div className="agent-memory-editor-heading"><button type="button" className="agent-memory-back" disabled={!!saving} onClick={cancelEdit}><Icon name="left" size={14} />记忆列表</button><span>{original ? '编辑记忆' : '新建记忆'}</span></div>
        : <label className="agent-memory-search"><Icon name="search" size={16} /><input type="search" aria-label="搜索记忆" placeholder="搜索标题、内容或服务器" value={query} disabled={filterLocked} onChange={event => { setQuery(event.target.value); resetPage(); }} /></label>}<div className="agent-memory-toolbar-actions">
        <button type="button" className="agent-memory-secondary" disabled={locked} aria-disabled={toggling.size > 0 || locked} onClick={refresh}><Icon name="refresh" size={14} />刷新</button>
        {!draft && <button type="button" className="agent-memory-primary" disabled={locked || !listing || !!deleteTarget || projectsLoading} onClick={startNew}><Icon name="plus" size={14} />新建记忆</button>}
      </div></div>
      {draft ? <form className="agent-memory-editor" onSubmit={event => { event.preventDefault(); save(); }}>
        <label>记忆标题<input autoFocus aria-label="记忆标题" value={draft.title} maxLength={120} disabled={!!saving}
          onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className="agent-memory-fields"><label>类型<Select label="记忆类型" value={draft.kind} disabled={!!saving}
          options={[{ value: 'preference', label: '偏好' }, { value: 'procedure', label: '经验 / 流程' }]}
          onChange={kind => setDraft({ ...draft, kind })} /></label>
          <label>生效范围<Select<TargetKey> label="生效范围" value={draftTarget} disabled={!!saving || projectsLoading}
            options={editOptions} onChange={value => { setDraftTarget(value); setDraft({ ...draft, scope: value === 'global' ? 'global' : 'server' }); }} /></label></div>
        <label>记忆内容<textarea aria-label="记忆内容" value={draft.content} rows={5} maxLength={2048} disabled={!!saving}
          onChange={event => setDraft({ ...draft, content: event.target.value })} /></label>
        <label className="agent-memory-enable"><input type="checkbox" checked={draft.enabled} disabled={!!saving} aria-describedby={enabledHelp}
          onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用这条记忆</label>
        <p id={enabledHelp} className="agent-memory-muted">保存后生效；启用时按生效范围和上下文容量供后续消息参考。关闭仅暂停使用，记录仍会保留，不改写已有聊天内容。</p>
        <footer><button type="button" className="agent-memory-secondary" disabled={!!saving} onClick={cancelEdit}>取消编辑</button>
          <button type="submit" className="agent-memory-primary" disabled={locked || projectsLoading || !listing || !draft.title.trim() || !draft.content.trim()}>{saving ? '正在保存…' : '保存记忆'}</button></footer>
      </form> : <>
        <div className="agent-memory-filters" aria-label="记忆筛选">
          <Select<ScopeFilter> label="筛选生效范围" value={scopeFilter} disabled={filterLocked || projectsLoading}
            options={[{ value: 'all', label: '全部范围' }, { value: 'applicable', label: '当前对话适用' }, { value: 'global', label: '全局记忆' },
              ...projects.map(project => ({ value: `project:${project.id}` as ScopeFilter, label: projectLabel(project) }))]}
            onChange={value => { setScopeFilter(value); resetPage(); }} />
          <Select label="筛选记忆类型" value={kindFilter} disabled={filterLocked} options={[{ value: 'all', label: '全部类型' }, { value: 'preference', label: '偏好' }, { value: 'procedure', label: '经验 / 流程' }]} onChange={value => { setKindFilter(value); resetPage(); }} />
          <Select label="筛选启用状态" value={statusFilter} disabled={filterLocked} options={[{ value: 'all', label: '全部状态' }, { value: 'enabled', label: '已启用' }, { value: 'disabled', label: '已停用' }]} onChange={value => { setStatusFilter(value); resetPage(); }} />
        </div>
        <div className="agent-memory-list-summary"><span role="status">{projectsLoading ? '正在读取服务器项目…' : loading ? '正在读取记忆…' : `${items.length} 条记忆${filtered ? ` / 共 ${listing?.items.length ?? 0} 条` : ''}`}</span>{filtered && <button type="button" disabled={filterLocked} onClick={resetFilters}>清除筛选</button>}<span>可跨项目编辑，无需切换对话</span></div>
        <div className="agent-memory-list" ref={listRef} aria-label="记忆列表" aria-busy={loading}>
        {loading ? <p className="agent-memory-empty" role="status">正在读取记忆…</p> : listing && !items.length ? <div className="agent-memory-empty"><Icon name="book" size={25} /><p>{filtered ? '没有符合筛选条件的记忆' : '尚无记忆'}</p><span>{filtered ? '试试其他关键词或清除筛选' : '添加常用偏好和经验，供后续对话参考'}</span></div> : null}
        {!loading && visibleItems.map(item => <article key={item.id} aria-busy={toggling.has(item.id)} className={`agent-memory-card${expanded.has(item.id) ? ' is-expanded' : ''}`}>
          <div className="agent-memory-card-heading"><button type="button" className="agent-memory-item-title" aria-label={`${expanded.has(item.id) ? '收起' : '展开'}记忆内容：${item.title}`} aria-expanded={expanded.has(item.id)} aria-controls={`${contentId}-${item.id}`} title={item.title} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}><Icon name="right" size={12} /><strong>{item.title}</strong></button><span className={`agent-memory-scope-badge ${scopeLabel(item, projects).kind}`} title={scopeLabel(item, projects).text}>{scopeLabel(item, projects).text}</span><div className="agent-memory-card-actions">
            <span>{saving === item.id ? '保存中…' : item.enabled ? '已启用' : '已停用'}</span>
            <Toggle label={`启用记忆：${item.title}`} value={item.enabled} disabled={locked || !!deleteTarget || toggling.has(item.id) || !canEdit(item)} onChange={enabled => void toggleMemory(item, enabled)} />
            <button type="button" className="agent-memory-edit" aria-label={`编辑记忆：${item.title}`} title={canEdit(item) ? '编辑记忆' : '服务器身份已变化或项目已移除，请从原服务器对话打开后编辑'} disabled={locked || !!deleteTarget || toggling.has(item.id) || !canEdit(item)}
              onClick={() => startEdit(item)}><Icon name="edit" size={15} /></button>
            <button type="button" className="agent-memory-delete" aria-label={`删除记忆：${item.title}`} title="删除记忆" disabled={locked || !!deleteTarget || toggling.has(item.id)}
              onClick={() => { setError(''); setDeleteTarget(item); }}><Icon name="trash" size={15} /></button>
          </div></div>
          <p id={`${contentId}-${item.id}`} className="agent-memory-content">{item.content}</p>
          <p className="agent-memory-meta">{item.kind === 'preference' ? '偏好' : '经验 / 流程'} · {item.scope === 'global' ? '所有对话' : `${item.target?.identity.username}@${item.target?.identity.host}:${item.target?.identity.port}`}<span>更新于 {updatedAt(item.updatedAt)}</span>{!canEdit(item) && <span>服务器身份待确认</span>}</p>
        </article>)}</div>
        <nav className="agent-memory-pagination" aria-label="记忆分页"><span>每页 {PAGE_SIZE} 条 · {currentPage} / {pageCount} 页</span><div><button type="button" disabled={filterLocked || currentPage <= 1} onClick={() => { setPage(currentPage - 1); if (listRef.current) listRef.current.scrollTop = 0; }}><Icon name="left" size={14} />上一页</button><button type="button" disabled={filterLocked || currentPage >= pageCount} onClick={() => { setPage(currentPage + 1); if (listRef.current) listRef.current.scrollTop = 0; }}>下一页<Icon name="right" size={14} /></button></div></nav>
      </>}
    </div>
  </Modal>
    {deleteTarget && createPortal(<Modal icon="trash" iconTone="danger" title="删除长期记忆？" className="agent-memory-delete-dialog" dismissDisabled={!!saving} onClose={cancelDelete}>
      <div className="agent-memory-delete-body">
        <strong>{deleteTarget.title}</strong><span className={`agent-memory-scope-badge ${scopeLabel(deleteTarget, projects).kind}`}>{scopeLabel(deleteTarget, projects).text}</span>
        <p>这条长期记忆将被永久删除，后续对话不再参考它。已有聊天记录会保留。</p>
        {error && <p className="agent-memory-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" data-autofocus className="agent-memory-secondary" disabled={!!saving} onClick={cancelDelete}>取消</button>
        <button type="button" className="agent-memory-confirm-delete" disabled={locked} onClick={() => {
          const target = deleteTarget; if (!target) return;
          void mutate(target.id, async () => {
            await agentApi.deleteMemory('', '', target.id, target.revision);
            if (!alive.current) return;
            setListing(current => current && ({ ...current, items: current.items.filter(value => value.id !== target.id) }));
            setDeleteTarget(null); onNotice?.(`已删除长期记忆“${target.title}”`);
          });
        }}>{saving ? '正在删除…' : '确认删除'}</button></footer>
    </Modal>, document.body)}
  </>;
}
