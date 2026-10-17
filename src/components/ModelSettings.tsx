import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { modelApi, newModelConfig } from '../api/models';
import type { KeyChange, ModelConfig, ModelProfile } from '../api/models';
import { AccentIcon, Badge, Icon, Modal, Toggle } from './Ui';
import type { AccentTone, IconName } from './Ui';
import { Select } from './Select';
import { ModelNumberInput } from './ModelNumberInput';
import { notify } from '../state/notifications';
import './ModelSettings.css';

function ModelField({ id, label, hint, children, wide = false, badge, icon, tone = 'blue' }: { id:string; label:string; hint?:string; children:ReactNode; wide?:boolean; badge?:string; icon?:IconName; tone?:AccentTone }) {
  return <div className={`settings-field ${wide ? 'is-wide' : ''}`}>
    <div className="settings-field-head"><label htmlFor={id}>{label}</label>{badge && <Badge tone={tone} icon={icon} className="model-field-badge">{badge}</Badge>}</div>
    {children}{hint && <p className="settings-field-help">{hint}</p>}
  </div>;
}

export function ModelSettings({ changed, locked = false }: { changed?: () => void; locked?: boolean }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [config, setConfig] = useState(newModelConfig);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    let active = true;
    void modelApi.list().then(items => { if (active) { setProfiles(items); if (items[0]) select(items[0]); } })
      .catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const select = (profile: ModelProfile | null) => {
    setEditing(profile); setDisplayName(profile?.displayName ?? profile?.id ?? ''); const next = profile?.config ?? newModelConfig();
    setConfig({...next, capabilities: {...next.capabilities, toolCalls: true, vision: true}});
    setKey(''); setError(''); setConfirmDelete(false);
  };
  const field = <K extends keyof ModelConfig>(name: K, value: ModelConfig[K]) => setConfig(c => ({ ...c, [name]: value }));
  const protocol = (provider: ModelConfig['provider']) => {
    setConfig(c => ({...c, provider, remoteCompaction: false,
      completionsPath: provider === 'openAiResponses' ? 'responses' : 'chat/completions'}));
  };
  const reload = async () => {
    setBusy(true);
    try { const items = await modelApi.list(); setProfiles(items); select(items.find(p => p.id === editing?.id) ?? null); }
    catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (!displayName.trim()) throw new Error('请输入配置名称。');
      const apiKey:KeyChange = key.trim() ? {action:'set',value:key.trim()} : {action:'keep'};
      if (editing?.apiKeyConfigured && apiKey.action === 'keep' && config.baseUrl.trim().replace(/\/+$/, '') !== editing.config.baseUrl.replace(/\/+$/, ''))
        throw new Error('更换 API 地址时，请输入新密钥；无需密钥的服务请新建配置。');
      const saved = await modelApi.save(editing?.id ?? crypto.randomUUID(), editing?.revision ?? 0, config, apiKey, displayName.trim());
      select(saved); setProfiles(items => [...items.filter(p => p.id !== saved.id), saved].sort((a,b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id)));
      notify(saved.ready ? '模型配置已保存，连接将在发送消息时验证。' : '模型配置已保存；配置 API Key 后即可对话。', 'success');
      changed?.();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!editing) return;
    setBusy(true); setError('');
    try {
      await modelApi.delete(editing.id, editing.revision);
      setProfiles(items => items.filter(p => p.id !== editing.id)); select(null);
      notify('模型配置已删除，已有会话仍保留。', 'success'); changed?.();
    } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
    finally { setBusy(false); }
  };
  const disabled = busy || locked;
  return <section className="model-settings" aria-label="模型设置">
    <div className="model-workspace" inert={confirmDelete}>
      <aside className="model-profiles" aria-label="模型配置列表">
        <div className="model-profiles-heading"><strong>我的模型</strong><span>{profiles.length}</span></div>
        <button type="button" className="model-create" disabled={disabled} onClick={() => select(null)}><Icon name="plus" size={15}/>新建配置</button>
        <div className="model-profile-items">
          {busy && !profiles.length ? <div className="model-loading" role="status"><i/><i/><i/><span>正在读取配置…</span></div> : profiles.length ? profiles.map(p => <button type="button" className={`model-profile ${editing?.id === p.id ? 'selected' : ''}`} key={p.id} aria-pressed={editing?.id === p.id} disabled={disabled} onClick={() => select(p)}>
            <span className="model-profile-icon"><Icon name="bot" size={18}/></span><span className="model-profile-info"><strong>{p.displayName ?? p.id}</strong><small>{p.config.model}</small><span className={`model-profile-state ${p.ready ? 'ready' : ''}`}><i/>{p.ready ? '已配置' : '需要密钥'}</span></span><Icon name="right" size={14}/>
          </button>) : <div className="model-list-empty"><Icon name="bot" size={26}/><strong>添加第一个模型</strong><p>填写连接信息后，即可开始对话。</p></div>}
        </div>
        <p className="model-profile-note"><Icon name="key" size={14}/>密钥加密保存在本机</p>
      </aside>
      <form className="model-editor" onSubmit={e => { e.preventDefault(); if (!disabled) void save(); }}>
        <div className="model-editor-scroll">
          {error && <div className="model-feedback error" role="alert"><Icon name="alert" size={16}/><span>{error}</span><button type="button" disabled={disabled} onClick={() => void reload()}>重新加载</button></div>}
          {locked && <div className="model-feedback" role="status"><Icon name="history" size={16}/><span>请等待回复结束或停止生成后再修改模型。</span></div>}
          <fieldset disabled={disabled}>
            <div className="model-form-columns"><div className="model-form-column">
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="network" tone="blue" size={17}/><h4>模型渠道</h4><Badge tone="violet" icon="bot">模型</Badge></div>
              <div className="model-protocol-card"><div className="model-protocol-heading"><AccentIcon icon="network" tone="blue"/><div><strong>接口协议</strong><p>{config.provider === 'openAiResponses' ? '供应商须支持 Responses 与输入 token 计数。' : '使用 OpenAI 兼容 Chat Completions。'}</p></div></div><Select id="model-protocol" label="接口协议" className="settings-control" disabled={disabled} value={config.provider} options={[{value:'openAiCompatible',label:'Chat Completions · OpenAI 兼容'},{value:'openAiResponses',label:'Responses · OpenAI 兼容'}]} onChange={value => protocol(value)}/></div>
              <div className="settings-fields-grid">
                <ModelField id="model-name" label="配置名称" badge="PROFILE" icon="edit" tone="neutral"><input id="model-name" className="settings-control" value={displayName} maxLength={64} onChange={e => setDisplayName(e.target.value)} placeholder="例如：日常问答" /></ModelField>
                <ModelField id="model-id" label="模型 ID" badge="MODEL" icon="bot" tone="violet"><input id="model-id" className="settings-control settings-control-mono" value={config.model} onChange={e => field('model', e.target.value)} placeholder="供应商提供的模型 ID" /></ModelField>
                <ModelField id="model-url" label="API 基础地址" wide badge="BASE URL" icon="network" tone="cyan" hint="包含 /v1 或代理前缀，不要包含密钥。"><input id="model-url" className="settings-control settings-control-mono" value={config.baseUrl} onChange={e => field('baseUrl', e.target.value)} placeholder="https://api.example.com/v1/" /></ModelField>
              </div>
            </section>
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="key" tone="amber" size={17}/><h4>身份认证</h4><Badge tone="amber" icon="shield">敏感</Badge></div>
              <ModelField id="model-api-key" label="API Key">
                <div className="model-key-input-row">
                  <input id="model-api-key" className="settings-control settings-control-mono" type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder={editing?.apiKeyConfigured?'已配置，留空表示不修改':'未配置，请输入 API Key'}/>
                  <div className="model-key-toggle"><span>使用 API Key</span><Toggle label="此服务需要 API Key" value={config.requireApiKey} disabled={disabled} onChange={value=>field('requireApiKey',value)}/></div>
                </div>
              </ModelField>
              <p className="model-field-note">密钥加密保存，不回显原文。关闭后请求不携带密钥，已保存的密钥仍保留。</p>
            </section>
            </div><div className="model-form-column">
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="signal" tone="violet" size={17}/><h4>接口与生成</h4><Badge tone="violet" icon="settings">参数</Badge></div><div className="settings-fields-grid">
              <ModelField id="model-path" label="接口相对路径" hint="与基础地址拼接，避免重复 /v1。"><input id="model-path" className="settings-control settings-control-mono" value={config.completionsPath} onChange={e => field('completionsPath', e.target.value)} /></ModelField>
              <ModelField id="model-token-param" label="输出参数">{config.provider === 'openAiResponses' ? <input id="model-token-param" className="settings-control settings-control-mono" value="max_output_tokens" readOnly /> : <Select id="model-token-param" label="输出参数" className="settings-control" value={config.outputTokenParameter} disabled={disabled} options={[{value:'maxCompletionTokens',label:'max_completion_tokens'},{value:'maxTokens',label:'max_tokens'}]} onChange={value => field('outputTokenParameter', value)}/>}</ModelField>
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
                <ModelField id="model-temperature" label="Temperature" hint="留空或选择默认时不发送"><ModelNumberInput id="model-temperature" label="Temperature" kind="temperature" value={config.temperature} disabled={disabled} onChange={value => setConfig(current => ({ ...current, temperature: value, capabilities: { ...current.capabilities, temperature: value !== null } }))} /></ModelField>
                </div>
                {config.provider === 'openAiResponses' && <div className="model-auth-toggle settings-field is-wide"><div><strong>供应商远端整理</strong><p>仅在供应商支持 responses/compact 时开启。完整窗口加密项保存在本机；切换模型、接口或密钥后需新建会话。关闭时按容量限制对话。</p></div><Toggle label="启用 Responses 远端整理" value={!!config.remoteCompaction} disabled={disabled} onChange={value => field('remoteCompaction', value)}/></div>}
              </div>
            </section>
            </div></div>
          </fieldset>
        </div>
        <footer className="model-editor-footer">
            {editing && <button type="button" className="model-delete-button" disabled={disabled} onClick={() => { setError(''); setConfirmDelete(true); }}><Icon name="trash" size={15}/>删除</button>}
            <span className="model-save-hint">保存后用于后续对话</span><button className="model-save-button" type="submit" disabled={disabled}><Icon name={busy ? 'refresh' : 'check'} size={16}/>{busy ? '处理中…' : '保存配置'}</button>
        </footer>
      </form>
    </div>
    {confirmDelete && editing && createPortal(<Modal title="删除模型配置？" className="model-delete-dialog" dismissDisabled={busy} onClose={() => { if (!busy) setConfirmDelete(false); }}>
      <strong>{editing.displayName ?? editing.id}</strong><p>此模型配置将被删除，已有历史会话会保留。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" data-autofocus className="outlined-button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button><button type="button" className="danger-button" disabled={disabled} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button></footer>
    </Modal>, document.body)}
  </section>;
}
