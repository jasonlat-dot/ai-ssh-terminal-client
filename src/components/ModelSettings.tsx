import { useToastError } from '../state/useToastError';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { modelApi, newModelConfig } from '../api/models';
import { sshUserId } from '../api/ssh';
import { applyModelProtocol, applyModelSupplier, modelProtocols, modelSupplier, modelProtocolInfo, modelBasePlaceholder, resolvedModelBaseUrl, modelSupplierOptions, supplierProtocolOptions } from '../api/modelProtocols';
import type { ModelSupplier } from '../api/modelProtocols';
import type { KeyChange, ModelConfig, ModelChannel, ModelChannelIssue } from '../api/models';
import { AccentIcon, Badge, Icon, Modal, Toggle } from './Ui';
import type { AccentTone, IconName } from './Ui';
import { Select } from './Select';
import { ModelSupplierIcon } from './ModelSupplierIcon';
import { ModelNumberInput } from './ModelNumberInput';
import { ModelCatalogInput } from './ModelCatalogInput';
import { ModelEndpointInput } from './ModelEndpointInput';
import { notify } from '../state/notifications';
import { parseModelIds } from '../state/modelChannels';
import { loadModelPins, orderPinnedModels, saveModelPins } from '../state/modelPins';
import './ModelSettings.css';

const tokenCountFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

function ModelField({ id, label, hint, children, wide = false, badge, icon, tone = 'blue' }: { id:string; label:string; hint?:string; children:ReactNode; wide?:boolean; badge?:string; icon?:IconName; tone?:AccentTone }) {
  return <div className={`settings-field ${wide ? 'is-wide' : ''}`}>
    <div className="settings-field-head"><label htmlFor={id}>{label}</label>{badge && <Badge tone={tone} icon={icon} className="model-field-badge">{badge}</Badge>}</div>
    {children}{hint && <p className="settings-field-help">{hint}</p>}
  </div>;
}

