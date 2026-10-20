import { useEffect, useRef, useState } from 'react';
import { modelApi } from '../api/models';
import type { CatalogModel, CatalogQuery } from '../api/models';
import { useToastError } from '../state/useToastError';
import { addModelIds, selectedModelIds } from '../state/modelSelection';
import { Icon } from './Ui';
import './ModelCatalogInput.css';

type Props = {value: string; onChange: (value: string) => void; query: CatalogQuery; disabled: boolean};
export function ModelCatalogInput({value, onChange, query, disabled}: Props) {
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [, setError] = useToastError();
  const pending = useRef<AbortController | null>(null);
  const key = query.apiKey.action === 'set' ? query.apiKey.value : query.apiKey.action;
  useEffect(() => {
    pending.current?.abort(); pending.current = null;
    setModels(null); setLoading(false); setSearch('');
    return () => { pending.current?.abort(); pending.current = null; };
  }, [query.provider, query.baseUrl, query.requireApiKey, key, query.channelId, query.revision]);
  const selected = selectedModelIds(value, query.provider);
  const selectedSet = new Set(selected);
  const term = search.trim().toLocaleLowerCase();
  const visible = models?.filter(model => `${model.id} ${model.displayName ?? ''}`.toLocaleLowerCase().includes(term)) ?? [];
  const add = (ids: string[]) => {
    if (disabled) return;
    try { onChange(addModelIds(value, ids, query.provider)); }
    catch (error) { setError(error instanceof Error ? error.message : '添加模型失败'); }
  };
  const discover = async () => {
    if (disabled || pending.current) return;
    if (!query.baseUrl.trim()) { setError('请先填写 API 基础地址。'); return; }
    if (query.requireApiKey && query.apiKey.action !== 'set' && !query.channelId) { setError('请先填写 API Key。'); return; }
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError('');
    try {
      const entries = await modelApi.discover(query, controller.signal);
      if (pending.current === controller && !controller.signal.aborted) { setModels(entries); setSearch(''); }
    } catch (error) {
      if (pending.current === controller && !controller.signal.aborted) setError(error instanceof Error ? error.message : '模型查询失败，请重试。');
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  };
  return <div className="model-discovery">
    <div className="model-discovery-toolbar"><span>已选 <strong>{selected.length}</strong><span className="model-discovery-limit"> / 64</span></span>
      <button type="button" className="outlined-button model-discovery-query" disabled={disabled || loading} onClick={() => void discover()}>
        <Icon name={loading ? 'refresh' : 'search'} size={14}/>{loading ? '查询中…' : models ? '重新查询' : '查询上游模型'}
      </button>
    </div>
    <div className="model-selected-list" aria-label="已选模型">
      {selected.length ? selected.map(id => <span className="model-selected-chip" key={id}><span title={id}>{id}</span><button type="button" aria-label={`移除 ${id}`} disabled={disabled} onClick={() => onChange(selected.filter(item => item !== id).join('\n'))}><Icon name="close" size={12}/></button></span>)
        : <span className="model-discovery-placeholder">查询后点击模型添加，或手动填写</span>}
    </div>
    {loading && <div className="model-discovery-status" role="status" aria-live="polite"><span className="model-discovery-spinner"/>正在获取上游模型列表…</div>}
    {!loading && models !== null && <div className="model-discovery-results">
      <div className="model-discovery-results-head"><label className="model-discovery-search"><Icon name="search" size={14}/><input type="search" aria-label="搜索上游模型" onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索模型 ID 或名称" disabled={disabled}/></label>
        <button type="button" className="model-discovery-add-all" disabled={disabled || !models.some(model => !selectedSet.has(model.id))} onClick={() => add(models.map(model => model.id))}>全部添加</button>
      </div>
      <div className="model-discovery-result-count" role="status">{term ? `${visible.length} / ${models.length}` : models.length} 个模型<span>点击添加</span></div>
      <div className="model-discovery-options" aria-label="上游模型列表">
        {visible.map(model => <button type="button" className="model-discovery-option" data-selected={selectedSet.has(model.id) || undefined} aria-label={`添加 ${model.id}`} aria-pressed={selectedSet.has(model.id)} key={model.id} disabled={disabled || selectedSet.has(model.id)} onClick={() => add([model.id])}>
          <span><strong>{model.id}</strong>{model.displayName && model.displayName !== model.id && <small>{model.displayName}</small>}</span><Icon name={selectedSet.has(model.id) ? 'check' : 'plus'} size={14}/>
        </button>)}
        {!visible.length && <p className="model-discovery-empty">{models.length ? '没有匹配的模型' : '上游未返回可添加的对话模型，可手动填写。'}</p>}
      </div>
    </div>}
    <details className="model-discovery-manual"><summary>手动填写</summary><textarea id="model-id" aria-label="手动填写模型 ID" className="settings-control settings-control-mono model-ids-input" rows={3} spellCheck={false} disabled={disabled} value={value} onChange={e => onChange(e.target.value)} placeholder={'每行一个模型 ID，也可用逗号分隔'}/></details>
  </div>;
}