export function ModelSettings({ changed, locked = false, activeModelIds }: { changed?: () => void; locked?: boolean; activeModelIds?:ReadonlySet<string> }) {
  const [profiles, setProfiles] = useState<ModelChannel[]>([]);
  const [issues, setIssues] = useState<ModelChannelIssue[]>([]);
  const [pinnedIds, setPinnedIds] = useState(() => loadModelPins(sshUserId));
  const [supplierFilter, setSupplierFilter] = useState<ModelSupplier | 'all'>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useToastError();
  const [editing, setEditing] = useState<ModelChannel | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [config, setConfig] = useState(newModelConfig);
  const [key, setKey] = useState('');
  const [modelIds, setModelIds] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setError] = useToastError();
  const [deleting, setDeleting] = useState<ModelChannel | null>(null);
  const [, setDeleteError] = useToastError();
  const protocolInfo = modelProtocolInfo(config);
  const supplier = modelSupplier(config);
  const protocolOptions = supplierProtocolOptions(supplier);
  const disabled = busy || loading || locked;
  const searchTerm = search.trim().toLocaleLowerCase();
  const filteredProfiles = orderPinnedModels(profiles, pinnedIds).filter(profile =>
    (supplierFilter === 'all' || modelSupplier(profile.config) === supplierFilter)
    && (profile.displayName ?? profile.id).toLocaleLowerCase().includes(searchTerm));
  const hasFilters = supplierFilter !== 'all' || searchTerm.length > 0;
  const clearFilters = () => { setSupplierFilter('all'); setSearch(''); };
  const togglePin = (id: string) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter(value => value !== id)
      : [id, ...pinnedIds.filter(value => profiles.some(profile => profile.id === value))];
    try { saveModelPins(sshUserId, next); setPinnedIds(next); }
    catch { setError('置顶状态保存失败，请重试。'); }
  };
  useEffect(() => {
    let active = true;
    void modelApi.channelReport().then(report => { if (active) { setProfiles(report.items); setIssues(report.issues); } })
      .catch(cause => { if (active) setLoadError(cause instanceof Error ? cause.message : '加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const select = (profile: ModelChannel | null) => {
    if (disabled) return;
    setEditing(profile); setDisplayName(profile?.displayName ?? profile?.id ?? '');
    const next = profile?.config ?? newModelConfig();
    setConfig({...next, capabilities: {...next.capabilities, toolCalls: true, vision: true}});
    setModelIds(profile?.models?.map(item=>item.model).join('\n') ?? next.model);
    setKey(''); setError(''); setEditorOpen(true);
  };
  const closeEditor = () => {
    if (busy) return;
    setEditorOpen(false); setKey(''); setError('');
  };
  const field = <K extends keyof ModelConfig>(name: K, value: ModelConfig[K]) => setConfig(current => ({...current, [name]: value}));
  const reload = async () => {
    if (disabled) return;
    setLoading(true); setLoadError('');
    try { const report = await modelApi.channelReport(); setProfiles(report.items); setIssues(report.issues); }
    catch (cause) { setLoadError(cause instanceof Error ? cause.message : '加载失败'); }
    finally { setLoading(false); }
  };
  const save = async () => {
    if (disabled) return;
    setBusy(true); setError('');
    try {
      if (!displayName.trim()) throw new Error('请输入配置名称。');
      if (config.temperature !== null && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > protocolInfo.temperatureMax)) throw new Error(`Temperature 需在 0–${protocolInfo.temperatureMax} 之间。`);
      const ids=parseModelIds(modelIds);
      const apiKey:KeyChange = key.trim() ? {action:'set',value:key.trim()} : {action:'keep'};
      const saved = await modelApi.saveChannel(editing?.id ?? crypto.randomUUID(), editing?.revision ?? 0, {...config,baseUrl:resolvedModelBaseUrl(config),model:ids[0]}, apiKey, displayName.trim(), ids);
      setProfiles(items => items.some(profile => profile.id === saved.id)
        ? items.map(profile => profile.id === saved.id ? saved : profile)
        : [...items, saved]);
      setEditorOpen(false); setKey(''); setError('');
      notify(saved.ready ? '模型配置已保存，后续请求生效；运行中的任务继续使用原配置。' : '模型配置已保存；配置 API Key 后即可对话。', 'success'); changed?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const activeChannel=(profile:ModelChannel)=>!!activeModelIds&&(profile.models?.some(model=>activeModelIds.has(model.id))||activeModelIds.has(profile.id));
  const requestDelete = (profile: ModelChannel) => {
    if (disabled||activeChannel(profile)) return;
    setDeleteError(''); setDeleting(profile);
  };
  const remove = async () => {
    if (!deleting || disabled || activeChannel(deleting)) return;
    setBusy(true); setDeleteError('');
    try {
      await modelApi.deleteChannel(deleting.id, deleting.revision);
      setProfiles(items => items.filter(profile => profile.id !== deleting.id));
      if (pinnedIds.includes(deleting.id)) {
        const next = pinnedIds.filter(id => id !== deleting.id);
        setPinnedIds(next);
        try { saveModelPins(sshUserId, next); }
        catch { notify('配置已删除，但置顶偏好未能保存。', 'error'); }
      }
      if (editing?.id === deleting.id) { setEditorOpen(false); setKey(''); }
      setDeleting(null); notify('模型配置已删除，已有历史会话仍保留。', 'success'); changed?.();
    } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : '删除失败'); }
    finally { setBusy(false); }
  };
  return <section className="model-settings" aria-label="模型设置">
    <div className="model-catalog" inert={editorOpen || !!deleting}>
      <header className="model-catalog-heading"><div><strong className="ui-icon-heading"><AccentIcon icon="bot" tone="violet" size={17}/>模型配置<Badge tone="neutral">{profiles.length + issues.length}</Badge></strong></div>
        <div className="model-catalog-actions"><button type="button" className="outlined-button model-refresh" aria-label="刷新模型配置" disabled={disabled} onClick={() => void reload()}><Icon name="refresh" size={15}/></button><button type="button" className="model-create primary-button" disabled={disabled} onClick={() => select(null)}><Icon name="plus" size={15}/>新建配置</button></div>
      </header>
      {profiles.length > 0 && !loadError && <div className="model-catalog-filters" role="search" aria-label="筛选模型配置">
        <div className="model-catalog-filter-controls">
          <div className="model-catalog-supplier-filter"><label htmlFor="model-catalog-supplier">供应商</label>
            <Select<ModelSupplier | 'all'> id="model-catalog-supplier" label="筛选供应商" value={supplierFilter} disabled={loading || busy}
              options={[{value:'all',label:'全部供应商'},...modelSupplierOptions]} onChange={setSupplierFilter}
              renderIcon={value => value === 'all' ? <Icon name="network" size={16}/> : <ModelSupplierIcon supplier={value} size={17}/>}/>
          </div>
          <label className="model-catalog-search"><Icon name="search" size={17}/><input type="search" aria-label="搜索供应商 / 渠道名称" placeholder="搜索供应商 / 渠道名称" value={search} disabled={loading || busy} onChange={event => setSearch(event.target.value)}/>
            {search && <button type="button" aria-label="清空名称搜索" disabled={loading || busy} onClick={() => setSearch('')}><Icon name="close" size={14}/></button>}
          </label>
        </div>
        <div className="model-catalog-filter-summary"><span role="status" aria-live="polite">显示 <strong>{filteredProfiles.length}</strong> / {profiles.length} 个渠道</span>
          {hasFilters && <button type="button" className="model-clear-filters" disabled={loading || busy} onClick={clearFilters}><Icon name="refresh" size={13}/>清除筛选</button>}
        </div>
      </div>}
      {loadError && <button type="button" className="outlined-button" disabled={disabled} onClick={() => void reload()}>重新加载模型配置</button>}
      {locked && <div className="model-feedback" role="status"><Icon name="history" size={16}/><span>正在保存推理设置或整理上下文，请稍后修改配置。</span></div>}
      {!loading && !loadError && issues.length > 0 && <section className="model-config-issues" aria-label="异常模型配置">
        <header><Icon name="alert" size={16}/><strong>{issues.length} 个渠道存在异常配置</strong><span>其他正常模型可继续使用</span></header>
        {issues.map(issue => <article key={issue.id}><div><strong>{issue.displayName || issue.id}</strong><code>配置 ID：{issue.id}</code></div><p>{issue.message}</p></article>)}
        <p className="model-config-issues-note">异常渠道暂停编辑，不会自动删除或重置。请使用支持该配置的版本处理，处理后点击上方刷新。</p>
      </section>}
      <div className="model-catalog-body">
        {loading ? <div className="model-loading" role="status"><i/><i/><i/><span>正在读取配置…</span></div> : loadError ? null : !profiles.length ? (issues.length ? null : <div className="model-list-empty"><AccentIcon icon="bot" tone="violet" size={30}/><strong>还没有模型配置</strong><p>添加模型配置，开始对话。</p><button type="button" className="model-create primary-button" disabled={disabled} onClick={() => select(null)}><Icon name="plus" size={15}/>新建配置</button></div>)
          : !filteredProfiles.length ? <div className="model-list-empty model-list-no-match"><AccentIcon icon="search" tone="blue" size={26}/><strong>没有匹配的模型配置</strong><p>试试其他供应商或渠道名称。</p><button type="button" className="outlined-button model-clear-filters" onClick={clearFilters}>清除筛选</button></div>
          : <div className="model-profile-grid" aria-label="模型配置列表">{filteredProfiles.map(profile => {
            const protocol = modelProtocols[profile.config.provider];
            const pinned = pinnedIds.includes(profile.id);
            return <article className="model-profile-card" data-pinned={pinned || undefined} key={profile.id} aria-label={profile.displayName ?? profile.id}>
              <div className="model-profile-heading"><span className="model-supplier-avatar"><ModelSupplierIcon supplier={modelSupplier(profile.config)} size={22}/></span><div><h3 title={profile.displayName ?? profile.id}>{profile.displayName ?? profile.id}</h3><p title={profile.models?.map(item=>item.model).join('、')??profile.config.model}>{profile.models?.length?`${profile.models.length} 个模型 · ${profile.models.map(item=>item.model).join('、')}`:profile.config.model}</p></div><span className={`model-profile-state ${profile.ready ? 'ready' : ''}`}><i aria-hidden="true"/>{profile.ready ? '已配置' : '需要密钥'}</span></div>
              <div className="model-profile-tags">
                <Badge tone="blue">{protocol.name}</Badge>
                <Badge tone="violet" className="model-profile-budget" title={`${profile.config.contextWindow.toLocaleString()} tokens`}>{`${tokenCountFormat.format(profile.config.contextWindow)} tokens`}</Badge>
              </div>
              <div className="model-profile-connection"><Badge tone="neutral" icon="network" className="model-profile-endpoint" title={profile.config.baseUrl}><span>{profile.config.baseUrl}</span></Badge></div>
              <footer><button type="button" className="model-pin" aria-pressed={pinned} aria-label={`${pinned ? '取消置顶' : '置顶'} ${profile.displayName ?? profile.id}`} disabled={busy || loading} onClick={() => togglePin(profile.id)}><Icon name="pin" size={14}/>{pinned ? '取消置顶' : '置顶'}</button><button type="button" className="model-edit outlined-button" aria-label={`编辑 ${profile.displayName ?? profile.id}`} disabled={disabled} onClick={() => select(profile)}><Icon name="edit" size={14}/>编辑</button><button type="button" className="model-card-delete" aria-label={`删除 ${profile.displayName ?? profile.id}`} title={activeChannel(profile)?'此配置正在运行任务，可编辑；结束后可删除。':undefined} disabled={disabled||activeChannel(profile)} onClick={() => requestDelete(profile)}><Icon name="trash" size={14}/>删除</button></footer>
            </article>;
          })}</div>}
      </div>
    </div>
    {(editorOpen || deleting) && createPortal(<div className="settings-page model-settings-overlay">
      {editorOpen && <Modal title={editing ? '编辑模型配置' : '新建模型配置'} icon="bot" iconTone="violet" className="model-config-dialog" active={!deleting} dismissDisabled={busy} onClose={closeEditor}>
        <form className="model-editor" autoComplete="off" onSubmit={event => { event.preventDefault(); if (!disabled) void save(); }}>
          <div className="model-editor-scroll">
            {locked && <div className="model-feedback" role="status"><Icon name="history" size={16}/><span>正在保存推理设置或整理上下文，请稍后修改配置。</span></div>}
          <fieldset disabled={disabled}>
            <div className="model-form-columns"><div className="model-form-column">
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="network" tone="blue" size={17}/><h4>模型渠道</h4><Badge tone="violet" icon="bot">模型</Badge></div>
              <div className="model-provider-selection">
                <ModelField id="model-supplier" label="供应商"><Select id="model-supplier" label="供应商" className="settings-control" disabled={disabled} value={supplier} options={modelSupplierOptions} menuMinWidth={200} menuClassName="model-supplier-menu" renderIcon={value => <ModelSupplierIcon supplier={value}/>} onChange={value => setConfig(current => applyModelSupplier(current, value))}/></ModelField>
                {protocolOptions.length > 1 ? <ModelField id="model-protocol" label="接口协议"><Select id="model-protocol" label="接口协议" className="settings-control" disabled={disabled} value={config.provider} options={protocolOptions} onChange={value => setConfig(current => applyModelProtocol(current, value))}/></ModelField>
                  : <ModelField id="model-protocol-info" label="接口协议"><input id="model-protocol-info" className="settings-control" readOnly value={protocolInfo.name}/></ModelField>}
              </div>
              <div className="settings-fields-grid">
                <ModelField id="model-name" label="供应商 / 渠道名称" badge="CHANNEL" icon="edit" tone="neutral"><input id="model-name" data-autofocus className="settings-control" value={displayName} maxLength={64} onChange={e => setDisplayName(e.target.value)} placeholder="例如：OpenAI、Claude 或我的中转" /></ModelField>
                <ModelField id="model-effort" label="推理强度"><Select id="model-effort" label="推理强度" className="settings-control" menuClassName="model-reasoning-menu" menuMinWidth={220} value={config.reasoningEffort ?? ''} disabled={disabled} options={protocolInfo.effortOptions} onChange={value => setConfig(current => ({ ...current, reasoningEffort: value || null, capabilities: { ...current.capabilities, reasoningEffort: value !== '' } }))}/></ModelField>
                <ModelField id="model-url" label="API 基础地址" wide badge="BASE URL" icon="network" tone="cyan" hint="留空使用默认地址，也可填写中转地址。"><ModelEndpointInput id="model-url" value={config.baseUrl} onChange={value => field('baseUrl', value)} placeholder={modelBasePlaceholder(config)} savedAddresses={profiles.map(profile => profile.config.baseUrl)} disabled={disabled}/></ModelField>
              <ModelField id="model-api-key" label="API Key" wide hint="密钥加密保存；关闭后不发送，已存密钥保留。">
                <div className="model-key-input-row">
                  <input id="model-api-key" className="settings-control settings-control-mono" type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder={editing?.apiKeyConfigured?'已配置，留空表示不修改':'未配置，请输入 API Key'}/>
                  <div className="model-key-toggle"><span>使用 API Key</span><Toggle label="此服务需要 API Key" value={config.requireApiKey} disabled={disabled} onChange={value=>field('requireApiKey',value)}/></div>
                </div>
              </ModelField>
                <ModelField id="model-id" label="模型 ID" wide badge="MODELS" icon="bot" tone="violet" hint="这些模型共用此渠道的接口、密钥和参数。">
                  <ModelCatalogInput value={modelIds} onChange={setModelIds} disabled={disabled} query={{supplier:config.supplier,provider:config.provider,baseUrl:config.baseUrl,requireApiKey:config.requireApiKey,
                    apiKey:key.trim()?{action:'set',value:key.trim()}:{action:'keep'},channelId:editing?.id??null,revision:editing?.revision??null}}/>
                </ModelField>
              </div>
            </section>

            </div><div className="model-form-column">
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="signal" tone="violet" size={17}/><h4>接口与生成</h4><Badge tone="violet" icon="settings">参数</Badge></div><div className="settings-fields-grid">
              <ModelField id="model-path" label="接口相对路径" hint={protocolInfo.pathHint ?? '与基础地址拼接，避免重复 /v1。'}><input id="model-path" className="settings-control settings-control-mono" value={config.completionsPath} onChange={e => field('completionsPath', e.target.value)} /></ModelField>
              <ModelField id="model-token-param" label="输出参数">{protocolInfo.fixedOutput ? <input id="model-token-param" className="settings-control settings-control-mono" value={protocolInfo.fixedOutput} readOnly /> : <Select id="model-token-param" label="输出参数" className="settings-control" value={config.outputTokenParameter} disabled={disabled} options={[{value:'maxCompletionTokens',label:'max_completion_tokens'},{value:'maxTokens',label:'max_tokens'}]} onChange={value => field('outputTokenParameter', value)}/>}</ModelField>
              <ModelField id="model-window" label="上下文窗口" badge="TOKENS" tone="blue" hint="选择常用档位或直接输入，以供应商上限为准。"><ModelNumberInput id="model-window" label="上下文窗口" kind="context" value={config.contextWindow} disabled={disabled} onChange={value => field('contextWindow', value)} /></ModelField>
              <ModelField id="model-output" label="最大输出" badge="TOKENS" tone="blue" hint="为本次回复预留，不超过模型的输出上限。"><ModelNumberInput id="model-output" label="最大输出" kind="output" value={config.outputReserve} disabled={disabled} onChange={value => field('outputReserve', value)} /></ModelField>
              <ModelField id="model-timeout" label="请求超时（秒）"><ModelNumberInput id="model-timeout" label="请求超时" kind="timeout" value={config.timeoutSeconds} disabled={disabled} onChange={value => field('timeoutSeconds', value)} /></ModelField>
              <ModelField id="model-response" label="最大响应（bytes）"><ModelNumberInput id="model-response" label="最大响应" kind="response" value={config.maxResponseBytes} disabled={disabled} onChange={value => field('maxResponseBytes', value)} /></ModelField>
            </div></section>
            <section className="model-form-section model-request-settings"><div className="model-section-title"><AccentIcon icon="settings" tone="blue" size={17}/><h4>请求参数</h4></div>
              <div className="settings-fields-grid">
                <div className="model-budget-trio">
                <ModelField id="model-safety" label="安全预留（tokens）"><ModelNumberInput id="model-safety" label="安全预留" kind="safety" value={config.safetyReserve} disabled={disabled} onChange={value => field('safetyReserve', value)} /></ModelField>
                <ModelField id="model-compact" label="自动整理触发比例" badge="%" tone="blue" hint={config.provider === 'openAiResponses' && !config.remoteCompaction ? '启用供应商远端整理后，此比例用于触发。' : '接近此比例时整理较早对话，原始历史仍会保留。'}><ModelNumberInput id="model-compact" label="自动整理触发比例" kind="compact" value={config.compactPercent} disabled={disabled} onChange={value => field('compactPercent', value)} /></ModelField>
                <ModelField id="model-temperature" label="Temperature" hint={protocolInfo.temperatureSupported === false ? '此供应商由模型管理温度，使用默认值，不发送 Temperature。' : `留空不发送；此协议范围 0–${protocolInfo.temperatureMax}`}><ModelNumberInput id="model-temperature" label="Temperature" kind="temperature" maximum={protocolInfo.temperatureMax} step={protocolInfo.temperatureStep} value={config.temperature} disabled={disabled || protocolInfo.temperatureSupported === false} onChange={value => setConfig(current => ({ ...current, temperature: value, capabilities: { ...current.capabilities, temperature: value !== null } }))} /></ModelField>
                </div>
                {config.provider === 'openAiResponses' && <div className="model-auth-toggle settings-field is-wide"><div><strong>供应商远端整理</strong><p>仅在供应商支持 responses/compact 时开启。完整窗口加密项保存在本机；在对话中切换模型会保留原记录，并转换历史上下文。编辑原配置的接口或密钥后需检查上下文兼容。关闭时按容量限制对话。</p></div><Toggle label="启用 Responses 远端整理" value={!!config.remoteCompaction} disabled={disabled} onChange={value => field('remoteCompaction', value)}/></div>}
              </div>
            </section>
            </div></div>
          </fieldset>
          </div>
          <footer className="model-editor-footer">
            {editing && <button type="button" className="model-delete-button" disabled={disabled} onClick={() => requestDelete(editing)}><Icon name="trash" size={15}/>删除</button>}
            <span className="model-save-hint">保存后用于后续对话</span><button type="button" className="outlined-button model-cancel" disabled={busy} onClick={closeEditor}>取消</button><button className="model-save-button primary-button" type="submit" disabled={disabled}><Icon name={busy ? 'refresh' : 'check'} size={16}/>{busy ? '保存中…' : '保存配置'}</button>
          </footer>
        </form>
      </Modal>}
      {deleting && <Modal icon="trash" iconTone="danger" title="删除渠道配置？" className="model-delete-dialog" dismissDisabled={busy} onClose={() => { if (!busy) setDeleting(null); }}>
        <div className="model-delete-body">
          <div className="model-delete-target">
            <span className="model-supplier-avatar"><ModelSupplierIcon supplier={modelSupplier(deleting.config)} size={22}/></span>
            <div><strong>{deleting.displayName ?? deleting.id}</strong><span>{deleting.config.model}</span></div>
          </div>
          <p>删除后将无法使用此配置，已有历史会话会保留。</p>
        </div>
        <footer><button type="button" data-autofocus className="outlined-button" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button type="button" className="danger-button" disabled={disabled||activeChannel(deleting)} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button></footer>
      </Modal>}
    </div>, document.body)}
  </section>;
}
